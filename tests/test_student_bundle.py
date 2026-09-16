"""Generic delivery identities and course-owned dependency setup."""
from copy import deepcopy
import json
from pathlib import Path
import pytest
from test_student_pilot import student, release
from test_author_delivery import delivery_project, export_request


def test_course_id_version_and_package_bytes_each_select_a_new_home(tmp_path, monkeypatch):
    launcher = student(); monkeypatch.setattr(launcher.Path, 'home', lambda: tmp_path)
    first = launcher.default_home('data-practice', '1.0.0', 'a' * 64)
    assert len({first, launcher.default_home('another-course', '1.0.0', 'a' * 64),
        launcher.default_home('data-practice', '2.0.0', 'a' * 64), launcher.default_home('data-practice', '1.0.0', 'b' * 64)}) == 4
    assert 'data-practice' in first.name and '1.0.0' in first.name
    assert not first.exists()


@pytest.mark.parametrize('identity', ['../escape', 'a/b', 'a b', '', '.private'])
def test_unsafe_course_identity_never_becomes_a_path(identity):
    launcher = student()
    with pytest.raises(launcher.PilotError):
        launcher.default_home(identity, '1.0.0', 'a' * 64)


def test_course_archive_identity_separates_kernel_dependencies(tmp_path):
    launcher = student(); root = release(tmp_path); data = launcher.load_release(root)
    changed = deepcopy(data); changed['files']['course']['sha256'] = 'b' * 64
    assert launcher.runtime_paths(data, tmp_path / 'study')[0] != launcher.runtime_paths(changed, tmp_path / 'study')[0]


def test_notebook_runtime_syncs_course_lock_in_isolated_kernel(tmp_path, monkeypatch):
    launcher = student(); root = release(tmp_path); data = launcher.load_release(root); data['notebook_runtime'] = True
    home = tmp_path / 'study'; home.mkdir(); course = launcher.prepare_course(root, data, home)
    (course / 'uv.lock').write_text('version = 1\n')
    calls = []; probes = iter([False, True])
    monkeypatch.setattr(launcher, 'runtime_ready', lambda *_: next(probes))
    monkeypatch.setattr(launcher, 'run_setup', lambda command, label, **kwargs: calls.append((command, kwargs)))
    _, kernel = launcher.ensure_runtime(root, data, home, '/usr/local/bin/uv')
    sync = next(item for item in calls if 'sync' in item[0])
    assert '--frozen' in sync[0] and '--no-default-groups' in sync[0]
    assert sync[0][sync[0].index('--project') + 1] == str(course)
    assert sync[1]['environment'] == {'UV_PROJECT_ENVIRONMENT': str(kernel.parent.parent)}
    assert not any('ipykernel==7.3.0' in command for command, _ in calls)
    assert not (course / '.venv').exists()


def test_different_course_is_rejected_before_any_dependency_install(tmp_path, monkeypatch):
    launcher = student(); root = release(tmp_path); home = tmp_path / 'study'; home.mkdir()
    course = launcher.prepare_course(root, launcher.load_release(root), home)
    (course / '.student-course.json').write_text(json.dumps({'archive_sha256': 'b' * 64}))
    calls = []; monkeypatch.setattr(launcher, 'ensure_runtime', lambda *_: calls.append(True))
    assert launcher.main(['setup', '--home', str(home)], root=root) == 1
    assert calls == []


def test_markdown_course_builds_a_generic_movable_bundle(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    from courseweave.author.quality import student_profile
    from courseweave.student_bundle import build_bundle
    receipt = export_course(delivery_project, tmp_path / 'markdown.tar', student_profile(), export_request(delivery_project))
    root = release(tmp_path); data = student().load_release(root)
    inputs = {key: (root / value['path'], value['sha256']) for key, value in data['files'].items()}
    inputs['course'] = (receipt.destination, receipt.package_sha256)
    output = tmp_path / 'Generic Markdown Student'
    built = build_bundle(inputs, output)
    assert built['course_id'] == 'evidence-practice' and built['course_version'] == '1.0.0'
    assert not built['notebook_runtime']
    assert 'agent-harness-path' not in (output / 'release.json').read_text()
    assert student().load_release(output)['files']['course']['sha256'] == receipt.package_sha256
    assert (output / 'Start Course.command').stat().st_mode & 0o111
    assert 'Author' in (output / 'README.md').read_text()
    assert (output / 'student_pilot.py').read_bytes() == Path('src/courseweave/student_launcher.py').read_bytes()


def test_draft_cannot_be_promoted_by_the_bundle_builder(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    from courseweave.author.quality import student_profile
    from courseweave.student_bundle import build_bundle
    receipt = export_course(delivery_project, tmp_path / 'draft.tar', student_profile(), export_request(delivery_project, kind='draft'))
    root = release(tmp_path); data = student().load_release(root)
    inputs = {key: (root / value['path'], value['sha256']) for key, value in data['files'].items()}
    inputs['course'] = (receipt.destination, receipt.package_sha256)
    with pytest.raises(ValueError, match='draft'):
        build_bundle(inputs, tmp_path / 'invalid')
    assert not (tmp_path / 'invalid').exists()


@pytest.mark.parametrize('names', [('one.md', 'one.md'), ('one.md', 'ONE.md'), ('a/one.md', 'A/two.md'), ('a', 'a/child'), ('author-state/private.json',)])
def test_archive_conflicts_and_private_files_are_rejected_before_extraction(tmp_path, names):
    import io, tarfile, hashlib
    launcher = student(); root = release(tmp_path); data = launcher.load_release(root)
    path = root / data['files']['course']['path']
    with tarfile.open(path, 'w') as archive:
        for name in names:
            member = tarfile.TarInfo(name); member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))
    data['files']['course']['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    home = tmp_path / 'study'; home.mkdir()
    with pytest.raises(launcher.PilotError):
        launcher.prepare_course(root, data, home)
    assert not (home / 'course').exists()
