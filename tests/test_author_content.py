"""Reviewed author edits preserve source/student copies and survive interruption."""
from copy import deepcopy
from hashlib import sha256
import json

import pytest

from courseweave.author.contracts import (
    AuthorContext, AuthorSelection, ManifestFragmentDraft, MarkdownDraft, NotebookCellsDraft,
)
from courseweave.author.project import create_project, open_project
from courseweave.manifest import empty_manifest_draft, save_manifest


NOTEBOOK = {"nbformat": 4, "nbformat_minor": 5, "metadata": {"custom": "preserve"}, "cells": [
    {"id": "reading", "cell_type": "markdown", "metadata": {"tags": ["read"]}, "source": ["Predict first.\n"]},
    {"id": "attempt", "cell_type": "code", "metadata": {"tags": ["attempt"], "custom": "keep"},
     "source": ["prediction = None\n"], "execution_count": 4,
     "outputs": [{"output_type": "stream", "name": "stdout", "text": ["Saved student output\n"]}]},
]}


@pytest.fixture
def project(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("# Original\n\nMake a prediction.\n")
    (source / "lab.ipynb").write_text(json.dumps(NOTEBOOK, indent=2) + "\n")
    (source / "script.py").write_text("raise RuntimeError('never execute imports')\n")
    project = create_project(source, tmp_path / "author-project", ("lesson.md", "lab.ipynb", "script.py"))
    save_manifest(project.course_root, empty_manifest_draft(project.course_root), if_match='""')
    student = tmp_path / "student"
    student.mkdir()
    (student / "lab.ipynb").write_bytes((source / "lab.ipynb").read_bytes())
    return project


def context_for(project, path="lesson.md", *, cells=(), unit="course", module=None, phase=None):
    """Synthetic server context. Public routes must construct this themselves."""
    project = open_project(project.course_root.parent)
    manifest = (project.course_root / "courseweave.json").read_bytes()
    target = project.course_root / path
    raw = target.read_bytes() if target.exists() else b""
    selection = AuthorSelection(project_id=project.project_id, course_id=json.loads(manifest)["id"],
        file_path=path, cell_ids=cells, manifest_unit=unit, module_id=module, phase_id=phase)
    digest = sha256(manifest + raw + selection.model_dump_json().encode()).hexdigest()
    return AuthorContext(selection=selection, role="proofreader", project_revision=project.revision,
        manifest_sha256=sha256(manifest).hexdigest(), target_path=path, target_sha256=sha256(raw).hexdigest(), target_exists=target.exists(),
        sources=(), permission_sha256=sha256(b"explicit-test-selection").hexdigest(),
        prompt_version="test-only-v1", provider_fingerprint=sha256(b"synthetic").hexdigest(),
        digest=digest, content="Synthetic selected context")


def test_cell_replacement_preserves_identity_metadata_and_untouched_cells():
    from courseweave.author.content import assemble_notebook
    original = deepcopy(NOTEBOOK)
    candidate = assemble_notebook(original, {"attempt": "prediction = 'my prediction'\n"})
    assert original == NOTEBOOK
    assert candidate["cells"][0] == original["cells"][0]
    assert candidate["cells"][1]["id"] == "attempt"
    assert candidate["cells"][1]["metadata"] == original["cells"][1]["metadata"]
    assert candidate["cells"][1]["source"] == ["prediction = 'my prediction'\n"]


def test_new_cells_get_new_ids_without_reassigning_existing_ids():
    from courseweave.author.content import assemble_notebook
    candidate = assemble_notebook(NOTEBOOK, {}, new_cells=[{"cell_type": "markdown", "source": "Explain the result.\n"}])
    assert [cell["id"] for cell in candidate["cells"][:2]] == ["reading", "attempt"]
    assert candidate["cells"][2]["id"] not in {"reading", "attempt"}
    assert len(candidate["cells"][2]["id"]) <= 64
    assert candidate["cells"][2]["source"] == ["Explain the result.\n"]


@pytest.mark.parametrize("problem", ["missing", "duplicate", "invalid"])
def test_bad_cell_identities_are_not_silently_repaired(problem):
    from courseweave.author.content import assemble_notebook, ContentError
    original = deepcopy(NOTEBOOK)
    if problem == "missing":
        del original["cells"][0]["id"]
    elif problem == "duplicate":
        original["cells"][1]["id"] = "reading"
    else:
        original["cells"][0]["id"] = "../cell"
    with pytest.raises(ContentError):
        assemble_notebook(original, {"attempt": "Updated"})


def test_rejection_and_stale_revision_never_write(project):
    from courseweave.author.content import stage_change, reject_change, apply_change, ContentError
    before = (project.course_root / "lesson.md").read_bytes()
    context = context_for(project)
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="# Revised\n"))
    assert (project.course_root / "lesson.md").read_bytes() == before
    with pytest.raises(ContentError):
        apply_change(project, change.change_id, change.revision + 1, "wrong-revision", context_digest=context.digest)
    rejected = reject_change(project, change.change_id, change.revision)
    assert rejected.status == "rejected"
    with pytest.raises(ContentError):
        apply_change(project, change.change_id, change.revision, "reject-replay", context_digest=context.digest)
    assert (project.course_root / "lesson.md").read_bytes() == before


def test_two_tabs_replay_and_exact_diff(project):
    from courseweave.author.content import stage_change, apply_change, change_diff, ContentError
    context = context_for(project)
    one = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="# First\n"))
    two = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="# Second\n"))
    diff = change_diff(project, one.change_id)
    assert "-# Original" in diff and "+# First" in diff
    receipt = apply_change(project, one.change_id, one.revision, "first-save", context_digest=context.digest)
    assert receipt.after_sha256 == sha256(b"# First\n").hexdigest()
    assert apply_change(project, one.change_id, one.revision, "first-save", context_digest=context.digest) == receipt
    with pytest.raises(ContentError):
        apply_change(project, two.change_id, two.revision, "second-save", context_digest=context.digest)
    with pytest.raises(ContentError):
        apply_change(project, two.change_id, two.revision, "first-save", context_digest=context.digest)
    assert (project.course_root / "lesson.md").read_text() == "# First\n"


def test_external_editor_change_is_a_conflict(project):
    from courseweave.author.content import stage_change, apply_change, ContentError
    context = context_for(project)
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Proposed"))
    (project.course_root / "lesson.md").write_text("External editor revision")
    with pytest.raises(ContentError):
        apply_change(project, change.change_id, change.revision, "external-race", context_digest=context.digest)
    assert (project.course_root / "lesson.md").read_text() == "External editor revision"


def test_named_cells_only_and_source_candidate_clears_outputs_after_review(project):
    from courseweave.author.content import stage_change, apply_change, ContentError
    original = (project.course_root / "lab.ipynb").read_bytes()
    context = context_for(project, "lab.ipynb", cells=("attempt",))
    with pytest.raises(ContentError):
        stage_change(project, context, NotebookCellsDraft(kind="notebook_cells", replace_sources={"reading": "Wrong cell"}))
    with pytest.raises(ContentError):
        stage_change(project, context, NotebookCellsDraft(kind="notebook_cells", replace_sources={"absent": "Missing cell"}))
    change = stage_change(project, context, NotebookCellsDraft(kind="notebook_cells", replace_sources={"attempt": "prediction = 7\n"}))
    assert (project.course_root / "lab.ipynb").read_bytes() == original
    candidate = json.loads(change.after_bytes)
    assert candidate["cells"][0] == NOTEBOOK["cells"][0]
    assert candidate["cells"][1]["id"] == "attempt"
    assert candidate["cells"][1]["metadata"] == NOTEBOOK["cells"][1]["metadata"]
    assert candidate["cells"][1]["outputs"] == []
    assert candidate["cells"][1]["execution_count"] is None
    apply_change(project, change.change_id, change.revision, "notebook-save", context_digest=context.digest)
    assert json.loads((project.course_root / "lab.ipynb").read_bytes()) == candidate
    assert (project.course_root.parent.parent / "source/lab.ipynb").read_bytes() == original
    assert (project.course_root.parent.parent / "student/lab.ipynb").read_bytes() == original


def test_scripts_and_unselected_targets_cannot_be_model_edits(project):
    from courseweave.author.content import stage_change, ContentError
    with pytest.raises(ContentError):
        stage_change(project, context_for(project, "script.py"), MarkdownDraft(kind="markdown_replace", text="print('overwritten')"))
    context = context_for(project)
    context = context.model_copy(update={"target_path": "script.py"})
    with pytest.raises(ContentError):
        stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Another path"))


def test_new_empty_file_is_not_equivalent_to_an_absent_reviewed_target(project):
    from courseweave.author.content import stage_change, apply_change, ContentError
    context = context_for(project, "new.md")
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="# New lesson\n"))
    (project.course_root / "new.md").write_bytes(b"")
    with pytest.raises(ContentError):
        apply_change(project, change.change_id, change.revision, "created-race", context_digest=context.digest)
    assert (project.course_root / "new.md").read_bytes() == b""


def test_manifest_composition_preserves_course_identity_and_runs_canonical_validation(project):
    from courseweave.author.content import stage_change, apply_change, ContentError
    context = context_for(project, "courseweave.json")
    manifest = json.loads((project.course_root / "courseweave.json").read_text())
    manifest.pop("modules")
    with pytest.raises(ContentError):
        stage_change(project, context, ManifestFragmentDraft(kind="manifest_fragment_replace", value={**manifest, "id": "another-course"}))
    with pytest.raises(ContentError):
        stage_change(project, context, ManifestFragmentDraft(kind="manifest_fragment_replace", value={**manifest, "teacher_notes": "not a student field"}))
    change = stage_change(project, context, ManifestFragmentDraft(kind="manifest_fragment_replace", value={**manifest, "title": "Reviewed title"}))
    apply_change(project, change.change_id, change.revision, "manifest-save", context_digest=context.digest)
    saved = json.loads((project.course_root / "courseweave.json").read_text())
    assert saved["id"] == manifest["id"]
    assert saved["title"] == "Reviewed title"


class InterruptedApply(BaseException):
    pass


@pytest.mark.parametrize("phase,expected", [("after_prepare", "pending"), ("after_replace", "applied"), ("before_receipt", "applied")])
def test_restart_reconciles_prepared_operations_by_exact_hash(project, phase, expected):
    from courseweave.author.content import stage_change, apply_change, recover_changes, read_change
    context = context_for(project)
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Recovered\n"))
    def crash(current_phase):
        if current_phase == phase:
            raise InterruptedApply()
    with pytest.raises(InterruptedApply):
        apply_change(project, change.change_id, change.revision, "interrupted-save", context_digest=context.digest, crash_hook=crash)
    reopened = open_project(project.course_root.parent)
    recover_changes(reopened)
    assert read_change(reopened, change.change_id).status == expected
    expected_bytes = b"Recovered\n" if expected == "applied" else b"# Original\n\nMake a prediction.\n"
    assert (project.course_root / "lesson.md").read_bytes() == expected_bytes
    if expected == "applied":
        receipt = apply_change(reopened, change.change_id, change.revision, "interrupted-save", context_digest=context.digest)
        assert receipt.after_sha256 == sha256(expected_bytes).hexdigest()


def test_restart_never_overwrites_a_third_hash(project):
    from courseweave.author.content import stage_change, apply_change, recover_changes, read_change
    context = context_for(project)
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Candidate"))
    def crash(phase):
        if phase == "after_replace":
            raise InterruptedApply()
    with pytest.raises(InterruptedApply):
        apply_change(project, change.change_id, change.revision, "third-hash", context_digest=context.digest, crash_hook=crash)
    (project.course_root / "lesson.md").write_text("Unrelated new work")
    recover_changes(open_project(project.course_root.parent))
    assert read_change(project, change.change_id).status == "conflict"
    assert (project.course_root / "lesson.md").read_text() == "Unrelated new work"


def test_failed_write_never_becomes_a_success_on_restart(project, monkeypatch):
    from courseweave.author import content
    context = context_for(project)
    change = content.stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Renamed before fsync failure"))
    replace = content._replace
    def late_failure(project, change):
        replace(project, change)
        raise OSError("injected directory fsync failure")
    monkeypatch.setattr(content, "_replace", late_failure)
    with pytest.raises(content.ContentError):
        content.apply_change(project, change.change_id, change.revision, "late-failure", context_digest=context.digest)
    content.recover_changes(project)
    assert content.read_change(project, change.change_id).status == "failed"
    with pytest.raises(content.ContentError):
        content.apply_change(project, change.change_id, change.revision, "late-failure", context_digest=context.digest)
    assert (project.course_root / "lesson.md").read_text() == "Renamed before fsync failure"


def test_final_newline_change_is_visible_in_diff(project):
    from courseweave.author.content import stage_change, change_diff
    context = context_for(project)
    original = (project.course_root / "lesson.md").read_text()
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text=original.rstrip("\n")))
    assert r"\ No newline at end of file" in change_diff(project, change.change_id)


def test_source_revocation_invalidates_pending_edit(project):
    from courseweave.author.content import stage_change, apply_change, ContentError
    from courseweave.author.project import read_sources, update_source
    from courseweave.author.contracts import SourceRevision
    from courseweave.store import CourseStore
    store = CourseStore(project.course_root, state_dir=project.state_root / "transactions")
    source = read_sources(project)[0]
    source = update_source(project, store, source.source_id, source.revision, {"status": "approved"})
    selected = SourceRevision.model_validate({k: getattr(source, k) for k in SourceRevision.model_fields})
    context = context_for(project).model_copy(update={"sources": (selected,)})
    change = stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="With source"))
    update_source(project, store, source.source_id, source.revision, {"status": "rejected"})
    with pytest.raises(ContentError, match="source"):
        apply_change(project, change.change_id, 0, "revoked-source", context_digest=context.digest)


@pytest.fixture
def content_api(project):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    return TestClient(create_app(project.course_root, capability_token="content-test",
        state_dir=project.state_root / "transactions", author_project=project))


CONTENT_AUTH = {"Authorization": "Bearer content-test"}


def edit_request(snapshot, action):
    return {"path": snapshot["path"], "before_sha256": snapshot["sha256"], "before_exists": snapshot["exists"],
            "project_revision": snapshot["project_revision"], "manifest_sha256": snapshot["manifest_sha256"], "action": action}


def test_manual_content_routes_require_auth_private_project_and_closed_body(project, content_api):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    assert content_api.get("/api/author/content?path=lesson.md").status_code == 403
    student = TestClient(create_app(project.course_root, capability_token="content-test"))
    assert student.get("/api/author/content?path=lesson.md", headers=CONTENT_AUTH).status_code == 403
    snapshot = content_api.get("/api/author/content?path=lesson.md", headers=CONTENT_AUTH).json()
    request = edit_request(snapshot, {"kind": "markdown_replace", "text": "Human edit"})
    assert content_api.post("/api/author/changes", headers=CONTENT_AUTH, json={**request, "approved": True}).status_code == 422
    assert content_api.post("/api/author/changes", headers=CONTENT_AUTH, json={
        **request, "action": {"kind": "shell", "command": "touch wrong"}}).status_code == 422
    assert content_api.get("/api/author/content?path=../source/lesson.md", headers=CONTENT_AUTH).status_code == 409


def test_manual_markdown_diff_and_explicit_revision_apply_survive_reopen(project, content_api):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    snapshot = content_api.get("/api/author/content?path=lesson.md", headers=CONTENT_AUTH).json()
    staged = content_api.post("/api/author/changes", headers=CONTENT_AUTH,
        json=edit_request(snapshot, {"kind": "markdown_replace", "text": "# Human revision\n"}))
    assert staged.status_code == 201
    change = staged.json()
    assert (project.course_root / "lesson.md").read_text().startswith("# Original")
    reopened = TestClient(create_app(project.course_root, capability_token="content-test",
        state_dir=project.state_root / "transactions", author_project=open_project(project.course_root.parent)))
    assert reopened.get("/api/author/changes", headers=CONTENT_AUTH).json()["total"] == 1
    review = reopened.get(f"/api/author/changes/{change['change_id']}", headers=CONTENT_AUTH).json()
    assert "-# Original" in review["diff"] and "+# Human revision" in review["diff"]
    body = {"reviewed_revision": change["revision"], "context_digest": change["context_digest"], "operation_id": "manual-save"}
    url = f"/api/author/changes/{change['change_id']}/apply"
    assert reopened.post(url, headers=CONTENT_AUTH, json={**body, "reviewed_revision": 12}).status_code == 409
    receipt = reopened.post(url, headers=CONTENT_AUTH, json=body)
    assert receipt.status_code == 200
    assert reopened.post(url, headers=CONTENT_AUTH, json=body).json() == receipt.json()
    assert (project.course_root / "lesson.md").read_text() == "# Human revision\n"


def test_scaffold_and_add_cell_through_file_api(project, content_api):
    def edit(path, action, operation):
        snapshot = content_api.get("/api/author/content", params={"path": path}, headers=CONTENT_AUTH).json()
        response = content_api.post("/api/author/changes", headers=CONTENT_AUTH, json=edit_request(snapshot, action))
        assert response.status_code == 201, response.text
        change = response.json()
        assert content_api.post(f"/api/author/changes/{change['change_id']}/apply", headers=CONTENT_AUTH, json={
            "reviewed_revision": change["revision"], "context_digest": change["context_digest"], "operation_id": operation}).status_code == 200
    edit("new.ipynb", {"kind": "notebook_scaffold", "title": "Data validation"}, "scaffold")
    original = json.loads((project.course_root / "new.ipynb").read_text())
    assert len(original["cells"]) == 2
    edit("new.ipynb", {"kind": "notebook_add_cell", "cell_type": "code", "source": "assert True\n"}, "new-cell")
    notebook = json.loads((project.course_root / "new.ipynb").read_text())
    assert notebook["cells"][:2] == original["cells"]
    assert notebook["cells"][2]["id"] not in {c["id"] for c in original["cells"]}
    assert notebook["cells"][2]["outputs"] == []


def test_explicit_asset_import_is_reviewed_and_records_provenance_without_execution(project, content_api):
    from courseweave.author.project import read_sources
    replacement = project.course_root.parent.parent / "replacement.py"
    replacement.write_text("raise RuntimeError('must never execute')\n")
    before = (project.course_root / "script.py").read_bytes()
    snapshot = content_api.get("/api/author/content?path=script.py", headers=CONTENT_AUTH).json()
    response = content_api.post("/api/author/changes", headers=CONTENT_AUTH, json=edit_request(snapshot,
        {"kind": "import_replace", "source_path": str(replacement)}))
    assert response.status_code == 201, response.text
    assert (project.course_root / "script.py").read_bytes() == before
    imported = [s for s in read_sources(project) if s.origin == str(replacement)]
    assert len(imported) == 1
    assert imported[0].status == "candidate" and imported[0].redistribution == "undecided"
    change = response.json()
    assert content_api.post(f"/api/author/changes/{change['change_id']}/reject",
        headers=CONTENT_AUTH, json={"reviewed_revision": change["revision"]}).status_code == 200
    assert (project.course_root / "script.py").read_bytes() == before


def test_notebook_invalid_output_is_structural_error_without_silent_repair():
    from courseweave.author.content import assemble_notebook, ContentError
    notebook = deepcopy(NOTEBOOK)
    notebook["cells"][1]["outputs"] = [{"output_type": "invented", "text": "bad"}]
    with pytest.raises(ContentError):
        assemble_notebook(notebook, {})


def test_partial_write_failure_invalidates_other_project_candidates(project, monkeypatch):
    from courseweave.author import content
    context = context_for(project)
    other_context = context_for(project, "new.md")
    first = content.stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Written then failed"))
    other = content.stage_change(project, other_context, MarkdownDraft(kind="markdown_replace", text="Old project context"))
    replace = content._replace
    def late_failure(project, change):
        replace(project, change)
        raise OSError("injected late failure")
    monkeypatch.setattr(content, "_replace", late_failure)
    with pytest.raises(content.ContentError):
        content.apply_change(project, first.change_id, 0, "first-fails-late", context_digest=context.digest)
    monkeypatch.setattr(content, "_replace", replace)
    with pytest.raises(content.ContentError, match="Project changed"):
        content.apply_change(project, other.change_id, 0, "other-after-failure", context_digest=other_context.digest)
    assert not (project.course_root / "new.md").exists()


def test_recovery_exposes_a_symlink_substitution_as_conflict(project):
    from courseweave.author import content
    context = context_for(project)
    change = content.stage_change(project, context, MarkdownDraft(kind="markdown_replace", text="Candidate"))
    def crash(phase):
        if phase == "after_replace":
            raise InterruptedApply()
    with pytest.raises(InterruptedApply):
        content.apply_change(project, change.change_id, 0, "symlink-recovery", context_digest=context.digest, crash_hook=crash)
    target = project.course_root / "lesson.md"
    target.unlink()
    original = project.course_root.parent.parent / "source/lesson.md"
    target.symlink_to(original)
    content.recover_changes(project)
    assert content.read_change(project, change.change_id).status == "conflict"
    assert original.read_text().startswith("# Original")


def test_private_targets_and_nontext_markdown_replacements_are_denied(project, content_api):
    from courseweave.author.content import read_content, ContentError
    for path in ("credentials.json", "new.env", "build/generated.md", "courseweave.db"):
        with pytest.raises(ContentError):
            read_content(project, path)
    binary = project.course_root.parent.parent / "binary.dat"
    binary.write_bytes(b"\xff\0binary")
    snapshot = content_api.get("/api/author/content?path=lesson.md", headers=CONTENT_AUTH).json()
    result = content_api.post("/api/author/changes", headers=CONTENT_AUTH, json=edit_request(snapshot,
        {"kind": "import_replace", "source_path": str(binary)}))
    assert result.status_code == 409
    assert (project.course_root / "lesson.md").read_text().startswith("# Original")


def test_corrupt_external_manifest_remains_a_visible_journal_conflict(project):
    from courseweave.author import content
    context = context_for(project, "courseweave.json")
    manifest = json.loads((project.course_root / "courseweave.json").read_text())
    manifest.pop("modules")
    change = content.stage_change(project, context, ManifestFragmentDraft(
        kind="manifest_fragment_replace", value={**manifest, "title": "Before interruption"}))
    def crash(phase):
        if phase == "after_replace":
            raise InterruptedApply()
    with pytest.raises(InterruptedApply):
        content.apply_change(project, change.change_id, 0, "manifest-interrupted", context_digest=context.digest, crash_hook=crash)
    (project.course_root / "courseweave.json").write_text("External incomplete JSON")
    content.recover_changes(project)
    assert content.read_change(project, change.change_id).status == "conflict"
    assert (project.course_root / "courseweave.json").read_text() == "External incomplete JSON"


@pytest.mark.parametrize("unit", ["module", "phase", "learning"])
def test_selected_manifest_fragment_composes_without_changing_other_nodes(project, unit):
    from courseweave.author.content import stage_change, apply_change
    from courseweave.manifest import parse_manifest_data, manifest_etag
    from test_author_api import manifest as fixture_manifest
    data = fixture_manifest()
    data["id"] = "course"
    data["modules"].append({**deepcopy(data["modules"][0]), "id": "untouched-module"})
    path = project.course_root / "courseweave.json"
    save_manifest(project.course_root, parse_manifest_data(data, project.course_root), if_match=manifest_etag(path.read_bytes()))
    original = json.loads(path.read_text())
    context = context_for(project, "courseweave.json", unit=unit, module="module-one",
        phase="read-one" if unit != "module" else None)
    if unit == "module":
        value = {**original["modules"][0], "title": "Revised module"}
    elif unit == "phase":
        value = {**original["modules"][0]["phases"][0], "title": "Revised phase"}
    else:
        value = {"objectives": [{"id": "predict", "text": "Distinguish a prediction from an observation."}]}
    change = stage_change(project, context, ManifestFragmentDraft(kind="manifest_fragment_replace", value=value))
    apply_change(project, change.change_id, 0, "fragment-" + unit, context_digest=context.digest)
    saved = json.loads(path.read_text())
    assert saved["id"] == "course"
    assert saved["modules"][1] == original["modules"][1]
    assert saved["modules"][0]["id"] == "module-one"
    assert saved["modules"][0]["phases"][0]["id"] == "read-one"
    if unit == "learning":
        assert saved["modules"][0]["phases"][0]["learning"]["objectives"] == value["objectives"]
    elif unit == "phase":
        assert saved["modules"][0]["phases"][0]["title"] == value["title"]
    else:
        assert saved["modules"][0]["title"] == value["title"]


def test_missing_asset_is_valid_draft_but_visible_readiness_failure(project):
    from courseweave.author.content import stage_change
    from test_author_api import manifest as fixture_manifest
    candidate = fixture_manifest()
    candidate["id"] = "course"
    (project.course_root / "courseweave.json").write_text(json.dumps(candidate))
    candidate["modules"][0]["phases"][0]["surfaces"][0]["path"] = "future.md"
    module = candidate["modules"][0]
    change = stage_change(project, context_for(project, "courseweave.json", unit="module", module=module["id"]),
        ManifestFragmentDraft(kind="manifest_fragment_replace", value=module))
    assert change.status == "pending"
    assert any(issue.code == "draft_not_runnable" for issue in change.issues)
