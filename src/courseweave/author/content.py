"""Reviewed one-file author changes; the course store's lock is authoritative.

Candidate bytes and backups are immutable. A small adjacent journal records
the filesystem boundary, without adding another course/progress state engine.
No method executes a notebook or writes to an import origin/student home.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import ConfigDict, Field, TypeAdapter

from ..contracts.models import ClosedModel, Slug
from ..contracts.primitives import LocalPath, local_path
from ..manifest import (
    ManifestError, manifest_bytes, parse_manifest_bytes, parse_manifest_data,
    save_manifest, validate_runnable,
)
from ..store import CourseStore
from .contracts import (
    ApplyReceipt, AuthorContext, AuthorProject, AuthorSelection, ChangeDraft,
    ManifestFragmentDraft, MarkdownDraft, NotebookCellsDraft, PendingChange,
    Revision, Sha256, SourceRevision, ValidationIssue,
    Text,
)
from .project import (
    ProjectError, atomic_bytes, atomic_json, excluded_path, import_resource, local_directory, open_project, read_private, read_sources,
)

MAX_CONTENT_BYTES = 8 * 1024 * 1024
MAX_CHANGES = 1000
MAX_OPERATIONS = 10_000
_CELL_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class ContentError(ProjectError):
    """A reviewed change cannot safely proceed; retain the author's local work."""


class ChangeBasis(ClosedModel):
    """Saved dependencies only; conversation and provider prompts are not durable."""
    selection: AuthorSelection
    project_revision: Revision
    manifest_sha256: Sha256
    context_digest: Sha256
    sources: tuple[SourceRevision, ...] = Field(default=(), max_length=32)
    origin: Literal["assistant", "manual"]


class _SavedChange(ClosedModel):
    model_config = ConfigDict(ser_json_bytes="base64", val_json_bytes="base64")
    change: PendingChange
    before_bytes: bytes = Field(max_length=MAX_CONTENT_BYTES)
    basis: ChangeBasis


class NotebookScaffold(ClosedModel):
    kind: Literal["notebook_scaffold"]
    title: str = Field(min_length=1, max_length=200)


class AddNotebookCell(ClosedModel):
    kind: Literal["notebook_add_cell"]
    cell_type: Literal["markdown", "code"]
    source: Text


class ImportReplacement(ClosedModel):
    kind: Literal["import_replace"]
    source_path: Path


class ContentEdit(ClosedModel):
    path: LocalPath
    before_sha256: Sha256
    before_exists: bool
    project_revision: Revision
    manifest_sha256: Sha256
    action: Annotated[MarkdownDraft | NotebookCellsDraft | NotebookScaffold | AddNotebookCell | ImportReplacement,
                      Field(discriminator="kind")]


class _ChangeStatus(ClosedModel):
    status: Literal["pending", "rejected", "stale", "prepared", "applied", "conflict", "failed"]


class _Operation(ClosedModel):
    operation_id: Slug
    change_id: Slug
    reviewed_revision: Revision
    context_digest: Sha256
    status: Literal["prepared", "applied", "failed", "conflict"]
    receipt: ApplyReceipt | None = None


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()


def _id(value: str) -> str:
    try:
        return TypeAdapter(Slug).validate_python(value)
    except ValueError:
        raise ContentError("Invalid change or operation ID.") from None


def _target_path(value: str) -> str:
    try:
        local_path(value)
    except ValueError:
        raise ContentError("Choose a relative file inside the selected course.") from None
    # Private files are never content targets, even through a direct edit.
    if excluded_path(value):
        raise ContentError("Private paths cannot be author content targets.")
    return value


def _read_target(project: AuthorProject, relative: str) -> tuple[bool, bytes]:
    relative = _target_path(relative)
    path = project.course_root / relative
    # Walk parents without following links. Missing parents mean an absent file.
    cursor = project.course_root
    with local_directory(cursor):
        pass
    for part in Path(relative).parts[:-1]:
        cursor /= part
        if not cursor.exists() and not cursor.is_symlink():
            return False, b""
        with local_directory(cursor):
            pass
    with local_directory(path.parent) as parent:
        return _read_at(parent, path.name)


def _read_at(parent: int, name: str) -> tuple[bool, bytes]:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return False, b""
    except OSError:
        raise ContentError("Selected file is unavailable or is a symlink.") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ContentError("Selected target must be an ordinary file.")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(MAX_CONTENT_BYTES + 1)
        if len(data) > MAX_CONTENT_BYTES:
            raise ContentError("Content file exceeds the 8 MiB limit.")
        return True, data
    finally:
        os.close(fd)


def _lock(project: AuthorProject):
    # Exactly the same root/state directory as the project dispatcher.
    open_project(project.course_root.parent)
    for relative in ("transactions", "locks"):
        with local_directory(project.state_root / relative, create=True):
            pass
    return CourseStore.author_project_lock(project.course_root, project.state_root / "transactions")


def _entries(project: AuthorProject, directory: str, limit: int) -> list[str]:
    with local_directory(project.state_root / directory, create=True) as fd:
        entries = []
        with os.scandir(fd) as iterator:
            for index, entry in enumerate(iterator):
                if index >= limit:
                    raise ContentError(f"Saved {directory} limit reached; archive this project before continuing.")
                if entry.name.startswith("."):
                    continue  # An interrupted unpublished atomic write has no authority.
                entries.append(entry.name)
        return sorted(entries)


def _saved(project: AuthorProject, change_id: str, *, with_bytes=True) -> _SavedChange:
    change_id = _id(change_id)
    try:
        raw = json.loads(read_private(project.state_root, f"changes/{change_id}/candidate.json", max_bytes=1024 * 1024))
        before = read_private(project.state_root, f"changes/{change_id}/before", max_bytes=MAX_CONTENT_BYTES) if with_bytes else b""
        after = read_private(project.state_root, f"changes/{change_id}/after", max_bytes=MAX_CONTENT_BYTES) if with_bytes else b""
        saved = _SavedChange.model_validate({**raw, "before_bytes": before, "change": {**raw["change"], "after_bytes": after}})
        status = _ChangeStatus.model_validate_json(read_private(
            project.state_root, f"changes/{change_id}/status.json", max_bytes=1024))
        change = saved.change
        if (change.change_id != change_id or change.project_id != project.project_id
                or (with_bytes and (_hash(saved.before_bytes) != change.before_sha256
                                    or _hash(change.after_bytes) != change.after_sha256))
                or change.context_digest != saved.basis.context_digest):
            raise ValueError()
        return saved.model_copy(update={"change": change.model_copy(update={"status": status.status})})
    except (ValueError, OSError, KeyError, TypeError):
        raise ContentError("Saved change is missing or corrupt; restore a verified backup.") from None


def _status(project: AuthorProject, change_id: str, status: str) -> None:
    value = _ChangeStatus(status=status)
    atomic_json(project.state_root / "changes" / change_id / "status.json", value.model_dump(), replace=True)


def _operation(project: AuthorProject, operation_id: str) -> _Operation | None:
    operation_id = _id(operation_id)
    path = project.state_root / "operations" / f"{operation_id}.json"
    if not path.exists() and not path.is_symlink():
        return None
    try:
        operation = _Operation.model_validate_json(read_private(
            project.state_root, f"operations/{operation_id}.json", max_bytes=16_384))
        if operation.operation_id != operation_id:
            raise ValueError()
        return operation
    except (ValueError, OSError):
        raise ContentError("Apply journal is corrupt; restore a verified backup.") from None


def _save_operation(project: AuthorProject, operation: _Operation, *, replace=True):
    atomic_json(project.state_root / "operations" / f"{operation.operation_id}.json",
                operation.model_dump(mode="json"), replace=replace)


def _advance_project(project: AuthorProject, basis: ChangeBasis) -> None:
    current = open_project(project.course_root.parent)
    if current.revision == basis.project_revision:
        atomic_json(project.state_root / "project.json",
                    current.model_copy(update={"revision": current.revision + 1}).model_dump(mode="json"), replace=True)
    elif current.revision != basis.project_revision + 1:
        raise ContentError("Project revision cannot be reconciled; inspect the saved files before continuing.")


def _finish(project: AuthorProject, saved: _SavedChange, operation: _Operation) -> ApplyReceipt:
    change = saved.change
    _advance_project(project, saved.basis)
    receipt = ApplyReceipt(operation_id=operation.operation_id, change_id=change.change_id,
        project_id=project.project_id, revision=change.revision, target_path=change.target_path,
        before_sha256=change.before_sha256, after_sha256=change.after_sha256, applied_at=datetime.now(timezone.utc))
    _status(project, change.change_id, "applied")
    _save_operation(project, operation.model_copy(update={"status": "applied", "receipt": receipt}))
    return receipt


def _recover(project: AuthorProject) -> None:
    for name in _entries(project, "operations", MAX_OPERATIONS):
        if not name.endswith(".json"):
            raise ContentError("Unrecognized apply journal entry.")
        operation = _operation(project, name[:-5])
        if operation is None or operation.status != "prepared":
            continue
        saved = _saved(project, operation.change_id)
        change = saved.change
        try:
            exists, raw = _read_target(project, change.target_path)
        except ContentError:
            _status(project, change.change_id, "conflict")
            _save_operation(project, operation.model_copy(update={"status": "conflict"}))
            continue
        if exists and _hash(raw) == change.after_sha256:
            _finish(project, saved, operation)
        elif exists == change.before_exists and _hash(raw) == change.before_sha256:
            _status(project, change.change_id, "pending")
            _save_operation(project, operation.model_copy(update={"status": "failed"}))
        else:
            _status(project, change.change_id, "conflict")
            _save_operation(project, operation.model_copy(update={"status": "conflict"}))


def recover_changes(project: AuthorProject) -> None:
    with _lock(project):
        _recover(project)


def read_change(project: AuthorProject, change_id: str) -> PendingChange:
    with _lock(project):
        _recover(project)
        return _saved(project, change_id).change


def list_changes(project: AuthorProject, *, offset=0, limit=20) -> dict:
    if offset < 0 or not 1 <= limit <= 20:
        raise ContentError("Invalid saved-change page.")
    with _lock(project):
        _recover(project)
        names = _entries(project, "changes", MAX_CHANGES)
        # candidate.json is published last; interrupted unpublished staging
        # directories contain no reviewable candidate and have no authority.
        names = [name for name in names if (project.state_root / "changes" / name / "candidate.json").exists()]
        return {"changes": [_saved(project, name, with_bytes=False).change.model_dump(mode="json", exclude={"after_bytes"})
                            for name in names[offset:offset + limit]], "total": len(names)}


def _check_basis(project: AuthorProject, basis: ChangeBasis, registered_id: str | None) -> None:
    current = open_project(project.course_root.parent)
    selection = basis.selection
    if current.revision != basis.project_revision or selection.project_id != project.project_id:
        raise ContentError("Project changed; reload and review a new candidate.")
    exists, manifest_raw = _read_target(project, "courseweave.json")
    if not exists or _hash(manifest_raw) != basis.manifest_sha256:
        raise ContentError("Saved manifest changed; reload and review a new candidate.")
    manifest = parse_manifest_bytes(manifest_raw, project.course_root)
    if manifest.id != selection.course_id or (registered_id is not None and registered_id != manifest.id):
        raise ContentError("Selected course identity changed.")
    records = {r.source_id: r for r in read_sources(project)}
    for source in basis.sources:
        current_source = records.get(source.source_id)
        if (current_source is None or current_source.status != "approved"
                or any(getattr(current_source, key) != value for key, value in source.model_dump().items())):
            raise ContentError("A permitted source changed or was revoked; request a new candidate.")


def _validate_notebook(notebook: dict) -> None:
    if not isinstance(notebook, dict) or not isinstance(notebook.get("cells"), list) or len(notebook["cells"]) > 10_000:
        raise ContentError("Notebook must contain a bounded cell list.")
    ids = []
    for cell in notebook["cells"]:
        cell_id = cell.get("id") if isinstance(cell, dict) else None
        if not isinstance(cell_id, str) or not _CELL_ID.fullmatch(cell_id):
            raise ContentError("Every existing cell needs a valid stable ID; IDs are never silently repaired.")
        ids.append(cell_id)
    if len(set(ids)) != len(ids):
        raise ContentError("Notebook cell IDs must be unique.")
    try:
        import nbformat  # Jupyter's existing validator; no notebook execution.
    except ImportError:
        raise ContentError("The notebook runtime is unavailable.") from None
    try:
        nbformat.validate(deepcopy(notebook), version=4, version_minor=5)
    except (nbformat.ValidationError, ValueError, TypeError) as exc:
        raise ContentError("Notebook structure is invalid.") from exc


def assemble_notebook(original: dict, replace_sources: dict[str, str], *, new_cells=()) -> dict:
    _validate_notebook(original)
    candidate = deepcopy(original)
    known = {cell["id"] for cell in candidate["cells"]}
    if not set(replace_sources).issubset(known):
        raise ContentError("A selected notebook cell no longer exists.")
    for cell in candidate["cells"]:
        if cell["id"] in replace_sources:
            source = replace_sources[cell["id"]]
            if not isinstance(source, str):
                raise ContentError("Notebook cell source must be text.")
            cell["source"] = source.splitlines(keepends=True)
    for supplied in new_cells:
        if (not isinstance(supplied, dict) or set(supplied) != {"cell_type", "source"}
                or supplied["cell_type"] not in {"markdown", "code"} or not isinstance(supplied["source"], str)):
            raise ContentError("New cells accept only a cell type and source; IDs are assigned by Author.")
        cell = {"id": uuid4().hex, "cell_type": supplied["cell_type"], "metadata": {},
                "source": supplied["source"].splitlines(keepends=True)}
        if cell["cell_type"] == "code":
            cell.update(outputs=[], execution_count=None)
        candidate["cells"].append(cell)
    _validate_notebook(candidate)
    return candidate


def output_free_notebook(original: dict) -> dict:
    _validate_notebook(original)
    candidate = deepcopy(original)
    for cell in candidate["cells"]:
        if cell["cell_type"] == "code":
            cell["outputs"] = []
            cell["execution_count"] = None
    return candidate


def _compose_manifest(project: AuthorProject, selection: AuthorSelection, value: dict) -> bytes:
    _, raw = _read_target(project, "courseweave.json")
    candidate = json.loads(raw)
    if selection.manifest_unit == "course":
        if value.get("id") != candidate["id"]:
            raise ContentError("The saved course ID must be preserved.")
        candidate = deepcopy(value)
    else:
        module = next((m for m in candidate["modules"] if m["id"] == selection.module_id), None)
        if module is None:
            raise ContentError("Select an existing module before editing this fragment.")
        if selection.manifest_unit == "module":
            if value.get("id") != module["id"]:
                raise ContentError("The selected module ID must be preserved.")
            candidate["modules"][candidate["modules"].index(module)] = deepcopy(value)
        else:
            phase = next((p for p in module["phases"] if p["id"] == selection.phase_id), None)
            if phase is None:
                raise ContentError("Select an existing phase before editing this fragment.")
            if selection.manifest_unit == "phase":
                if value.get("id") != phase["id"]:
                    raise ContentError("The selected phase ID must be preserved.")
                module["phases"][module["phases"].index(phase)] = deepcopy(value)
            else:
                phase["learning"] = deepcopy(value)
    return manifest_bytes(parse_manifest_data(candidate, project.course_root))


def _readiness(project: AuthorProject, target: str, after: bytes) -> tuple[ValidationIssue, ...]:
    if target == "courseweave.json":
        try:
            validate_runnable(parse_manifest_bytes(after, project.course_root), project.course_root)
        except ManifestError as exc:
            return (ValidationIssue(code="draft_not_runnable", location=target,
                    message=str(exc)[:2000], severity="warning"),)
    return (ValidationIssue(code="package_readiness_unchecked", location=target,
            message="Structure is valid. Run compatibility and package checks before export.",
            severity="not_performed"),)


def _stage(project: AuthorProject, basis: ChangeBasis, target: str, before: bytes, exists: bool, after: bytes) -> PendingChange:
    if len(after) > MAX_CONTENT_BYTES:
        raise ContentError("Candidate exceeds the 8 MiB file limit.")
    if exists and after == before:
        raise ContentError("The candidate has no byte changes.")
    if len(_entries(project, "changes", MAX_CHANGES)) >= MAX_CHANGES:
        raise ContentError("Saved change limit reached; archive this project before continuing.")
    change = PendingChange(change_id=f"change-{uuid4().hex}", project_id=project.project_id,
        revision=0, target_path=target, before_sha256=_hash(before), before_exists=exists,
        after_sha256=_hash(after), after_bytes=after, context_digest=basis.context_digest,
        status="pending", sources=basis.sources, issues=_readiness(project, target, after))
    saved = _SavedChange(change=change, before_bytes=before, basis=basis)
    directory = project.state_root / "changes" / change.change_id
    atomic_bytes(directory / "before", before)
    atomic_bytes(directory / "after", after)
    atomic_json(directory / "status.json", {"status": "pending"})
    atomic_json(directory / "candidate.json", saved.model_dump(mode="json",
                exclude={"before_bytes": True, "change": {"after_bytes"}}))
    return change


def stage_change(project: AuthorProject, context: AuthorContext, draft: ChangeDraft) -> PendingChange:
    """Only the server constructs context; a model cannot set paths or authority."""
    try:
        draft = TypeAdapter(ChangeDraft).validate_python(draft)
        basis = ChangeBasis(selection=context.selection, project_revision=context.project_revision,
            manifest_sha256=context.manifest_sha256, context_digest=context.digest,
            sources=context.sources, origin="assistant")
        with _lock(project) as registered_id:
            _recover(project)
            _check_basis(project, basis, registered_id)
            target = context.target_path
            if target != context.selection.file_path:
                raise ContentError("Candidate target differs from the explicit file selection.")
            exists, before = _read_target(project, target)
            if exists != context.target_exists or _hash(before) != context.target_sha256:
                raise ContentError("Selected file changed; request a new candidate.")
            if isinstance(draft, ManifestFragmentDraft):
                if target != "courseweave.json":
                    raise ContentError("Manifest edits require the selected manifest target.")
                after = _compose_manifest(project, context.selection, draft.value)
            elif isinstance(draft, MarkdownDraft):
                if Path(target).suffix.lower() != ".md":
                    raise ContentError("Assistant text edits may target only a selected Markdown file.")
                after = draft.text.encode("utf-8")
            elif isinstance(draft, NotebookCellsDraft):
                if (Path(target).suffix.lower() != ".ipynb" or not exists
                        or not set(draft.replace_sources).issubset(context.selection.cell_ids)):
                    raise ContentError("Select the existing notebook and each named cell before requesting an edit.")
                after = _json_bytes(output_free_notebook(assemble_notebook(json.loads(before), draft.replace_sources)))
            return _stage(project, basis, target, before, exists, after)
    except (ManifestError, ValueError) as exc:
        if isinstance(exc, ContentError):
            raise
        raise ContentError("Candidate is invalid; repair it before review.") from exc


def read_content(project: AuthorProject, path: str) -> dict:
    with _lock(project):
        _recover(project)
        current = open_project(project.course_root.parent)
        manifest_exists, manifest_raw = _read_target(project, "courseweave.json")
        if not manifest_exists:
            raise ContentError("Save the initial course manifest before editing lesson files.")
        exists, raw = _read_target(project, path)
        kind = "markdown" if Path(path).suffix.lower() == ".md" else "notebook" if Path(path).suffix.lower() == ".ipynb" else "asset"
        result = {"path": path, "exists": exists, "sha256": _hash(raw), "size": len(raw), "kind": kind,
                  "project_revision": current.revision, "manifest_sha256": _hash(manifest_raw)}
        try:
            if kind == "markdown":
                result["text"] = raw.decode("utf-8")
            elif kind == "notebook" and exists:
                notebook = json.loads(raw)
                _validate_notebook(notebook)
                result["notebook"] = notebook
        except (ValueError, UnicodeError):
            raise ContentError("Selected content cannot be edited structurally; use a reviewed imported replacement.") from None
        return result


def stage_manual_change(project: AuthorProject, request: ContentEdit) -> PendingChange:
    """Direct human selection supplies the path; model drafts cannot call this."""
    with _lock(project) as registered_id:
        _recover(project)
        target = _target_path(request.path)
        if target == "courseweave.json":
            raise ContentError("Use the course manifest editor for a direct manifest save.")
        _, manifest_raw = _read_target(project, "courseweave.json")
        try:
            manifest = parse_manifest_bytes(manifest_raw, project.course_root)
        except ManifestError:
            raise ContentError("Save a valid course manifest before editing lesson files.") from None
        exists, before = _read_target(project, target)
        action = request.action
        cells = tuple(action.replace_sources) if isinstance(action, NotebookCellsDraft) else ()
        selection = AuthorSelection(project_id=project.project_id, course_id=manifest.id, file_path=target, cell_ids=cells)
        # This fingerprint has no model/provider data. It identifies the saved
        # human edit basis and is returned with the exact immutable review.
        basis = ChangeBasis(selection=selection, project_revision=request.project_revision,
            manifest_sha256=request.manifest_sha256, context_digest=_hash(_json_bytes({
                **selection.model_dump(mode="json"), "project_revision": request.project_revision,
                "manifest_sha256": request.manifest_sha256, "before_sha256": request.before_sha256,
                "before_exists": request.before_exists, "origin": "manual"})), origin="manual")
        _check_basis(project, basis, registered_id)
        if exists != request.before_exists or _hash(before) != request.before_sha256:
            raise ContentError("File changed; keep your local edit and reload the saved file.")
        try:
            if isinstance(action, MarkdownDraft):
                if Path(target).suffix.lower() != ".md":
                    raise ContentError("Text editing requires a Markdown file.")
                after = action.text.encode("utf-8")
            elif isinstance(action, ImportReplacement):
                resource = import_resource(project, action.source_path)
                after = read_private(project.state_root, resource.snapshot_path, max_bytes=MAX_CONTENT_BYTES)
                if Path(target).suffix.lower() == ".ipynb":
                    after = _json_bytes(output_free_notebook(json.loads(after)))
                elif Path(target).suffix.lower() == ".md":
                    after.decode("utf-8")
                    if b"\0" in after:
                        raise ContentError("Markdown replacement must be UTF-8 text without null bytes.")
            else:
                if Path(target).suffix.lower() != ".ipynb":
                    raise ContentError("Notebook actions require an .ipynb file.")
                if isinstance(action, NotebookScaffold):
                    if exists:
                        raise ContentError("A scaffold can only create a new notebook.")
                    notebook = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []}
                    notebook = assemble_notebook(notebook, {}, new_cells=[
                        {"cell_type": "markdown", "source": f"# {action.title}\n\nWrite your prediction before running the example.\n"},
                        {"cell_type": "code", "source": "# Add the exercise here.\n"}])
                else:
                    if not exists:
                        raise ContentError("Select an existing notebook before editing its cells.")
                    notebook = assemble_notebook(json.loads(before),
                        action.replace_sources if isinstance(action, NotebookCellsDraft) else {},
                        new_cells=[{"cell_type": action.cell_type, "source": action.source}] if isinstance(action, AddNotebookCell) else [])
                after = _json_bytes(output_free_notebook(notebook))
            return _stage(project, basis, target, before, exists, after)
        except (ValueError, ManifestError) as exc:
            if isinstance(exc, ContentError):
                raise
            raise ContentError("Content is invalid; repair it before review.") from exc


def change_diff(project: AuthorProject, change_id: str) -> str:
    saved = _saved(project, change_id)
    try:
        before = saved.before_bytes.decode("utf-8")
        after = saved.change.after_bytes.decode("utf-8")
    except UnicodeError:
        return (f"Binary replacement: {saved.change.target_path}\n"
                f"Before: {len(saved.before_bytes)} bytes, SHA-256 {saved.change.before_sha256}\n"
                f"After: {len(saved.change.after_bytes)} bytes, SHA-256 {saved.change.after_sha256}")
    # Keep final-newline changes explicit; splitlines alone would hide them.
    lines = list(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile=saved.change.target_path if saved.change.before_exists else "/dev/null",
        tofile=saved.change.target_path))
    return "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n" for line in lines)


def reject_change(project: AuthorProject, change_id: str, reviewed_revision: int) -> PendingChange:
    with _lock(project):
        _recover(project)
        change = _saved(project, change_id).change
        if change.revision != reviewed_revision or change.status not in {"pending", "stale", "conflict", "failed"}:
            raise ContentError("This revision cannot be rejected; reload saved changes.")
        _status(project, change.change_id, "rejected")
        return change.model_copy(update={"status": "rejected"})


def _replace(project: AuthorProject, change: PendingChange) -> None:
    target = project.course_root / _target_path(change.target_path)
    with local_directory(target.parent, create=True) as parent:
        exists, raw = _read_at(parent, target.name)
        if exists != change.before_exists or _hash(raw) != change.before_sha256:
            raise ContentError("Target changed immediately before replacement.")
        if change.target_path == "courseweave.json":
            manifest = parse_manifest_bytes(change.after_bytes, project.course_root)
            if manifest_bytes(manifest) != change.after_bytes:
                raise ContentError("Candidate manifest bytes are no longer canonical.")
            save_manifest(project.course_root, manifest,
                          if_match=f'"{change.before_sha256}"' if exists else '""', directory_fd=parent)
            return
        temporary = f".content-{uuid4().hex}"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(change.after_bytes)
                stream.flush()
                os.fsync(stream.fileno())
            # Check again after writing the temporary file, before its atomic rename.
            current_exists, current = _read_at(parent, target.name)
            if current_exists != exists or _hash(current) != change.before_sha256:
                raise ContentError("Target changed while preparing the replacement.")
            if exists:
                os.replace(temporary, target.name, src_dir_fd=parent, dst_dir_fd=parent)
            else:
                os.link(temporary, target.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def apply_change(project: AuthorProject, change_id: str, reviewed_revision: int, operation_id: str,
                 *, context_digest: str, crash_hook=None) -> ApplyReceipt:
    operation_id = _id(operation_id)
    with _lock(project) as registered_id:
        _recover(project)
        operation = _operation(project, operation_id)
        if operation is not None:
            if (operation.change_id != change_id or operation.reviewed_revision != reviewed_revision
                    or operation.context_digest != context_digest):
                raise ContentError("Operation ID was already used for a different reviewed change.")
            if operation.status == "applied" and operation.receipt is not None:
                return operation.receipt
            raise ContentError("This operation did not apply. Review current files before a new explicit attempt.")
        saved = _saved(project, change_id)
        change = saved.change
        if change.status != "pending" or reviewed_revision != change.revision or context_digest != change.context_digest:
            raise ContentError("Review the exact current pending revision before applying it.")
        try:
            _check_basis(project, saved.basis, registered_id)
            exists, raw = _read_target(project, change.target_path)
            if exists != change.before_exists or _hash(raw) != change.before_sha256:
                raise ContentError("Target changed; retain your draft and review the saved file.")
        except ContentError:
            _status(project, change_id, "stale")
            raise
        if len(_entries(project, "operations", MAX_OPERATIONS)) >= MAX_OPERATIONS:
            raise ContentError("Apply journal limit reached; archive this project before continuing.")
        operation = _Operation(operation_id=operation_id, change_id=change_id,
            reviewed_revision=reviewed_revision, context_digest=context_digest, status="prepared")
        _save_operation(project, operation, replace=False)
        try:
            _status(project, change_id, "prepared")
            if crash_hook:
                crash_hook("after_prepare")
            _replace(project, change)
            if crash_hook:
                crash_hook("after_replace")
                crash_hook("before_receipt")
            return _finish(project, saved, operation)
        except Exception as exc:
            # Ordinary reported errors are terminal for this operation, even if
            # a late fsync failed after rename. Restart cannot turn it into success.
            _save_operation(project, operation.model_copy(update={"status": "failed"}))
            _status(project, change_id, "failed")
            try:
                exists, raw = _read_target(project, change.target_path)
                changed = exists != change.before_exists or _hash(raw) != change.before_sha256
            except ContentError:
                changed = True
            if changed:
                _advance_project(project, saved.basis)
            raise ContentError("Apply failed. Inspect the saved file and retained candidate before continuing.") from exc
