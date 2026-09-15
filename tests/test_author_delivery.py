"""Real snapshot bytes and explicit inclusion; no model or imported code execution."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import tarfile

import pytest

from courseweave.author.project import create_project, read_sources, update_source, ProjectError
from courseweave.author.quality import student_profile
from courseweave.store import CourseStore
from test_author_content import NOTEBOOK


@pytest.fixture
def delivery_project(tmp_path):
    source = tmp_path / "original"
    (source / "lessons").mkdir(parents=True)
    (source / "images").mkdir()
    data = json.loads(Path("examples/minimal-course/courseweave.json").read_text())
    data["id"] = "evidence-practice"
    data["modules"][0]["phases"][0]["surfaces"][0]["path"] = "lessons/unit.md"
    (source / "courseweave.json").write_text(json.dumps(data))
    (source / "lessons/unit.md").write_text('# Start\n\nPredict first. ![Process](../images/flow.svg)\n\n[Reference](../reference.md#Evidence)\n')
    (source / "images/flow.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 12"/></svg>')
    (source / "reference.md").write_text('# Evidence\n\nAn observed result follows the experiment.\n')
    (source / "README.md").write_text('# Study\n\n[Start](lessons/unit.md#Start).\n')
    (source / "LICENSE").write_text('CC BY 4.0 — authored evaluation fixture.\n')
    (source / "private-notes.md").write_text('Synthetic private author solution.\n')
    names = tuple(str(p.relative_to(source)) for p in source.rglob('*') if p.is_file())
    project = create_project(source, tmp_path / "author-project", names)
    store = CourseStore(project.course_root, state_dir=project.state_root / "transactions")
    for record in read_sources(project):
        if record.title != "private-notes.md":
            update_source(project, store, record.source_id, record.revision,
                {"status": "approved", "intended_use": "student_material", "redistribution": "include"})
    return project


def export_request(project, *, kind="student_handoff", selected_paths=None):
    from courseweave.author.delivery import ExportRequest, inspect_delivery
    plan = inspect_delivery(project, student_profile())
    return ExportRequest(project_revision=plan["project_revision"], inventory_sha256=plan["inventory_sha256"],
        source_decisions_sha256=plan["source_decisions_sha256"], course_version="1.0.0", kind=kind,
        selected_paths=tuple(selected_paths if selected_paths is not None else
            (f["path"] for f in plan["files"] if f["selected"])))


def members(path):
    with tarfile.open(path) as archive:
        assert all(m.isfile() for m in archive.getmembers())
        return {m.name: archive.extractfile(m).read() for m in archive.getmembers()}


def test_markdown_course_exports_transitive_assets_without_private_author_data(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    p = delivery_project
    original = {str(f.relative_to(p.course_root)): f.read_bytes() for f in p.course_root.rglob('*') if f.is_file()}
    receipt = export_course(p, tmp_path / "hand-off.tar", student_profile(), export_request(p))
    exported = members(receipt.destination)
    for name in ('courseweave.json', 'lessons/unit.md', 'images/flow.svg', 'reference.md', 'README.md', 'LICENSE'):
        assert exported[name] == original[name]
    assert 'private-notes.md' not in exported
    assert not any('author-state' in name or name.startswith('.') for name in exported)
    assert receipt.package_sha256 == hashlib.sha256(receipt.destination.read_bytes()).hexdigest()
    assert receipt.student_compatibility_target == '0.2.0' and receipt.compatibility.passed
    assert receipt.compatibility.not_performed
    assert all(f.read_bytes() == original[str(f.relative_to(p.course_root))] for f in p.course_root.rglob('*') if f.is_file())
    assert not any(b'Synthetic private author solution' in body or str(tmp_path).encode() in body for body in exported.values())
    assert not any(name.endswith('pyproject.toml') for name in exported)


def test_same_selected_bytes_produce_reproducible_packages(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    request = export_request(delivery_project)
    first = export_course(delivery_project, tmp_path / 'one.tar', student_profile(), request)
    second = export_course(delivery_project, tmp_path / 'two.tar', student_profile(), request)
    assert first.package_sha256 == second.package_sha256
    assert first.export_id != second.export_id


def test_candidate_profile_cannot_bypass_paired_released_video_limit(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    p = delivery_project
    path = p.course_root / 'courseweave.json'
    data = json.loads(path.read_text())
    # Existing approved bytes are enough for the static check; nothing executes.
    data['modules'][0]['phases'][0]['surfaces'].append({'id': 'clip', 'type': 'video',
        'purpose': 'reference', 'label': 'Clip', 'src': 'images/flow.svg'})
    path.write_text(json.dumps(data))
    with pytest.raises(ProjectError, match='released_local_video_unavailable'):
        export_course(p, tmp_path / 'paired.tar', student_profile('0.3.0'), export_request(p))
    assert not (tmp_path / 'paired.tar').exists()


@pytest.mark.parametrize('change', ['missing', 'fragment', 'escape', 'private-link', 'lfs', 'case-collision'])
def test_standard_handoff_rejects_broken_or_unsafe_assets(delivery_project, tmp_path, change):
    from courseweave.author.delivery import export_course
    p = delivery_project
    if change == 'missing': (p.course_root / 'images/flow.svg').unlink()
    elif change == 'fragment': (p.course_root / 'reference.md').write_text('# Another heading\n')
    elif change == 'escape': (p.course_root / 'lessons/unit.md').write_text('[escape](../../outside.md)\n')
    elif change == 'private-link': (p.course_root / 'lessons/unit.md').write_text('[private](../private-notes.md)\n')
    elif change == 'lfs': (p.course_root / 'images/flow.svg').write_text('version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'*64+'\nsize 5000\n')
    else:
        # Distinct spellings in a reviewed selection must fail on case-insensitive hosts too.
        request = export_request(p, selected_paths=('courseweave.json','lessons/unit.md','LESSONS/unit.md','LICENSE'))
    destination = tmp_path / 'invalid.tar'
    with pytest.raises(ProjectError):
        export_course(p, destination, student_profile(), request if change == 'case-collision' else export_request(p))
    assert not destination.exists()


@pytest.mark.parametrize('private', ['.env', 'author-state/sources.json', 'private-notes.md'])
def test_explicit_selection_cannot_bypass_exclusion_or_distribution(delivery_project, tmp_path, private):
    from courseweave.author.delivery import export_course
    request = export_request(delivery_project, selected_paths=('courseweave.json','lessons/unit.md','LICENSE',private))
    with pytest.raises(ProjectError):
        export_course(delivery_project, tmp_path/'bad.tar', student_profile(), request)


@pytest.mark.parametrize('changed', ['content', 'source-decision'])
def test_stale_export_review_is_rejected(delivery_project, tmp_path, changed):
    from courseweave.author.delivery import export_course
    p = delivery_project
    request = export_request(p)
    if changed == 'content': (p.course_root / 'lessons/unit.md').write_text('# Start\nChanged.\n')
    else:
        record = next(r for r in read_sources(p) if r.title == 'reference.md')
        update_source(p, CourseStore(p.course_root, state_dir=p.state_root/'transactions'), record.source_id, record.revision, {'redistribution':'exclude'})
    with pytest.raises(ProjectError, match='changed|stale|review'):
        export_course(p, tmp_path/'stale.tar', student_profile(), request)
    assert not (tmp_path/'stale.tar').exists()


def test_export_never_replaces_an_existing_destination(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    path = tmp_path/'keep.tar';path.write_bytes(b'Existing owner file')
    with pytest.raises(ProjectError):
        export_course(delivery_project, path, student_profile(), export_request(delivery_project))
    assert path.read_bytes() == b'Existing owner file'


def test_export_copies_reviewed_bytes_even_if_external_editor_changes_back(delivery_project, tmp_path, monkeypatch):
    from courseweave.author import delivery
    p = delivery_project
    request = export_request(p)
    path = p.course_root / 'README.md'
    original = path.read_bytes()
    inventory, copy = delivery.inspect_source, delivery._copy_selected
    calls = 0
    def changed_inventory(root):
        nonlocal calls
        if root == p.course_root:
            calls += 1
            if calls == 2:
                path.write_text('# Unreviewed external edit\n')
        return inventory(root)
    def copy_then_restore(root, file, destinations):
        copy(root, file, destinations)
        if file.path == 'README.md':
            path.write_bytes(original)
    monkeypatch.setattr(delivery, 'inspect_source', changed_inventory)
    monkeypatch.setattr(delivery, '_copy_selected', copy_then_restore)
    with pytest.raises(ProjectError, match='changed'):
        delivery.export_course(p, tmp_path / 'race.tar', student_profile(), request)
    assert not (tmp_path / 'race.tar').exists()


def test_destination_created_at_publication_is_preserved(delivery_project, tmp_path, monkeypatch):
    from courseweave.author import delivery
    destination = tmp_path / 'racing-owner.tar'
    link = delivery.os.link
    def racing_link(*args, **kwargs):
        destination.write_bytes(b'Owner file created during export')
        return link(*args, **kwargs)
    monkeypatch.setattr(delivery.os, 'link', racing_link)
    with pytest.raises(ProjectError, match='appeared'):
        delivery.export_course(delivery_project, destination, student_profile(), export_request(delivery_project))
    assert destination.read_bytes() == b'Owner file created during export'


def test_draft_is_labeled_and_retains_failed_checks(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    p = delivery_project
    (p.course_root / 'images/flow.svg').unlink()
    receipt = export_course(p, tmp_path / 'draft.tar', student_profile(), export_request(p, kind='draft'))
    contents = members(receipt.destination)
    assert not receipt.compatibility.passed
    assert receipt.kind == 'draft'
    assert b'DRAFT' in contents['COURSEWEAVE-SETUP.md']
    assert json.loads(contents['COURSEWEAVE-PACKAGE.json'])['kind'] == 'draft'


def test_export_and_student_extraction_share_the_supported_directory_depth(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    from courseweave.student_launcher import archive_members
    p = delivery_project
    name = '/'.join(['nested'] * 39 + ['lesson.md'])
    path = p.course_root / name; path.parent.mkdir(parents=True); path.write_text('# Start\nA nested lesson.\n')
    manifest_path = p.course_root / 'courseweave.json'; data = json.loads(manifest_path.read_text())
    data['modules'][0]['phases'][0]['surfaces'][0]['path'] = name
    manifest_path.write_text(json.dumps(data))
    receipt = export_course(p, tmp_path / 'nested.tar', student_profile(), export_request(p))
    with tarfile.open(receipt.destination) as archive:
        assert name in {member.name for member in archive_members(archive)}


def test_output_free_export_preserves_original_and_working_notebook(delivery_project, tmp_path):
    from courseweave.author.delivery import export_course
    p = delivery_project; notebook = deepcopy(NOTEBOOK)
    path = p.course_root/'lab.ipynb';path.write_text(json.dumps(notebook));before = path.read_bytes()
    manifest_path = p.course_root/'courseweave.json';data=json.loads(manifest_path.read_text())
    data['runtime']={'type':'jupyter','kernel':{'type':'python_uv_project'}}
    data['modules'][0]['phases'][0]['surfaces'].append({'id':'practice','type':'notebook','purpose':'supporting','path':'lab.ipynb','label':'Practice','selector':{'type':'whole_notebook'}})
    manifest_path.write_text(json.dumps(data))
    # Structural fixture only: no dependency solver or imported code runs in export.
    (p.course_root/'pyproject.toml').write_text('[project]\nname="practice"\nversion="1.0.0"\nrequires-python=">=3.11"\ndependencies=["ipykernel==7.3.0"]\n')
    (p.course_root/'uv.lock').write_text('version = 1\nrequires-python = ">=3.11"\n')
    receipt=export_course(p,tmp_path/'notebooks.tar',student_profile(),export_request(p))
    exported=json.loads(members(receipt.destination)['lab.ipynb'])
    assert path.read_bytes()==before
    assert exported['metadata']==notebook['metadata']
    assert [c['id'] for c in exported['cells']]==[c['id'] for c in notebook['cells']]
    for source, cell in zip(notebook['cells'], exported['cells']):
        assert source['source']==cell['source'] and source['metadata']==cell['metadata']
        if cell['cell_type']=='code': assert cell['outputs']==[] and cell['execution_count'] is None


def test_import_keeps_immutable_course_path_when_human_renames_source(delivery_project):
    p=delivery_project;record=next(r for r in read_sources(p) if r.title=='lessons/unit.md')
    changed=update_source(p,CourseStore(p.course_root,state_dir=p.state_root/'transactions'),record.source_id,record.revision,{'title':'Friendly title'})
    assert changed.course_path=='lessons/unit.md'


def test_source_decision_cannot_reassign_an_imported_file(delivery_project):
    p=delivery_project;record=next(r for r in read_sources(p) if r.title=='lessons/unit.md')
    with pytest.raises(ProjectError):
        update_source(p,CourseStore(p.course_root,state_dir=p.state_root/'transactions'),record.source_id,record.revision,{'course_path':'README.md'})


def test_development_project_uses_immutable_import_receipt_not_renamed_title(delivery_project, tmp_path):
    from courseweave.author.content import imported_file_sources
    from courseweave.author.delivery import export_course
    p = delivery_project
    records = json.loads((p.state_root / 'sources.json').read_text())
    for record in records:
        record.pop('course_path')
        path = p.state_root / 'sources' / record['source_id'] / 'revision-0.json'
        initial = json.loads(path.read_text()); initial.pop('course_path'); path.write_text(json.dumps(initial))
    private = next(record for record in records if record['title'] == 'private-notes.md')
    private['title'] = 'Human renamed this source'
    (p.state_root / 'sources.json').write_text(json.dumps(records))
    assert imported_file_sources(p)['private-notes.md'] == private['source_id']
    request = export_request(p)
    with pytest.raises(ProjectError, match='distribution'):
        export_course(p, tmp_path / 'blocked.tar', student_profile(), request.model_copy(update={'selected_paths': (*request.selected_paths, 'private-notes.md')}))


def test_refresh_of_imported_origin_retains_distribution_binding(delivery_project):
    from courseweave.author.sources import extract_source, save_source_snapshot
    from courseweave.author.content import _lock, imported_file_sources
    p = delivery_project; source = next(r for r in read_sources(p) if r.course_path == 'reference.md')
    raw = b'# Evidence\nChanged reference text.\n'
    with _lock(p):
        changed = save_source_snapshot(p, origin=source.origin, content=raw,
            extraction=extract_source(raw, 'text/markdown'), title='New reference title', policy_decision='local')
    assert changed.course_path == 'reference.md' and changed.status == 'candidate'
    assert imported_file_sources(p)['reference.md'] == source.source_id
    from courseweave.author.delivery import export_course
    with pytest.raises(ProjectError, match='distribution'):
        export_course(p, p.course_root.parent.parent / 'revoked.tar', student_profile(), export_request(p))


def test_only_applied_imports_replace_a_files_distribution_source(delivery_project, tmp_path):
    from courseweave.author.content import ContentEdit, stage_manual_change, apply_change, imported_file_sources, reject_change
    p=delivery_project; replacement=tmp_path/'replacement.md';replacement.write_text('# Start\nReplacement lesson.\n')
    def stage():
        return stage_manual_change(p, ContentEdit(path='lessons/unit.md',
            before_sha256=hashlib.sha256((p.course_root/'lessons/unit.md').read_bytes()).hexdigest(), before_exists=True,
            project_revision=0, manifest_sha256=hashlib.sha256((p.course_root/'courseweave.json').read_bytes()).hexdigest(),
            action={'kind':'import_replace','source_path':replacement}))
    original=next(r.source_id for r in read_sources(p) if r.title=='lessons/unit.md')
    rejected=stage();assert rejected.imported_source_id and rejected.imported_source_id!=original
    reject_change(p,rejected.change_id,0)
    assert imported_file_sources(p)['lessons/unit.md']==original
    accepted=stage()
    apply_change(p,accepted.change_id,0,'import-op',context_digest=accepted.context_digest)
    assert imported_file_sources(p)['lessons/unit.md']==accepted.imported_source_id


@pytest.mark.skipif(not os.environ.get('COURSEWEAVE_AUTHOR_REFERENCE_COURSE'), reason='Pinned full-course reference is an explicit installed-acceptance input')
def test_full_course_noop_import_export_preserves_every_selected_source(tmp_path):
    from courseweave.author.delivery import export_course, inspect_delivery
    from courseweave.author.project import inspect_source
    source = Path(os.environ['COURSEWEAVE_AUTHOR_REFERENCE_COURSE'])
    before = inspect_source(source)
    project = create_project(source, tmp_path / 'full-course', tuple(f.path for f in before.files))
    store = CourseStore(project.course_root, state_dir=project.state_root / 'transactions')
    for record in read_sources(project):
        update_source(project, store, record.source_id, record.revision,
            {'status': 'approved', 'intended_use': 'student_material', 'redistribution': 'include'})
    plan = inspect_delivery(project, student_profile())
    # The public Git checkout also contains optional video LFS pointers and
    # development files. The student handoff selects declared material and its
    # complete linked closure; selecting a pointer explicitly is rejected above.
    request = export_request(project)
    with pytest.raises(ProjectError, match='fragment_missing'):
        export_course(project, tmp_path / 'blocked-course.tar', student_profile(), request)
    receipt = export_course(project, tmp_path / 'faithful-draft.tar', student_profile(), request.model_copy(update={'kind': 'draft'}))
    with tarfile.open(receipt.destination) as archive:
        output = {m.name: archive.extractfile(m).read() for m in archive.getmembers() if m.isfile()}
    manifest = json.loads(output['courseweave.json'])
    assert len(manifest['modules']) == 14
    notebooks = [f for f in before.files if f.path.endswith('.ipynb')]
    assert len(notebooks) == 12
    assert all(file.path in output for file in notebooks)
    assert set(output) == set(request.selected_paths) | {'COURSEWEAVE-PACKAGE.json', 'COURSEWEAVE-SETUP.md'}
    for file in before.files:
        if file.path in request.selected_paths:
            assert hashlib.sha256(output[file.path]).hexdigest() == file.sha256, file.path
    assert inspect_source(source) == before
    assert [(issue.code, issue.location) for issue in receipt.compatibility.links] == [
        ('fragment_missing', '/files/labs/s01_loop.md')]
    # Preserve the imported original, review the single known Jupyter fragment
    # repair in the private working copy, then require a passing standard export.
    from courseweave.author.content import ContentEdit, read_content, stage_manual_change, change_diff, apply_change
    snapshot = read_content(project, 'labs/s01_loop.md')
    old = 'README.md#wire-contract-so---replay-matches'
    new = 'README.md#Wire-contract-%28so---replay-matches%29'
    assert snapshot['text'].count(old) == 1
    change = stage_manual_change(project, ContentEdit(path='labs/s01_loop.md', before_exists=True,
        before_sha256=snapshot['sha256'], project_revision=snapshot['project_revision'], manifest_sha256=snapshot['manifest_sha256'],
        action={'kind': 'markdown_replace', 'text': snapshot['text'].replace(old, new)}))
    assert old in str(change_diff(project, change.change_id)) and new in str(change_diff(project, change.change_id))
    apply_change(project, change.change_id, 0, 'repair-jupyter-fragment', context_digest=change.context_digest)
    fixed = export_course(project, tmp_path / 'complete-course.tar', student_profile(), export_request(project))
    assert fixed.compatibility.passed
    with tarfile.open(fixed.destination) as archive:
        for file in before.files:
            if file.path in request.selected_paths and file.path != 'labs/s01_loop.md':
                assert hashlib.sha256(archive.extractfile(file.path).read()).hexdigest() == file.sha256
    assert inspect_source(source) == before
