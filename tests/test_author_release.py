"""Portable Author bundle boundaries; installed acceptance uses the real archive."""
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest


@pytest.fixture
def release_inputs(tmp_path):
    inputs = {}
    for kind, version in [('wheel', '0.3.0'), ('student_wheel', '0.2.0')]:
        path = tmp_path / f'courseweave-{version}-py3-none-any.whl'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr(f'courseweave-{version}.dist-info/METADATA',
                            f'Metadata-Version: 2.1\nName: courseweave\nVersion: {version}\n')
        inputs[kind] = path
    inputs['constraints'] = tmp_path / 'requirements.txt'
    inputs['constraints'].write_text('ipykernel==7.3.0\njupyterlab==4.6.3\n')
    inputs['source'] = tmp_path / 'courseweave-0.3.0.tar.gz'
    with tarfile.open(inputs['source'], 'w:gz') as archive:
        data = b'Metadata-Version: 2.1\nName: courseweave\nVersion: 0.3.0\n'
        member = tarfile.TarInfo('courseweave-0.3.0/PKG-INFO'); member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    return {kind: (path, hashlib.sha256(path.read_bytes()).hexdigest()) for kind, path in inputs.items()}


def test_built_author_bundle_checks_itself_outside_source_checkout(release_inputs, tmp_path):
    from courseweave.author_bundle import build_bundle, pack_bundle
    destination = tmp_path / 'Author with spaces'
    release = build_bundle(release_inputs, destination, platform_commit='a' * 40)
    archive = tmp_path / 'author.tar.gz'
    pack_bundle(destination, archive)
    with tarfile.open(archive) as package:
        assert any(m.name.endswith('/Start Author.command') and m.mode & 0o111 for m in package)
    assert release['application_version'] == '0.3.0'
    catalog = json.loads((destination / 'student-inputs.json').read_text())
    assert set(catalog['runtimes']) == {'0.2.0', '0.3.0'}
    result = subprocess.run([sys.executable, '-I', str(destination / 'author_launcher.py'), 'check',
                             '--home', str(tmp_path / 'new home')], cwd=tmp_path,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 2, result.stderr
    assert 'Release files: verified' in result.stdout
    assert not (tmp_path / 'new home').exists()
    (destination / 'requirements.txt').write_text('damaged')
    result = subprocess.run([sys.executable, '-I', str(destination / 'author_launcher.py'), 'setup',
                             '--home', str(tmp_path / 'new home')], cwd=tmp_path,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 1 and 'damaged' in result.stderr.lower()
    assert not (tmp_path / 'new home').exists()


@pytest.mark.parametrize('invalid', ['hash', 'version', 'existing', 'symlink'])
def test_author_builder_rejects_bad_inputs_and_preserves_destinations(release_inputs, tmp_path, invalid):
    from courseweave.author_bundle import build_bundle
    destination = tmp_path / 'Author'
    if invalid == 'hash':
        release_inputs['wheel'] = (release_inputs['wheel'][0], '0' * 64)
    elif invalid == 'version':
        release_inputs['wheel'] = release_inputs['student_wheel']
    elif invalid == 'existing':
        destination.mkdir(); (destination / 'owned.txt').write_text('preserve')
    else:
        target = tmp_path / 'target'; target.mkdir(); destination.symlink_to(target)
    with pytest.raises((ValueError, OSError)):
        build_bundle(release_inputs, destination, platform_commit='a' * 40)
    if invalid == 'existing':
        assert (destination / 'owned.txt').read_text() == 'preserve'
    else:
        assert not (destination / 'release.json').exists()


def test_author_launch_requires_explicit_provider_and_search_opt_in(release_inputs, tmp_path, monkeypatch):
    from courseweave import author_launcher as launcher
    from courseweave.author_bundle import build_bundle
    root = tmp_path / 'release'; build_bundle(release_inputs, root, platform_commit='a' * 40)
    monkeypatch.setenv('OPENAI_API_KEY', 'test-private-model-key')
    monkeypatch.setenv('OPENAI_MODEL', 'test-model')
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', 'openai')
    monkeypatch.setenv('BRAVE_SEARCH_API_KEY', 'test-private-search-key')
    monkeypatch.setenv('UNRELATED_SECRET', 'not-passed')
    # Installation and exec are the external boundaries; home ownership is real.
    monkeypatch.setattr(launcher, 'ensure_runtime', lambda root, data, home, uv: (Path('/installed/python'), Path('/isolated/python')))
    monkeypatch.setattr(launcher.shutil, 'which', lambda name: '/test/uv')
    executions = []
    monkeypatch.setattr(launcher.os, 'execve', lambda path, command, environment: executions.append((command, environment)))
    for args in [[], ['--provider-env', '--search-key-env']]:
        assert launcher.main(['start', '--home', str(tmp_path / 'author-home'), *args], root=root) == 0
    off, on = executions
    assert not any('KEY' in key or 'SECRET' in key for key in off[1])
    assert on[1]['OPENAI_API_KEY'] == 'test-private-model-key'
    assert on[1]['BRAVE_SEARCH_API_KEY'] == 'test-private-search-key'
    assert 'UNRELATED_SECRET' not in on[1]
    assert '--student-inputs' in off[0] and '--kernel-python' in off[0]
    assert 'author' in off[0] and '--home' in off[0]
    for path in (tmp_path / 'author-home').rglob('*'):
        if path.is_file():
            assert b'test-private' not in path.read_bytes()


def test_author_setup_refuses_unowned_home_without_changing_files(release_inputs, tmp_path):
    from courseweave import author_launcher as launcher
    from courseweave.author_bundle import build_bundle
    root = tmp_path / 'release'; build_bundle(release_inputs, root, platform_commit='a' * 40)
    home = tmp_path / 'my-work'; home.mkdir(); (home / 'notebook.ipynb').write_text('preserve')
    assert launcher.main(['setup', '--home', str(home)], root=root) == 1
    assert list(home.iterdir()) == [home / 'notebook.ipynb']
    assert (home / 'notebook.ipynb').read_text() == 'preserve'
