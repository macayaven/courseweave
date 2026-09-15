"""Fresh actual Start Author.command setup and repeat recovery; opt-in artifact."""
import json
import os
from pathlib import Path
import subprocess

import pytest

RELEASE = os.environ.get('COURSEWEAVE_AUTHOR_RELEASE')
pytestmark = pytest.mark.skipif(not RELEASE, reason='Requires an explicitly selected extracted Author archive')


def test_fresh_author_launcher_and_interrupted_setup_preserve_projects(tmp_path):
    release = Path(RELEASE).absolute()
    home = tmp_path / 'Fresh Author with spaces'
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR', 'UV_CACHE_DIR') if key in os.environ}
    environment.update(OPENAI_API_KEY='synthetic-unselected-model-key', BRAVE_SEARCH_API_KEY='synthetic-unselected-search-key')
    def run(command):
        result = subprocess.run([str(release / 'Start Author.command'), command, '--home', str(home)],
            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=300)
        assert 'synthetic-unselected' not in result.stdout + result.stderr
        return result
    assert run('check').returncode == 2
    assert not home.exists()
    setup = run('setup')
    assert setup.returncode == 0, setup.stdout + setup.stderr
    assert run('check').returncode == 0
    platform = next(home.glob('runtimes/*/platform/bin/python'))
    kernel = next(home.glob('runtimes/*/kernel/bin/python'))
    project = home / 'workspace/projects/practice'
    project.parent.mkdir(parents=True)
    code = 'from courseweave.author.project import create_project; from pathlib import Path; import sys; create_project(None, Path(sys.argv[1]), ())'
    created = subprocess.run([str(platform), '-I', '-c', code, str(project)], env=environment,
        capture_output=True, text=True, timeout=30)
    assert created.returncode == 0, created.stderr
    note = project / 'course/lesson.md'; note.write_text('Saved author work must survive setup recovery.\n')
    before = {str(p.relative_to(project)): p.read_bytes() for p in project.rglob('*') if p.is_file()}
    ready = next(home.glob('runtimes/*/ready.json'))
    ready.write_text('{interrupted')
    assert run('check').returncode == 2
    retried = run('setup')
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert run('check').returncode == 0
    assert {str(p.relative_to(project)): p.read_bytes() for p in project.rglob('*') if p.is_file()} == before
    probe = subprocess.run([str(kernel), '-I', '-c', 'import ipykernel, importlib.util; assert importlib.util.find_spec("courseweave") is None'],
        env=environment, capture_output=True, text=True, timeout=30)
    assert probe.returncode == 0, probe.stderr
    assert json.loads(ready.read_text())['wheel_sha256'] == json.loads((release / 'release.json').read_text())['files']['wheel']['sha256']
