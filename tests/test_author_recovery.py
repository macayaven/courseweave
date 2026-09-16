"""Restart with real filesystem state; fault workers deliberately exit mid-operation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import signal
import time

import pytest

from courseweave.author import content, delivery
from courseweave.author.contracts import MarkdownDraft
from courseweave.author.project import ProjectError, open_project
from test_author_content import project, context_for, InterruptedApply
from test_author_delivery import delivery_project, export_request


def worker(script, *args):
    result = subprocess.run([sys.executable, '-c', script, *map(str, args)],
        env=dict(os.environ, PYTHONPATH=str(Path('src').resolve())),
        capture_output=True, timeout=30)
    assert result.returncode == 73, result.stderr.decode()


@pytest.mark.parametrize('phase,expected', [('after_prepare', 'pending'), ('after_replace', 'applied'),
    ('before_receipt', 'applied'), ('external', 'conflict')])
def test_apply_process_death_reopens_exact_bytes_once(project, tmp_path, phase, expected):
    original = (tmp_path/'source/lesson.md').read_bytes()
    student = (tmp_path/'student/lab.ipynb').read_bytes()
    context = context_for(project)
    change = content.stage_change(project, context, MarkdownDraft(kind='markdown_replace', text='Reviewed candidate\n'))
    worker('''
import os,sys
from pathlib import Path
from courseweave.author.project import open_project
from courseweave.author.content import apply_change
p = open_project(Path(sys.argv[1]))
def crash(phase):
    if phase == sys.argv[4]: os._exit(73)
apply_change(p, sys.argv[2], 0, 'restart-operation', context_digest=sys.argv[3], crash_hook=crash)
''', project.course_root.parent, change.change_id, context.digest, 'after_replace' if phase == 'external' else phase)
    if phase == 'external':
        (project.course_root/'lesson.md').write_text('New external work\n')
    reopened = open_project(project.course_root.parent)
    content.recover_changes(reopened)
    assert content.read_change(reopened, change.change_id).status == expected
    assert (project.course_root/'lesson.md').read_bytes() == (
        b'New external work\n' if phase == 'external' else original if expected == 'pending' else b'Reviewed candidate\n')
    if expected == 'applied':
        first = content.apply_change(reopened, change.change_id, 0, 'restart-operation', context_digest=context.digest)
        assert content.apply_change(reopened, change.change_id, 0, 'restart-operation', context_digest=context.digest) == first
        assert open_project(project.course_root.parent).revision == 1
    assert (tmp_path/'source/lesson.md').read_bytes() == original
    assert (tmp_path/'student/lab.ipynb').read_bytes() == student


@pytest.mark.parametrize('corruption', ['reviewed_revision', 'context_digest', 'rejected'])
def test_recovery_rejects_mismatched_journal_or_terminal_change(project, corruption):
    context = context_for(project)
    change = content.stage_change(project, context, MarkdownDraft(kind='markdown_replace', text='Candidate\n'))
    def crash(phase):
        if phase == 'after_replace': raise InterruptedApply()
    with pytest.raises(InterruptedApply):
        content.apply_change(project, change.change_id, 0, 'corrupt-pair', context_digest=context.digest, crash_hook=crash)
    journal = project.state_root/'operations/corrupt-pair.json'
    data = json.loads(journal.read_bytes())
    if corruption == 'rejected':
        (project.state_root/'changes'/change.change_id/'status.json').write_text('{"status":"rejected"}')
    else:
        data[corruption] = 2 if corruption == 'reviewed_revision' else 'f'*64
        journal.write_text(json.dumps(data))
    with pytest.raises(ProjectError, match='journal|reconcile|review'):
        content.recover_changes(open_project(project.course_root.parent))
    assert (project.course_root/'lesson.md').read_bytes() == b'Candidate\n'
    assert json.loads(journal.read_bytes())['receipt'] is None
    assert open_project(project.course_root.parent).revision == 0


@pytest.mark.parametrize('point', ['before_archive', 'after_archive'])
def test_export_process_death_is_reconciled_or_explicitly_cleaned(delivery_project, tmp_path, point):
    p = delivery_project
    source = {str(f.relative_to(p.course_root)): f.read_bytes() for f in p.course_root.rglob('*') if f.is_file()}
    unrelated = tmp_path/'separate-study';unrelated.mkdir();(unrelated/'saved.ipynb').write_bytes(b'planted-study-secret')
    destination = tmp_path/'handoff.tar'
    worker('''
import os,sys
from pathlib import Path
from courseweave.author import delivery
from courseweave.author.project import open_project
from courseweave.author.quality import student_profile
p = open_project(Path(sys.argv[1]))
plan = delivery.inspect_delivery(p, student_profile())
request = delivery.ExportRequest(project_revision=plan['project_revision'], inventory_sha256=plan['inventory_sha256'],
    source_decisions_sha256=plan['source_decisions_sha256'], course_version='1.0.0', kind='student_handoff',
    selected_paths=tuple(f['path'] for f in plan['files'] if f['selected']))
write,copy = delivery.atomic_bytes,delivery._copy_selected
def fault_write(path,*args,**kwargs):
    if path.parent.name == 'exports': os._exit(73)
    return write(path,*args,**kwargs)
def fault_copy(*args,**kwargs): os._exit(73)
if sys.argv[3] == 'after_archive': delivery.atomic_bytes = fault_write
else: delivery._copy_selected = fault_copy
delivery.export_course(p, Path(sys.argv[2]), student_profile(), request)
''', p.course_root.parent, destination, point)
    reopened = open_project(p.course_root.parent)
    results = delivery.list_exports(reopened)
    if point == 'after_archive':
        assert len(results['exports']) == 1
        assert results['exports'][0]['package_sha256'] == hashlib.sha256(destination.read_bytes()).hexdigest()
        assert delivery.list_exports(reopened)['exports'] == results['exports']
    else:
        assert results['exports'] == [] and not destination.exists()
        attempts = delivery.recovery_status(reopened)['exports']
        assert len(attempts) == 1 and attempts[0]['status'] == 'interrupted'
        staging = Path(attempts[0]['staging'])
        assert staging.is_dir()
        delivery.discard_interrupted_export(reopened, attempts[0]['export_id'])
        assert not staging.exists()
    assert all(f.read_bytes() == source[str(f.relative_to(p.course_root))] for f in p.course_root.rglob('*') if f.is_file())
    assert (unrelated/'saved.ipynb').read_bytes() == b'planted-study-secret'


def test_process_death_during_fetch_leaves_no_partial_source_or_success_report(project, tmp_path):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    from courseweave.author.project import read_sources
    records=read_sources(project)
    original=(tmp_path/'source/lesson.md').read_bytes()
    notebook=(tmp_path/'student/lab.ipynb').read_bytes()
    worker('''
import os,sys
from pathlib import Path
from courseweave.author.project import open_project
from courseweave.author.sources import run_research
class InterruptedFetch:
    def fetch(self,url,policy):
        # A synthetic transport stops inside the real research pipeline.
        # No public network or provider result is claimed by this fault test.
        os._exit(73)
run_research(open_project(Path(sys.argv[1])), {'network_enabled':True,'policy':{'mode':'public_web'},
    'urls':['https://docs.example.org/selected']}, fetcher=InterruptedFetch())
''',project.course_root.parent)
    reopened=open_project(project.course_root.parent)
    assert read_sources(reopened) == records
    with TestClient(create_app(reopened.course_root,author_project=reopened,
            state_dir=reopened.state_root/'transactions',capability_token='restart-fetch')) as client:
        response=client.get('/api/author/research/reports',headers={'Authorization':'Bearer restart-fetch'})
        assert response.status_code == 200
        assert response.json()['reports'] == []
    assert (tmp_path/'source/lesson.md').read_bytes() == original
    assert (tmp_path/'student/lab.ipynb').read_bytes() == notebook


def test_reopened_preview_uses_recorded_start_identity_and_preserves_unrelated_process(delivery_project, tmp_path):
    from courseweave.author.preview import PreviewManager, PreviewRecord
    from courseweave.author import preview
    from datetime import datetime, timezone
    p = delivery_project
    preview_id = 'preview-' + 'a'*32
    root = tmp_path/'previews';directory = root/preview_id;directory.mkdir(parents=True)
    (directory/'owner.json').write_text(json.dumps({'format':1,'project_id':p.project_id,'preview_id':preview_id}))
    # Actual own process group; no Student rules are exercised in this identity test.
    child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)', 'student_preview.py', preview_id],
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    witness = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
    try:
        stamp = preview.process_stamp(child.pid, preview_id)
        assert stamp is not None
        record = PreviewRecord(preview_id=preview_id, project_id=p.project_id, export_id='export-fixture',
            package_sha256='a'*64, student_version='0.3.0', home=str(directory/'study'),
            created_at=datetime.now(timezone.utc), status='running', process_id=child.pid, process_started=stamp)
        manager = PreviewManager(root)
        manager._write(p, record)
        recovered = manager.list(open_project(p.course_root.parent))['previews'][0]
        assert recovered['status'] == 'failed' and 'interrupted' in recovered['error'].lower()
        # A wrong start identity must never authorize a signal, even with the right PID.
        manager._update(p, preview_id, process_started='different process start')
        with pytest.raises(ProjectError, match='identity|verify'):
            manager.stop(p, preview_id)
        assert child.poll() is None and witness.poll() is None
        manager._update(p, preview_id, process_started=stamp)
        stopped = manager.stop(p, preview_id)
        assert child.wait(timeout=5) == -signal.SIGTERM
        assert stopped['status'] == 'stopped' and witness.poll() is None
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=5);witness.terminate();witness.wait(timeout=5)


def test_discard_crash_after_deletion_reconciles_without_touching_other_files(delivery_project, tmp_path, monkeypatch):
    from courseweave.author.preview import PreviewManager, PreviewRecord
    from datetime import datetime, timezone
    p=delivery_project;manager=PreviewManager(tmp_path/'previews');preview_id='preview-'+'b'*32
    directory=manager._directory(preview_id);directory.mkdir(parents=True)
    (directory/'owner.json').write_text(json.dumps({'format':1,'project_id':p.project_id,'preview_id':preview_id}))
    (directory/'study.ipynb').write_bytes(b'Only owned preview data')
    record=PreviewRecord(preview_id=preview_id,project_id=p.project_id,export_id='export-fixture',package_sha256='b'*64,
        student_version='0.3.0',home=str(directory/'study'),created_at=datetime.now(timezone.utc),status='stopped')
    manager._write(p,record)
    write=manager._write
    def interrupted_write(project, value, **kwargs):
        if value.files == 'discarded': raise InterruptedApply()
        return write(project,value,**kwargs)
    monkeypatch.setattr(manager,'_write',interrupted_write)
    with pytest.raises(InterruptedApply): manager.discard(p,preview_id,0)
    assert not directory.exists()
    reopened=PreviewManager(tmp_path/'previews')
    assert reopened.list(open_project(p.course_root.parent))['previews'][0]['files'] == 'discarded'


def test_author_process_crash_releases_real_jupyter_and_course_lock(tmp_path):
    """Actual LaunchSupervisor/Jupyter startup and SIGKILL, with a separate witness."""
    from courseweave.launch import CourseLock, CourseLockError
    course=tmp_path/'author-course';course.mkdir()
    runtime=tmp_path/'owned-runtime';runtime.mkdir(mode=0o700)
    marker=tmp_path/'ready.json'
    script='''
import json,os,sys
from pathlib import Path
from courseweave.launch import LaunchSupervisor
def ready(url):
    path=Path(sys.argv[2])
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump({'jupyter_pid':supervisor._jupyter_process.pid,'runtime':supervisor._temporary_directory.name},stream)
    return True
supervisor=LaunchSupervisor(Path(sys.argv[1]),port=0,mode='author',browser_opener=ready,readiness_timeout=30)
raise SystemExit(supervisor.run())
'''
    # The supervisor prefers XDG_RUNTIME_DIR over TMPDIR for its course lock.
    # Both processes must address the same owned lock directory on Linux too.
    owner=subprocess.Popen([sys.executable,'-c',script,str(course),str(marker)],start_new_session=True,
        env=dict(os.environ,TMPDIR=str(runtime),XDG_RUNTIME_DIR=str(runtime)),
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    witness=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'])
    child=None
    def alive(pid):
        result=subprocess.run(['/bin/ps','-p',str(pid),'-o','stat='],capture_output=True,text=True,timeout=5)
        return bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')
    try:
        deadline=time.monotonic()+35
        while not marker.exists() and owner.poll() is None and time.monotonic()<deadline: time.sleep(.1)
        assert marker.exists(), 'Owned Author did not reach Jupyter readiness.'
        child=json.loads(marker.read_bytes())['jupyter_pid']
        assert os.getpgid(child) == owner.pid
        with pytest.raises(CourseLockError): CourseLock(course,runtime_root=runtime).acquire()
        owner.kill();owner.wait(timeout=5)
        deadline=time.monotonic()+8
        while alive(child) and time.monotonic()<deadline: time.sleep(.1)
        assert not alive(child), 'Jupyter outlived the killed Author and retained the course lock.'
        lock=CourseLock(course,runtime_root=runtime).acquire();lock.release()
        assert witness.poll() is None
    finally:
        if owner.poll() is None: owner.terminate()
        try: owner.wait(timeout=15)
        except subprocess.TimeoutExpired: owner.kill();owner.wait(timeout=5)
        if child is not None and alive(child) and os.getpgid(child) == owner.pid:
            os.kill(child,signal.SIGTERM)
            deadline=time.monotonic()+10
            while alive(child) and time.monotonic()<deadline: time.sleep(.1)
            if alive(child) and os.getpgid(child) == owner.pid: os.kill(child,signal.SIGKILL)
        witness.terminate();witness.wait(timeout=5)
