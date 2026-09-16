"""Student delivery: no hidden checkout, no overwritten work, no secret inheritance."""
import hashlib
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import pwd
import sys
import tarfile
import socket
from types import SimpleNamespace
import warnings

import pytest

ROOT = Path(__file__).resolve().parents[1]


def student():
    path = ROOT / 'src/courseweave/student_launcher.py'
    assert path.is_file(), 'The student release has no standalone setup/start entry point'
    spec = importlib.util.spec_from_file_location('student_pilot', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def release(tmp_path, members=None):
    root = tmp_path / 'Movable student release'
    root.mkdir()
    (root / 'courseweave.whl').write_bytes(b'fixture-wheel')
    (root / 'requirements.txt').write_text('ipykernel==7.3.0\n')
    with tarfile.open(root / 'course.tar.gz', 'w:gz') as archive:
        default_members = {
            'pyproject.toml': '[project]\nname = "agent-harness-path"\nversion = "0.2.0"\n',
            'courseweave.json': '{"schema_version":2}',
            'notebooks/attempt.ipynb': 'original',
        }
        for name, body in (members or default_members).items():
            member = tarfile.TarInfo(name)
            raw = body.encode()
            member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
    files = {}
    for key, name in [('wheel', 'courseweave.whl'), ('course', 'course.tar.gz'), ('constraints', 'requirements.txt')]:
        files[key] = {'path': name, 'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest()}
    (root / 'release.json').write_text(json.dumps({
        'format_version': 2,
        'course_id': 'agent-harness-path',
        'notebook_runtime': False,
        'platform_commit': 'fixture',
        'course_commit': 'fixture',
        'course_version': '0.2.0',
        'files': files,
    }))
    return root


def builder():
    path = ROOT / 'scripts/build_student_release.py'
    spec = importlib.util.spec_from_file_location('build_student_release', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def developer_launcher():
    path = ROOT / 'scripts/pilot'
    loader = importlib.machinery.SourceFileLoader('developer_pilot_launcher', str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(ROOT / 'scripts'))
    try:
        loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def installed_pilot_root(tmp_path):
    owned = tmp_path / '.pilot'
    owned.mkdir()
    wheel = owned / 'courseweave.whl'
    wheel.write_bytes(b'synthetic wheel')
    platform = owned / 'runtime/bin/python'
    platform.parent.mkdir(parents=True)
    platform.symlink_to('/usr/bin/python3')
    course = tmp_path / 'course'
    course.mkdir()
    kernel = course / '.venv/bin/python'
    kernel.parent.mkdir(parents=True)
    kernel.symlink_to('/usr/bin/python3')
    data = {
        'wheel': wheel.name,
        'wheel_sha256': hashlib.sha256(wheel.read_bytes()).hexdigest(),
        'platform_python': str(platform),
        'course_root': str(course),
        'kernel_python': str(kernel),
    }
    (owned / 'receipt.json').write_text(json.dumps(data))
    return tmp_path


def receipt(tmp_path, course_members):
    source = tmp_path / 'receipted artifacts'
    source.mkdir(parents=True)
    wheel = source / 'courseweave-0.2.0-py3-none-any.whl'
    wheel.write_bytes(b'fixture wheel')
    constraints = source / 'runtime-constraints.txt'
    constraints.write_text('ipykernel==7.3.0\n')
    course = source / 'agent-harness-path.tar'
    with tarfile.open(course, 'w') as archive:
        for name, body in course_members.items():
            member = tarfile.TarInfo(name)
            raw = body.encode()
            member.size = len(raw)
            archive.addfile(member, io.BytesIO(raw))
    data = {
        'platform_commit': 'platform-fixture',
        'course_commit': 'course-fixture',
        'wheel': wheel.name,
        'wheel_sha256': hashlib.sha256(wheel.read_bytes()).hexdigest(),
        'runtime_constraints': constraints.name,
        'runtime_constraints_sha256': hashlib.sha256(constraints.read_bytes()).hexdigest(),
        'source_archives': [{
            'repository': 'agent-harness-path',
            'path': course.name,
            'sha256': hashlib.sha256(course.read_bytes()).hexdigest(),
        }],
    }
    path = source / 'receipt.json'
    path.write_text(json.dumps(data))
    return path


def test_release_verifies_inputs_without_a_checkout_receipt(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    assert data['files']['wheel']['path'] == 'courseweave.whl'
    (root / 'courseweave.whl').write_bytes(b'corrupted')
    with pytest.raises(pilot.PilotError, match='damaged|hash'):
        pilot.load_release(root)


def test_release_rejects_artifact_paths_outside_the_folder(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = json.loads((root / 'release.json').read_text())
    data['files']['wheel']['path'] = '../outside.whl'
    (root / 'release.json').write_text(json.dumps(data))
    with pytest.raises(pilot.PilotError, match='release'):
        pilot.load_release(root)


@pytest.mark.parametrize('version', [None, '', '../escape', '2026/09', 'v one'])
def test_release_rejects_missing_or_unsafe_course_version(tmp_path, version):
    pilot = student()
    root = release(tmp_path)
    data = json.loads((root / 'release.json').read_text())
    if version is None:
        data.pop('course_version')
    else:
        data['course_version'] = version
    (root / 'release.json').write_text(json.dumps(data))
    with pytest.raises(pilot.PilotError, match='course version'):
        pilot.load_release(root)


def test_builder_records_course_version_and_licenses_in_eight_file_bundle(tmp_path):
    package = builder()
    metadata = {
        'pyproject.toml': '[project]\nname = "agent-harness-path"\nversion = "0.2.0"\n',
        'courseweave.json': '{"schema_version": 2, "id": "agent-harness-path"}',
        'LICENSE': 'fixture course license\n',
    }
    receipt_path = receipt(tmp_path, metadata)
    output = tmp_path / 'portable release'
    package.build(receipt_path, output)
    release_data = json.loads((output / 'release.json').read_text())
    assert release_data['course_version'] == '0.2.0'
    assert (output / 'LICENSE').read_bytes() == (ROOT / 'LICENSE').read_bytes()
    with tarfile.open(output / 'course.tar') as archive:
        assert archive.extractfile('LICENSE').read() == b'fixture course license\n'
    assert sorted(path.name for path in output.iterdir()) == [
        'LICENSE',
        'README.md',
        'Start Course.command',
        'course.tar',
        'courseweave-0.2.0-py3-none-any.whl',
        'release.json',
        'requirements.txt',
        'student_pilot.py',
    ]


@pytest.mark.parametrize('metadata, expected', [
    ({'courseweave.json': '{"schema_version": 2, "id": "practice"}', 'LICENSE': 'course'}, 'pyproject.toml'),
    ({'pyproject.toml': '[project]\nname = "practice"\n', 'courseweave.json': '{"schema_version": 2, "id": "practice"}', 'LICENSE': 'course'}, 'version'),
    ({'pyproject.toml': '[project]\nversion = "../escape"\n', 'courseweave.json': '{"schema_version": 2, "id": "practice"}', 'LICENSE': 'course'}, 'version'),
    ({'pyproject.toml': '[project\nversion = "0.2.0"\n', 'courseweave.json': '{"schema_version": 2, "id": "practice"}', 'LICENSE': 'course'}, 'pyproject.toml'),
    ({'pyproject.toml': '[project]\nversion = "0.2.0"\n', 'courseweave.json': '{}'}, 'LICENSE'),
])
def test_builder_rejects_missing_or_malformed_course_metadata(tmp_path, metadata, expected):
    package = builder()
    receipt_path = receipt(tmp_path, metadata)
    output = tmp_path / 'must not exist'
    with pytest.raises(ValueError, match=expected):
        package.build(receipt_path, output)
    assert not output.exists()


def test_restart_preserves_notebook_work_and_external_learning_state(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'My study files'
    home.mkdir()
    course = pilot.prepare_course(root, data, home)
    notebook = course / 'notebooks/attempt.ipynb'
    notebook.write_text('my saved answer')
    state = home / 'state'
    state.mkdir()
    (state / 'sentinel').write_text('my learning records')
    assert pilot.prepare_course(root, data, home) == course
    assert notebook.read_text() == 'my saved answer'
    assert (state / 'sentinel').read_text() == 'my learning records'
    assert not state.is_relative_to(course)


def test_changed_course_release_does_not_overwrite_existing_attempts(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'study'
    home.mkdir()
    course = pilot.prepare_course(root, data, home)
    (course / 'notebooks/attempt.ipynb').write_text('keep this answer')
    data['files']['course']['sha256'] = 'a' * 64
    with pytest.raises(pilot.PilotError, match='edition|different'):
        pilot.prepare_course(root, data, home)
    assert (course / 'notebooks/attempt.ipynb').read_text() == 'keep this answer'


@pytest.mark.parametrize('name', ['../escape', '/absolute-escape'])
def test_course_archive_cannot_escape_its_workspace(tmp_path, name):
    pilot = student()
    root = release(tmp_path, {name: 'must not be written'})
    home = tmp_path / 'study'
    home.mkdir()
    with pytest.raises(pilot.PilotError, match='archive'):
        pilot.prepare_course(root, pilot.load_release(root), home)
    assert not (home / 'course').exists()
    assert not (home / 'escape').exists()


def test_default_provider_mode_never_reads_inherited_credentials(monkeypatch):
    pilot = student()
    monkeypatch.setenv('OPENAI_API_KEY', 'private-synthetic-key')
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'private-anthropic-key')
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', 'openai')
    monkeypatch.setenv('COURSEWEAVE_CAPABILITY_TOKEN', 'private-synthetic-capability')
    environment, description = pilot.student_environment(
        no_provider=False, provider_env=False, provider=None, model=None, base_url=None,
    )
    assert 'OPENAI_API_KEY' not in environment
    assert 'ANTHROPIC_API_KEY' not in environment
    assert 'COURSEWEAVE_CAPABILITY_TOKEN' not in environment
    assert 'COURSEWEAVE_PROVIDER' not in environment
    assert 'off' in description.lower()


def test_explicit_provider_environment_rejects_partial_configuration(monkeypatch):
    pilot = student()
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', 'openai')
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_MODEL', 'my-model')
    with pytest.raises(pilot.PilotError, match='OPENAI_API_KEY'):
        pilot.student_environment(
            no_provider=False, provider_env=True, provider=None, model=None, base_url=None,
        )


@pytest.mark.parametrize('provider', ['openai', 'anthropic'])
def test_explicit_provider_environment_selects_only_matching_configuration(monkeypatch, provider):
    pilot = student()
    prefix = provider.upper()
    other = 'ANTHROPIC' if provider == 'openai' else 'OPENAI'
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', provider)
    monkeypatch.setenv(f'{prefix}_API_KEY', 'selected-synthetic-key')
    monkeypatch.setenv(f'{prefix}_MODEL', 'selected-model')
    monkeypatch.setenv(f'{prefix}_BASE_URL', 'https://provider.example/v1')
    monkeypatch.setenv(f'{other}_API_KEY', 'unrelated-provider-key')
    monkeypatch.setenv('COURSEWEAVE_CAPABILITY_TOKEN', 'unrelated-capability')
    environment, description = pilot.student_environment(
        no_provider=False, provider_env=True, provider=None, model=None, base_url=None,
    )
    assert environment[f'{prefix}_API_KEY'] == 'selected-synthetic-key'
    assert environment[f'{prefix}_MODEL'] == 'selected-model'
    assert environment[f'{prefix}_BASE_URL'] == 'https://provider.example/v1'
    assert environment['COURSEWEAVE_PROVIDER'] == provider
    assert environment['COURSEWEAVE_PROVIDER_PROFILE'] == 'text-only-v1'
    assert f'{other}_API_KEY' not in environment
    assert 'COURSEWEAVE_CAPABILITY_TOKEN' not in environment
    assert 'selected-synthetic-key' not in description


def test_interactive_provider_prompts_for_key_without_persisting_or_echoing_it(monkeypatch):
    pilot = student()
    monkeypatch.setattr(pilot.sys.stdin, 'isatty', lambda: True)
    prompts = []
    monkeypatch.setattr(pilot.getpass, 'getpass', lambda prompt: prompts.append(prompt) or 'prompted-synthetic-key')
    environment, description = pilot.student_environment(
        no_provider=False,
        provider_env=False,
        provider='anthropic',
        model='claude-fixture',
        base_url='https://anthropic.example/v1',
    )
    assert prompts == ['Anthropic API key (input hidden): ']
    assert environment['ANTHROPIC_API_KEY'] == 'prompted-synthetic-key'
    assert environment['ANTHROPIC_MODEL'] == 'claude-fixture'
    assert environment['ANTHROPIC_BASE_URL'] == 'https://anthropic.example/v1'
    assert 'prompted-synthetic-key' not in description


def test_interactive_provider_rejects_noninteractive_or_empty_key(monkeypatch):
    pilot = student()
    monkeypatch.setattr(pilot.sys.stdin, 'isatty', lambda: False)
    with pytest.raises(pilot.PilotError, match='interactive terminal'):
        pilot.student_environment(
            no_provider=False, provider_env=False, provider='openai', model='gpt-fixture', base_url=None,
        )
    monkeypatch.setattr(pilot.sys.stdin, 'isatty', lambda: True)
    monkeypatch.setattr(pilot.getpass, 'getpass', lambda _: '   ')
    with pytest.raises(pilot.PilotError, match='key'):
        pilot.student_environment(
            no_provider=False, provider_env=False, provider='openai', model='gpt-fixture', base_url=None,
        )


def test_interactive_provider_reports_an_unavailable_secure_prompt(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    monkeypatch.setattr(pilot.sys.stdin, 'isatty', lambda: True)
    monkeypatch.setattr(pilot.getpass, 'getpass', lambda _: (_ for _ in ()).throw(EOFError()))
    result = pilot.main([
        'check', '--home', str(tmp_path / 'study'),
        '--provider', 'openai', '--model', 'gpt-fixture',
    ], root=root)
    assert result == 1
    assert 'securely prompt' in capsys.readouterr().err


def test_interactive_provider_aborts_if_hidden_input_cannot_be_guaranteed(monkeypatch):
    pilot = student()
    monkeypatch.setattr(pilot.sys.stdin, 'isatty', lambda: True)
    echoed_reads = []

    def insecure_prompt(_):
        warnings.warn('echo cannot be disabled', pilot.getpass.GetPassWarning)
        echoed_reads.append('key would be read with echo')
        return 'must-not-be-used'

    monkeypatch.setattr(pilot.getpass, 'getpass', insecure_prompt)
    with pytest.raises(pilot.PilotError, match='hidden|secure'):
        pilot.student_environment(
            no_provider=False, provider_env=False,
            provider='openai', model='gpt-fixture', base_url=None,
        )
    assert echoed_reads == []


def test_developer_launcher_defaults_off_and_requires_explicit_provider_environment(tmp_path, monkeypatch):
    pilot = developer_launcher()
    root = installed_pilot_root(tmp_path)
    monkeypatch.setenv('COURSEWEAVE_PROVIDER', 'openai')
    monkeypatch.setenv('OPENAI_MODEL', 'explicit-model')
    monkeypatch.setenv('OPENAI_API_KEY', 'explicit-synthetic-key')
    calls = []
    monkeypatch.setattr(pilot.os, 'execve', lambda *args: calls.append(args))
    pilot.main([], root=root)
    assert 'COURSEWEAVE_PROVIDER' not in calls[-1][2]
    assert 'OPENAI_API_KEY' not in calls[-1][2]
    pilot.main(['--provider-env'], root=root)
    assert calls[-1][2]['COURSEWEAVE_PROVIDER'] == 'openai'
    assert calls[-1][2]['OPENAI_MODEL'] == 'explicit-model'
    assert calls[-1][2]['OPENAI_API_KEY'] == 'explicit-synthetic-key'


def test_missing_uv_reports_the_prerequisite_before_creating_study_files(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'not created'
    monkeypatch.setattr(pilot.shutil, 'which', lambda _: None)
    assert pilot.main(['setup', '--home', str(home)], root=root) == 1
    assert 'uv' in capsys.readouterr().err
    assert not home.exists()


def test_check_does_not_install_or_create_student_state(tmp_path, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'not installed'
    assert pilot.main(['check', '--home', str(home), '--no-provider'], root=root) == 2
    assert 'start' in capsys.readouterr().out.lower()
    assert not home.exists()


@pytest.mark.parametrize('flags, expected', [
    (['--model', 'orphan-model'], '--provider'),
    (['--base-url', 'https://provider.example/v1'], '--provider'),
    (['--provider', 'openai'], '--model'),
])
def test_provider_flags_require_a_complete_interactive_selection(tmp_path, flags, expected, capsys):
    pilot = student()
    root = release(tmp_path)
    assert pilot.main(['check', '--home', str(tmp_path / 'study'), *flags], root=root) == 1
    assert expected in capsys.readouterr().err


def test_full_course_default_leaves_previous_student_workspace_untouched(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    monkeypatch.setattr(pilot.sys, 'platform', 'darwin')
    monkeypatch.setattr(pilot.Path, 'home', lambda: tmp_path)
    previous = tmp_path / 'Library/Application Support/CourseWeave/Student Pilot'
    previous.mkdir(parents=True)
    (previous / 'saved-work').write_text('my earlier notebook and records')
    existing_full_course = previous.with_name('Student Pilot S01-S14')
    existing_full_course.mkdir()
    (existing_full_course / 'saved-work').write_text('my earlier full-course work')
    digest = pilot.load_release(root)['files']['course']['sha256']
    expected = previous.with_name('agent-harness-path-v0.2.0-' + digest[:16])
    assert pilot.default_home('agent-harness-path', '0.2.0', digest) == expected
    assert pilot.main(['check', '--no-provider'], root=root) == 2
    assert str(expected) in capsys.readouterr().out
    assert not expected.exists()
    assert (previous / 'saved-work').read_text() == 'my earlier notebook and records'
    assert (existing_full_course / 'saved-work').read_text() == 'my earlier full-course work'


def test_linux_default_uses_versioned_xdg_data_home(tmp_path, monkeypatch):
    pilot = student()
    monkeypatch.setattr(pilot.sys, 'platform', 'linux')
    monkeypatch.setenv('XDG_DATA_HOME', str(tmp_path / 'xdg data'))
    assert pilot.default_home('agent-harness-path', '0.2.0', 'a' * 64) == tmp_path / 'xdg data/courseweave/agent-harness-path-v0.2.0-aaaaaaaaaaaaaaaa'


@pytest.mark.parametrize('xdg_data_home', ['', 'relative/data'])
def test_linux_default_ignores_empty_or_relative_xdg_data_home(tmp_path, monkeypatch, xdg_data_home):
    pilot = student()
    monkeypatch.setattr(pilot.sys, 'platform', 'linux')
    monkeypatch.setattr(pilot.Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('XDG_DATA_HOME', xdg_data_home)
    assert pilot.default_home('agent-harness-path', '0.2.0', 'a' * 64) == tmp_path / '.local/share/courseweave/agent-harness-path-v0.2.0-aaaaaaaaaaaaaaaa'


@pytest.mark.parametrize('location', [
    'Library/Mobile Documents/com~apple~CloudDocs/courseweave',
    'Library/CloudStorage/GoogleDrive-test/My Drive/courseweave',
])
def test_cloud_synced_study_location_is_rejected_before_creation(tmp_path, monkeypatch, capsys, location):
    pilot = student()
    root = release(tmp_path)
    monkeypatch.setattr(pilot.Path, 'home', lambda: tmp_path)
    home = tmp_path / location
    assert pilot.main(['check', '--no-provider', '--home', str(home)], root=root) == 1
    assert 'cloud' in capsys.readouterr().err.lower()
    assert not home.exists()


@pytest.mark.parametrize('location', [
    'Library/Mobile Documents/com~apple~CloudDocs/courseweave',
    'Library/CloudStorage/GoogleDrive-test/My Drive/courseweave',
])
def test_actual_account_cloud_path_is_rejected_when_process_home_differs(tmp_path, monkeypatch, location):
    pilot = student()
    process_home = tmp_path / 'disposable home'
    account_home = tmp_path / 'actual account home'
    monkeypatch.setattr(pilot.Path, 'home', lambda: process_home)
    monkeypatch.setattr(pwd, 'getpwuid', lambda _: SimpleNamespace(pw_dir=str(account_home)))
    with pytest.raises(pilot.PilotError, match='cloud'):
        pilot.local_path(account_home / location, 'study folder')


def test_cloud_synced_bundle_and_export_locations_are_rejected(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    monkeypatch.setattr(pilot.Path, 'home', lambda: tmp_path)
    cloud = tmp_path / 'Library/Mobile Documents/com~apple~CloudDocs'
    cloud.mkdir(parents=True)
    bundle = cloud / 'release'
    root.rename(bundle)
    home = tmp_path / 'local study'
    assert pilot.main(['check', '--no-provider', '--home', str(home)], root=bundle) == 1
    assert 'bundle' in capsys.readouterr().err.lower()
    second = tmp_path / 'second'
    second.mkdir()
    assert pilot.main([
        'export', '--home', str(home), '--output', str(cloud / 'records.json'),
    ], root=release(second)) == 1
    error = capsys.readouterr().err.lower()
    assert 'export' in error and 'cloud' in error
    assert not home.exists()


def test_redirected_course_path_is_rejected_without_following_it(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'study'
    home.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    (home / 'course').symlink_to(outside, target_is_directory=True)
    with pytest.raises(pilot.PilotError, match='redirected|link'):
        pilot.prepare_course(root, data, home)
    assert list(outside.iterdir()) == []


def test_redirected_release_runtime_identity_is_rejected_without_following_it(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'study'
    runtimes = home / 'runtimes'
    runtimes.mkdir(parents=True)
    identity = '-'.join(data['files'][kind]['sha256'][:16] for kind in ('wheel', 'constraints', 'course'))
    outside = tmp_path / 'outside runtime'
    outside.mkdir()
    (runtimes / identity).symlink_to(outside, target_is_directory=True)
    with pytest.raises(pilot.PilotError, match='runtime|redirected|link'):
        pilot.runtime_paths(data, home)
    assert list(outside.iterdir()) == []


@pytest.mark.parametrize('redirect', [
    'platform', 'platform/bin', 'kernel', 'kernel/bin', 'ready.json',
])
def test_redirected_runtime_container_or_marker_is_rejected_without_writes(tmp_path, redirect):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'study'
    identity = '-'.join(data['files'][kind]['sha256'][:16] for kind in ('wheel', 'constraints', 'course'))
    runtime = home / 'runtimes' / identity
    runtime.mkdir(parents=True)
    link = runtime / redirect
    link.parent.mkdir(parents=True, exist_ok=True)
    if redirect == 'ready.json':
        outside = tmp_path / 'outside marker'
        outside.write_text('keep this marker')
        link.symlink_to(outside)
    else:
        outside = tmp_path / f'outside {redirect.replace("/", "-")}'
        outside.mkdir()
        link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(pilot.PilotError, match='runtime|redirected|link'):
        pilot.runtime_paths(data, home)
    if outside.is_dir():
        assert list(outside.iterdir()) == []
    else:
        assert outside.read_text() == 'keep this marker'


def test_runtime_paths_allow_uv_python_symlinks_inside_real_containers(tmp_path):
    pilot = student()
    root = release(tmp_path)
    data = pilot.load_release(root)
    home = tmp_path / 'study'
    identity = '-'.join(data['files'][kind]['sha256'][:16] for kind in ('wheel', 'constraints', 'course'))
    runtime = home / 'runtimes' / identity
    for environment in ('platform', 'kernel'):
        bin_dir = runtime / environment / 'bin'
        bin_dir.mkdir(parents=True)
        (bin_dir / 'python').symlink_to('/usr/bin/python3')
    (runtime / 'ready.json').write_text('{}\n')
    returned_runtime, platform, kernel = pilot.runtime_paths(data, home)
    assert returned_runtime == runtime
    assert platform.is_symlink()
    assert kernel.is_symlink()


def test_occupied_port_has_a_recovery_instruction_without_installing(tmp_path, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'not installed'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        assert pilot.main(['--no-provider', '--port', str(port), '--home', str(home)], root=root) == 1
    error = capsys.readouterr().err
    assert str(port) in error and '--port' in error
    assert not home.exists()


def test_failed_setup_preserves_existing_work_and_does_not_mark_ready(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'study'
    home.mkdir()
    course = pilot.prepare_course(root, pilot.load_release(root), home)
    (course / 'notebooks/attempt.ipynb').write_text('keep my answer')
    tool = tmp_path / 'failing-uv'
    tool.write_text('#!/bin/sh\nprintf "error: Could not connect to https://user:private-secret@example.invalid/path?token=another-secret" >&2\nexit 17\n')
    tool.chmod(0o700)
    monkeypatch.setattr(pilot.shutil, 'which', lambda _: str(tool))
    assert pilot.main(['setup', '--home', str(home)], root=root) == 1
    error = capsys.readouterr().err
    assert '17' in error and 'start again' in error
    assert 'Could not connect' in error
    assert 'private-secret' not in error and 'another-secret' not in error
    assert not list(home.rglob('ready.json'))
    assert (course / 'notebooks/attempt.ipynb').read_text() == 'keep my answer'


def test_reset_requires_explicit_confirmation_before_any_setup(tmp_path, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'not installed'
    assert pilot.main(['reset', '--home', str(home)], root=root) == 1
    assert '--confirm' in capsys.readouterr().err
    assert not home.exists()


def test_check_reports_damaged_course_and_does_not_create_state(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    home = tmp_path / 'study'
    home.mkdir()
    course = pilot.prepare_course(root, pilot.load_release(root), home)
    (course / 'courseweave.json').unlink()
    monkeypatch.setattr(pilot, 'runtime_ready', lambda *_: True)
    assert pilot.main(['check', '--home', str(home), '--no-provider'], root=root) == 2
    assert 'Course: needs attention' in capsys.readouterr().out
    assert not (home / 'state').exists()


def test_restart_port_probe_accepts_closed_server_in_time_wait(tmp_path, monkeypatch, capsys):
    pilot = student()
    root = release(tmp_path)
    with socket.socket() as server, socket.socket() as client:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('127.0.0.1', 0))
        port = server.getsockname()[1]
        server.listen()
        client.connect(('127.0.0.1', port))
        connection, _ = server.accept()
        connection.close()
        assert client.recv(1) == b''
    monkeypatch.setattr(pilot.shutil, 'which', lambda _: None)
    assert pilot.main(['--no-provider', '--port', str(port), '--home', str(tmp_path / 'study')], root=root) == 1
    error = capsys.readouterr().err
    assert 'already in use' not in error
    assert 'uv' in error
