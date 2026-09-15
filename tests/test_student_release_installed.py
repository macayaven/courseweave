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
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR', 'UV_CACHE_DIR') if key in os.environ}

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
    # Exercise either supported runtime case with the same installed launcher.
    notebooks = list((home / 'course').rglob('*.ipynb'))
    authored_file = notebooks[0] if notebooks else next((home / 'course').glob('*.md'))
    original = authored_file.read_bytes()
    authored_file.write_bytes(original + b'\n')
    kernel = next(home.glob('runtimes/*/kernel/bin/python'))
    imports = os.environ.get('COURSEWEAVE_EXPECTED_KERNEL_IMPORTS', '').split(',')
    code = 'import importlib, importlib.util, json, sys; assert importlib.util.find_spec("courseweave") is None; [importlib.import_module(name) for name in json.loads(sys.argv[1]) if name]'
    probe = subprocess.run([str(kernel), '-I', '-c', code, json.dumps(imports)], env=environment, capture_output=True, text=True, timeout=30)
    assert probe.returncode == 0, probe.stdout + probe.stderr
    ready = next(home.glob('runtimes/*/ready.json'))
    before = ready.stat().st_mtime_ns
    repeated = run('setup')
    assert repeated.returncode == 0, repeated.stdout + repeated.stderr
    assert authored_file.read_bytes() == original + b'\n'
    assert ready.stat().st_mtime_ns == before
    assert not (home / 'state').exists()


def test_release_metadata_selects_a_fresh_versioned_default_home(tmp_path):
    release = Path(RELEASE).absolute()
    metadata = json.loads((release / 'release.json').read_text())
    environment = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG', 'TMPDIR') if key in os.environ}
    # Keep the account's HOME intact. This read-only default-path probe patches
    # Path.home in the actual bundled module; the first test uses Start.command.
    code = '''import pathlib, runpy, sys
release = pathlib.Path(sys.argv[1])
base = pathlib.Path(sys.argv[2])
pathlib.Path.home = classmethod(lambda cls: base)
module = runpy.run_path(str(release / 'student_pilot.py'), run_name='release_probe')
raise SystemExit(module['main'](['check', '--no-provider'], root=release))
'''
    result = subprocess.run(
        [sys.executable, '-I', '-c', code, str(release), str(tmp_path)],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    name = f'{metadata["course_id"].lower()}-v{metadata["course_version"]}-{metadata["files"]["course"]["sha256"][:16]}'
    expected = tmp_path / ('Library/Application Support/CourseWeave' if sys.platform == 'darwin' else '.local/share/courseweave') / name
    assert result.returncode == 2, result.stdout + result.stderr
    assert str(expected) in result.stdout
    assert not expected.exists()
