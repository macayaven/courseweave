"""Run explicitly after packaging: the actual student entry point, not a stub."""
import os
from pathlib import Path
import json
import subprocess
import sys

import pytest

RELEASE = os.environ.get('COURSEWEAVE_STUDENT_RELEASE')
pytestmark = pytest.mark.skipif(not RELEASE, reason='Requires an explicitly selected packaged student release')


def test_fresh_start_with_spaces_and_repeat_setup_preserves_saved_work(tmp_path):
    release = Path(RELEASE).absolute()
    home = tmp_path / 'My study with spaces'
    command = [str(release / 'Start Course.command')]
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR') if key in os.environ}

    def run(*args):
        return subprocess.run(command + list(args) + ['--home', str(home)], cwd=tmp_path,
                              env=environment, capture_output=True, text=True, timeout=300)

    fresh_check = run('check', '--no-provider')
    assert fresh_check.returncode == 2
    assert not home.exists()
    setup = run('setup')
    assert setup.returncode == 0, setup.stdout + setup.stderr
    assert (home / 'course/courseweave.json').is_file()
    assert not (home / 'state').exists()
    check = run('check', '--no-provider')
    assert check.returncode == 0, check.stdout + check.stderr
    assert 'Assistant: off' in check.stdout
    notebook = next((home / 'course/notebooks').glob('*.ipynb'))
    original = notebook.read_bytes()
    notebook.write_bytes(original + b'\n')
    ready = next(home.glob('runtimes/*/ready.json'))
    before = ready.stat().st_mtime_ns
    repeated = run('setup')
    assert repeated.returncode == 0, repeated.stdout + repeated.stderr
    assert notebook.read_bytes() == original + b'\n'
    assert ready.stat().st_mtime_ns == before
    assert not (home / 'state').exists()


def test_release_metadata_selects_a_fresh_versioned_default_home(tmp_path):
    release = Path(RELEASE).absolute()
    metadata = json.loads((release / 'release.json').read_text())
    environment = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR') if key in os.environ}
    environment['HOME'] = str(tmp_path)
    environment['XDG_DATA_HOME'] = str(tmp_path / 'xdg data')
    result = subprocess.run(
        [str(release / 'Start Course.command'), 'check', '--no-provider'],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if sys.platform == 'darwin':
        expected = tmp_path / f'Library/Application Support/CourseWeave/Agent Harness Path v{metadata["course_version"]}'
    else:
        expected = tmp_path / f'xdg data/courseweave/agent-harness-path-v{metadata["course_version"]}'
    assert result.returncode == 2, result.stdout + result.stderr
    assert str(expected) in result.stdout
    assert not expected.exists()
