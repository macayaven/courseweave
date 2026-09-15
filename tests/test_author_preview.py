"""Preview ownership and consent contracts; real installed practice is separate."""
import json
import os
from pathlib import Path
import socket
import threading
import time
import signal
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from courseweave.api import create_app
from courseweave.author.delivery import export_course
from courseweave.author.project import ProjectError
from courseweave.author.quality import student_profile
from courseweave.providers import ProviderConfig
from test_author_delivery import delivery_project, export_request
from test_author_student_bundle import runtime_catalog


class Process:
    """Contract-only process, sharing the actual private readiness socket."""
    def __init__(self, argv, **kwargs):
        self.pid = 34567
        self.returncode = None
        self.argv, self.kwargs = argv, kwargs | {'env': dict(kwargs['env'])}
        self.peer = socket.socket(fileno=os.dup(kwargs['pass_fds'][0]))
        self.ready = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        self.peer.sendall(json.dumps({'url': 'http://127.0.0.1:34568/courseweave/lab?token=private-preview-bootstrap',
            'student_version': '0.2.0', 'api_port': 34569}).encode() + b'\n')
        self.ready.set()
        self.peer.recv(1)
        self.returncode = 0
        self.peer.close()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        deadline = time.monotonic() + (timeout or 3)
        while self.returncode is None and time.monotonic() < deadline:
            time.sleep(.01)
        if self.returncode is None:
            raise TimeoutError()
        return self.returncode


@pytest.fixture
def preview(delivery_project, runtime_catalog, tmp_path):
    from courseweave.author.preview import PreviewManager
    project = delivery_project
    export = export_course(project, tmp_path / 'reviewed.tar', student_profile(), export_request(project))
    opened = []
    manager = PreviewManager(tmp_path / 'previews', process_factory=Process,
        browser_opener=lambda url: opened.append(url) or True)
    yield manager, project, export, runtime_catalog, opened
    manager.close()


def settled(manager, project, preview_id, status='running'):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        record = manager.read(project, preview_id)
        if record['status'] == status:
            return record
        time.sleep(.01)
    raise AssertionError(record)


def test_explicit_preview_uses_saved_snapshot_fresh_home_and_private_channel(preview, monkeypatch):
    manager, project, export, catalog, opened = preview
    for key in ['OPENAI_API_KEY', 'BRAVE_SEARCH_API_KEY', 'COURSEWEAVE_CAPABILITY_TOKEN']:
        monkeypatch.setenv(key, 'planted-'+key)
    before = (project.course_root / 'lessons/unit.md').read_bytes()
    first = manager.start(project, export.export_id, catalog, '0.2.0')
    current = settled(manager, project, first['preview_id'])
    process = manager.active.process
    assert process.kwargs['start_new_session'] and process.kwargs['pass_fds']
    assert all(key not in process.kwargs['env'] for key in ['OPENAI_API_KEY', 'BRAVE_SEARCH_API_KEY', 'COURSEWEAVE_CAPABILITY_TOKEN'])
    assert current['package_sha256'] == export.package_sha256
    assert not Path(current['home']).is_relative_to(project.course_root.parent)
    assert current['provider_mode'] == 'off' and current['observations'] is None
    assert current['process_id'] == process.pid
    assert not opened  # readiness is not permission to open/run notebooks
    manager.open(project, current['preview_id'])
    assert len(opened) == 1 and 'private-preview-bootstrap' in opened[0]
    raw = (project.state_root / 'previews' / (current['preview_id']+'.json')).read_text()
    assert 'private-preview-bootstrap' not in raw and 'planted-' not in raw
    with pytest.raises(ProjectError, match='active'):
        manager.start(project, export.export_id, catalog, '0.2.0')
    manager.stop(project, current['preview_id'])
    stopped = settled(manager, project, current['preview_id'], 'stopped')
    assert stopped['files'] == 'retained'
    assert (project.course_root / 'lessons/unit.md').read_bytes() == before
    second = manager.start(project, export.export_id, catalog, '0.2.0')
    assert second['home'] != current['home'] and second['preview_id'] != current['preview_id']


def test_provider_opt_in_passes_only_selected_configuration(preview, monkeypatch):
    manager, project, export, catalog, _ = preview
    monkeypatch.setenv('BRAVE_SEARCH_API_KEY', 'search-secret')
    config = ProviderConfig(provider='openai', model='fixture', api_key='model-secret', base_url='https://model.example/v1', profile='text-only-v1')
    started = manager.start(project, export.export_id, catalog, '0.2.0', provider=config)
    settled(manager, project, started['preview_id'])
    env = manager.active.process.kwargs['env']
    assert env['OPENAI_API_KEY'] == 'model-secret' and env['COURSEWEAVE_PROVIDER_PROFILE'] == 'text-only-v1'
    assert 'BRAVE_SEARCH_API_KEY' not in env and 'COURSEWEAVE_CAPABILITY_TOKEN' not in env
    assert started['provider_mode'] == 'configured'
    assert 'model-secret' not in json.dumps(manager.read(project, started['preview_id']))


def test_observations_are_explicit_revision_checked_and_discard_only_owned_files(preview, tmp_path):
    manager, project, export, catalog, _ = preview
    record = manager.start(project, export.export_id, catalog, '0.2.0')
    record = settled(manager, project, record['preview_id'])
    with pytest.raises(ProjectError):
        manager.discard(project, record['preview_id'], record['revision'])
    manager.stop(project, record['preview_id'])
    record = settled(manager, project, record['preview_id'], 'stopped')
    home = Path(record['home']);home.mkdir(parents=True, exist_ok=True)
    (home / 'saved.ipynb').write_text('owned preview notebook')
    unrelated = tmp_path/'real-study';unrelated.mkdir();(unrelated/'saved.ipynb').write_text('preserve')
    updated = manager.observe(project, record['preview_id'], record['revision'],
        {'surfaces': ['markdown', 'notebook'], 'actions': ['notebook_run', 'prediction', 'native_checks'], 'notes': 'Direct UI actions in a test copy; not a learning claim.'})
    assert updated['observations']['category'] == 'author_reported'
    with pytest.raises(ProjectError):
        manager.observe(project, record['preview_id'], record['revision'], {'surfaces': [], 'actions': [], 'notes': 'stale'})
    discarded = manager.discard(project, record['preview_id'], updated['revision'])
    assert discarded['files'] == 'discarded' and not home.exists()
    assert (unrelated/'saved.ipynb').read_text() == 'preserve'


def test_invalid_or_draft_exports_cannot_start(preview, tmp_path):
    manager, project, export, catalog, _ = preview
    draft = export_course(project, tmp_path/'draft.tar', student_profile(), export_request(project, kind='draft'))
    with pytest.raises(ProjectError):
        manager.start(project, draft.export_id, catalog, '0.2.0')
    assert manager.active is None
    with pytest.raises(ProjectError):
        manager.start(project, export.export_id, None, '0.2.0')


def test_private_preview_api_has_explicit_start_open_stop_and_observations(preview):
    manager, project, export, catalog, opened = preview
    app = create_app(project.course_root, author_project=project, author_student_inputs=catalog,
        state_dir=project.state_root/'transactions', capability_token='author-test')
    app.state.author_previews = manager
    with TestClient(app, headers={'Authorization':'Bearer author-test'}) as client:
        assert client.post('/api/author/previews', json={'export_id':export.export_id,'student_version':'0.2.0','home':'/unreviewed'}).status_code == 422
        response = client.post('/api/author/previews', json={'export_id':export.export_id,'student_version':'0.2.0'})
        assert response.status_code == 202, response.text
        record=settled(manager,project,response.json()['preview_id'])
        assert client.get('/api/author/previews').json()['previews'][0]['preview_id']==record['preview_id']
        assert client.post('/api/author/previews/'+record['preview_id']+'/open').status_code==200
        assert len(opened)==1
        assert client.post('/api/author/previews/'+record['preview_id']+'/stop').status_code==200
    assert manager.active is None


def test_observations_follow_the_shared_surface_types():
    from courseweave.author.preview import PreviewObservations
    assert len(PreviewObservations(surfaces=['html','markdown','source','notebook','video','terminal','external'],actions=[],notes='').surfaces)==7
    with pytest.raises(ValueError):
        PreviewObservations(surfaces=['web_link'],actions=[],notes='')


def test_supported_unicode_observation_can_be_reopened(preview):
    manager,project,export,catalog,_=preview
    record=manager.start(project,export.export_id,catalog,'0.2.0')
    settled(manager,project,record['preview_id'])
    record=manager.stop(project,record['preview_id'])
    manager.observe(project,record['preview_id'],record['revision'],{'surfaces':[],'actions':[],'notes':'🔎'*8000})
    assert manager.read(project,record['preview_id'])['observations']['notes']=='🔎'*8000


def test_invalid_readiness_never_opens_or_persists_a_supplied_url(preview):
    manager,project,export,catalog,opened=preview
    class InvalidProcess(Process):
        def run(self):
            self.peer.sendall(b'{"url":"https://untrusted.example/?token=never-persist-this"}\n')
            self.peer.recv(1);self.returncode=1;self.peer.close()
    manager.process_factory=InvalidProcess
    record=manager.start(project,export.export_id,catalog,'0.2.0')
    failed=settled(manager,project,record['preview_id'],'failed')
    manager.stop(project,record['preview_id'])
    assert not opened and 'never-persist-this' not in json.dumps(failed)
    assert 'untrusted.example' not in json.dumps(manager.list(project))


def test_losing_parent_channel_stops_only_the_real_owned_setup_group(tmp_path):
    """Actual wrapper/process supervision; fixture setup performs no installation."""
    from courseweave import student_preview
    bundle=tmp_path/'bundle';bundle.mkdir()
    marker=tmp_path/'child-pid'
    (bundle/'student_pilot.py').write_text('''import subprocess,sys,time
from pathlib import Path
def main(args,root):
 child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])
 Path(root).parent.joinpath('child-pid').write_text(str(child.pid))
 time.sleep(60)
''')
    parent,child=socket.socketpair()
    witness=subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(60)'])
    process=subprocess.Popen([sys.executable,'-I',student_preview.__file__,str(bundle),str(tmp_path/'study'),str(child.fileno()),'preview-fixture'],
        pass_fds=(child.fileno(),),start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    child.close()
    try:
        deadline=time.monotonic()+5
        while not marker.exists() and time.monotonic()<deadline:time.sleep(.02)
        assert marker.exists()
        descendant=int(marker.read_text())
        parent.close()
        assert process.wait(timeout=5)==-signal.SIGTERM
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            status=subprocess.run(['ps','-p',str(descendant),'-o','stat='],capture_output=True,text=True).stdout.strip()
            if not status or status.startswith('Z'):break
            time.sleep(.02)
        assert not status or status.startswith('Z')
        assert witness.poll() is None
    finally:
        parent.close()
        if process.poll() is None:os.killpg(process.pid,signal.SIGKILL)
        process.wait(timeout=5)
        witness.terminate();witness.wait(timeout=5)
