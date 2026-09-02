"""Normative manifest parsing, path validation, deterministic bytes, and CAS."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError as JSONSchemaValidationError
from pydantic import ValidationError as PydanticValidationError

from courseweave.models import (
    ArtifactCompletion,
    CourseManifest,
    HtmlSurface,
    MarkdownSurface,
    NotebookSurface,
    SourceSurface,
    TerminalSurface,
    VideoSurface,
)

MANIFEST_NAME = "courseweave.json"
_LFS_HEADER = b"version https://git-lfs.github.com/spec/v1\n"


class ManifestError(Exception):
    """Base class for manifest boundary errors."""


class ManifestValidationError(ManifestError):
    """The manifest is malformed, structurally invalid, or not runnable."""

    def __init__(self, message: str, *, issues: list[dict[str, str]] | None = None) -> None:
        # The exception remains usable by the CLI and existing callers, while the
        # HTTP boundary can expose only the deliberately redacted issue shape.
        super().__init__(message)
        self.issues = issues or []


class ManifestNotFoundError(ManifestError):
    """No saved manifest exists in the course root."""


class ETagMismatchError(ManifestError):
    """A compare-and-swap manifest write used a stale exact-byte ETag."""


@dataclass(frozen=True)
class ManifestSnapshot:
    manifest: CourseManifest
    raw_bytes: bytes
    etag: str
    exists: bool = True


def _schema() -> dict[str, Any]:
    schema_path = files("courseweave").joinpath("courseweave.schema.json")
    return json.loads(schema_path.read_text(encoding="utf-8"))


_SCHEMA_VALIDATOR = Draft202012Validator(_schema(), format_checker=FormatChecker())


def parse_manifest_data(
    data: object,
    course_root: Path,
    *,
    runnable: bool = False,
) -> CourseManifest:
    """Validate raw data against the normative JSON Schema and Pydantic rules."""

    schema_errors = list(_SCHEMA_VALIDATOR.iter_errors(data))
    if schema_errors:
        first_error = schema_errors[0]
        where = ".".join(str(part) for part in first_error.absolute_path)
        suffix = f" at {where}" if where else ""
        raise ManifestValidationError(
            f"JSON Schema validation failed{suffix}: {first_error.message}",
            issues=_schema_issues_from_errors(schema_errors),
        )
    try:
        manifest = CourseManifest.model_validate(data)
    except PydanticValidationError as exc:
        issues = [
            _issue(_pydantic_issue_path(data, error), "schema_validation", "The field is invalid.")
            for error in exc.errors()
        ]
        raise ManifestValidationError(str(exc), issues=issues) from exc
    validate_paths(manifest, course_root)
    if runnable:
        validate_runnable(manifest, course_root)
    return manifest


def parse_manifest_bytes(
    raw_bytes: bytes,
    course_root: Path,
    *,
    runnable: bool = False,
) -> CourseManifest:
    try:
        data = json.loads(raw_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestValidationError(f"Malformed JSON: {exc}") from exc
    return parse_manifest_data(data, course_root, runnable=runnable)


def load_manifest(course_root: Path, *, runnable: bool = False) -> CourseManifest:
    """Load a saved manifest, preserving the public design signature."""

    return read_manifest(course_root, runnable=runnable).manifest


def read_manifest(course_root: Path, *, runnable: bool = False) -> ManifestSnapshot:
    root = Path(course_root)
    path = root / MANIFEST_NAME
    try:
        raw_bytes = path.read_bytes()
    except FileNotFoundError as exc:
        raise ManifestNotFoundError(f"No {MANIFEST_NAME} exists in {root}") from exc
    manifest = parse_manifest_bytes(raw_bytes, root, runnable=runnable)
    return ManifestSnapshot(
        manifest=manifest,
        raw_bytes=raw_bytes,
        etag=manifest_etag(raw_bytes),
    )


def empty_manifest_draft(course_root: Path) -> CourseManifest:
    """Return a valid unsaved Author draft without touching the filesystem."""

    root = Path(course_root)
    raw_name = root.name.strip() or "untitled-course"
    slug = re.sub(r"[^a-z0-9]+", "-", raw_name.lower()).strip("-")
    if not slug:
        slug = "untitled-course"
    slug = slug[:80].rstrip("-") or "untitled-course"
    title = raw_name[:240] or "Untitled Course"
    return CourseManifest.model_validate(
        {
            "schema_version": 1,
            "id": slug,
            "title": title,
            "description": "",
            "entry_module_id": None,
            "policies": {
                "content_sharing": "explicit_only",
                "durable_mutation": "proposal_or_direct_student_action",
                "terminal_execution": "student_only",
                "conversation_memory": "session_only",
                "max_shared_chars": 8192,
                "workspace_write_globs": [],
            },
            "modules": [],
        }
    )


def manifest_bytes(manifest: CourseManifest) -> bytes:
    """Export one stable UTF-8 representation with a trailing newline."""

    dumped = manifest.model_dump(mode="json")
    data = {
        key: (
            value
            if key == "entry_module_id"
            else _without_optional_nones(value)
        )
        for key, value in dumped.items()
    }
    text = json.dumps(
        data,
        ensure_ascii=False,
        indent=2,
        separators=(",", ": "),
    )
    return f"{text}\n".encode("utf-8")


def manifest_etag(raw_bytes: bytes) -> str:
    """Return the quoted SHA-256 of the exact saved bytes."""

    return f'"{hashlib.sha256(raw_bytes).hexdigest()}"'


def save_manifest(
    course_root: Path,
    manifest: CourseManifest,
    *,
    if_match: str,
) -> ManifestSnapshot:
    """Atomically save canonical bytes if the exact existing-byte ETag matches."""

    root = Path(course_root)
    root.mkdir(parents=True, exist_ok=True)
    path = root / MANIFEST_NAME
    current = path.read_bytes() if path.exists() else None
    current_etag = manifest_etag(current) if current is not None else '""'
    if if_match != current_etag:
        raise ETagMismatchError(
            f"If-Match {if_match!r} does not match current ETag {current_etag!r}"
        )

    validate_paths(manifest, root)
    raw_bytes = manifest_bytes(manifest)
    fd, temp_name = tempfile.mkstemp(prefix=".courseweave.", suffix=".tmp", dir=root)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
    return ManifestSnapshot(
        manifest=manifest,
        raw_bytes=raw_bytes,
        etag=manifest_etag(raw_bytes),
    )


def validate_paths(manifest: CourseManifest, course_root: Path) -> None:
    """Resolve every local path and reject escapes, including symlink escapes."""

    root = Path(course_root).resolve()
    issues: list[dict[str, str]] = []
    messages: list[str] = []
    for module_index, module in enumerate(manifest.modules):
        for phase_index, phase in enumerate(module.phases):
            phase_path = f"/modules/{module_index}/phases/{phase_index}"
            for surface_index, surface in enumerate(phase.surfaces):
                surface_path = f"{phase_path}/surfaces/{surface_index}"
                if isinstance(
                    surface,
                    (HtmlSurface, MarkdownSurface, SourceSurface, NotebookSurface),
                ):
                    _collect_path_issue(
                        issues, root, surface.path, f"surface '{surface.id}'", f"{surface_path}/path", messages
                    )
                elif isinstance(surface, VideoSurface) and surface.path is not None:
                    _collect_path_issue(
                        issues, root, surface.path, f"surface '{surface.id}'", f"{surface_path}/path", messages
                    )
                elif isinstance(surface, TerminalSurface):
                    _collect_path_issue(
                        issues, root, surface.cwd, f"surface '{surface.id}' cwd", f"{surface_path}/cwd", messages
                    )
            if isinstance(phase.completion, ArtifactCompletion):
                _collect_path_issue(
                    issues, root, phase.completion.path,
                    f"completion '{phase.completion.record_id}'", f"{phase_path}/completion/path", messages,
                )
    _raise_collected_issues(issues, messages)


def validate_runnable(manifest: CourseManifest, course_root: Path) -> None:
    """Require ordinary local surfaces while allowing future completion artifacts."""

    root = Path(course_root).resolve()
    issues: list[dict[str, str]] = []
    messages: list[str] = []
    for module_index, module in enumerate(manifest.modules):
        for phase_index, phase in enumerate(module.phases):
            phase_path = f"/modules/{module_index}/phases/{phase_index}"
            for surface_index, surface in enumerate(phase.surfaces):
                surface_path = f"{phase_path}/surfaces/{surface_index}"
                if isinstance(
                    surface,
                    (HtmlSurface, MarkdownSurface, SourceSurface, NotebookSurface),
                ):
                    path = _resolved_or_collect(
                        issues, root, surface.path, f"surface '{surface.id}'", f"{surface_path}/path", messages
                    )
                    if path is None:
                        continue
                    if not path.exists():
                        issues.append(_issue(f"{surface_path}/path", "missing_artifact", "A required local surface is missing."))
                        messages.append(f"Runnable surface path is not an ordinary file: {surface.path}")
                    elif not path.is_file():
                        issues.append(_issue(f"{surface_path}/path", "wrong_artifact_type", "A local surface must be an ordinary file."))
                        messages.append(f"Runnable surface path is not an ordinary file: {surface.path}")
                elif isinstance(surface, VideoSurface) and surface.path is not None:
                    path = _resolved_or_collect(
                        issues, root, surface.path, f"surface '{surface.id}'", f"{surface_path}/path", messages
                    )
                    if path is None:
                        continue
                    if not path.exists():
                        issues.append(_issue(f"{surface_path}/path", "missing_artifact", "A required local surface is missing."))
                        messages.append(f"Runnable surface path is not an ordinary file: {surface.path}")
                    elif not path.is_file():
                        issues.append(_issue(f"{surface_path}/path", "wrong_artifact_type", "A local surface must be an ordinary file."))
                        messages.append(f"Runnable surface path is not an ordinary file: {surface.path}")
                    else:
                        with path.open("rb") as stream:
                            lfs_pointer = stream.read(len(_LFS_HEADER)) == _LFS_HEADER
                        if lfs_pointer:
                            issues.append(_issue(f"{surface_path}/path", "lfs_pointer", "A local video cannot be a Git LFS pointer."))
                            messages.append(f"Local video is a Git LFS pointer, not playable media: {surface.path}")
                elif isinstance(surface, TerminalSurface):
                    path = _resolved_or_collect(
                        issues, root, surface.cwd, f"surface '{surface.id}' cwd", f"{surface_path}/cwd", messages
                    )
                    if path is not None and not path.is_dir():
                        issues.append(_issue(f"{surface_path}/cwd", "invalid_terminal_cwd", "A terminal working directory is required."))
                        messages.append(f"Terminal cwd is not a directory: {surface.cwd}")
    _raise_collected_issues(issues, messages)


def _resolve_inside(root: Path, relative: str, label: str, path: str = "") -> Path:
    candidate = (root / relative).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ManifestValidationError(
            "A local path resolves outside the course root.",
            issues=[_issue(path, "path_escape", "A local path must remain inside the course root.")],
        ) from exc
    return candidate


def _collect_path_issue(
    issues: list[dict[str, str]], root: Path, relative: str, label: str, path: str,
    messages: list[str],
) -> None:
    try:
        _resolve_inside(root, relative, label, path)
    except ManifestValidationError as exc:
        issues.extend(exc.issues)
        messages.append(str(exc))


def _resolved_or_collect(
    issues: list[dict[str, str]], root: Path, relative: str, label: str, path: str,
    messages: list[str],
) -> Path | None:
    try:
        return _resolve_inside(root, relative, label, path)
    except ManifestValidationError as exc:
        issues.extend(exc.issues)
        messages.append(str(exc))
        return None


def _raise_collected_issues(issues: list[dict[str, str]], messages: list[str]) -> None:
    if not issues:
        return
    ordered = sorted(issues, key=lambda issue: (issue["path"], issue["code"], issue["message"]))
    raise ManifestValidationError(messages[0] if messages else "A local path is invalid.", issues=ordered)


def _without_optional_nones(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_optional_nones(item)
            for key, item in value.items()
            if item is not None
        }
    if isinstance(value, list):
        return [_without_optional_nones(item) for item in value]
    return value


def _json_pointer(parts: object) -> str:
    """Render a stable RFC 6901 pointer without returning request values."""

    if not isinstance(parts, (tuple, list)):
        return ""
    escaped = [str(part).replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped) if escaped else ""


def _issue(path: str, code: str, message: str) -> dict[str, str]:
    return {"path": path, "code": code, "message": message}


def _schema_issues_from_errors(errors: list[JSONSchemaValidationError]) -> list[dict[str, str]]:
    """Return deterministic schema diagnostics without reflecting input values."""

    issues = [
        _issue(path, "schema_validation", "The field is invalid.")
        for error in errors
        for path in _schema_error_paths(error)
    ]
    unique = {(issue["path"], issue["code"], issue["message"]): issue for issue in issues}
    return sorted(unique.values(), key=lambda issue: (issue["path"], issue["code"], issue["message"]))


def _schema_error_paths(error: JSONSchemaValidationError) -> list[str]:
    """Map JSON Schema diagnostics to useful RFC 6901 control addresses."""

    base = _json_pointer(tuple(error.absolute_path))
    if error.validator == "required" and isinstance(error.instance, dict):
        required = error.validator_value
        if isinstance(required, list):
            missing = [name for name in required if isinstance(name, str) and name not in error.instance]
            if missing:
                return [f"{base}/{name.replace('~', '~0').replace('/', '~1')}" for name in missing]
    if error.validator != "oneOf":
        return [base]
    branch = _active_union_branch(error)
    if branch is None:
        return [base]
    prefix = tuple(error.absolute_schema_path)
    paths: list[str] = []
    for child in _leaf_errors(error):
        schema_path = tuple(child.absolute_schema_path)
        if len(schema_path) > len(prefix) and schema_path[len(prefix)] == branch:
            paths.extend(_schema_error_paths(child))
    return paths or [base]


def _leaf_errors(error: JSONSchemaValidationError) -> list[JSONSchemaValidationError]:
    if not error.context:
        return [error]
    leaves: list[JSONSchemaValidationError] = []
    for child in error.context:
        leaves.extend(_leaf_errors(child))
    return leaves


def _active_union_branch(error: JSONSchemaValidationError) -> int | None:
    """Choose the discriminated schema branch from the already parsed object."""

    if not isinstance(error.instance, dict):
        return None
    kind = error.instance.get("type")
    if kind in {"html", "markdown", "source", "manual"}:
        return 0
    if kind in {"notebook", "prediction_recorded", "receipt_recorded"}:
        return 1
    if kind == "artifact_exists":
        return 2
    if kind == "video":
        return 2 if "path" in error.instance else 3
    if kind == "terminal":
        return 4
    if kind == "external":
        return 5
    return None


def _pydantic_issue_path(data: object, error: dict[str, Any]) -> str:
    """Recover an addressable pointer for model-level uniqueness checks."""

    pointer = _json_pointer(error.get("loc", ()))
    if pointer:
        return pointer
    message = str(error.get("msg", ""))
    if "entry_module_id" in message:
        return "/entry_module_id"
    if not isinstance(data, dict):
        return ""
    modules = data.get("modules")
    if not isinstance(modules, list):
        return ""
    if "duplicate module id" in message:
        return _duplicate_id_path(modules, "/modules")
    for module_index, module in enumerate(modules):
        if not isinstance(module, dict):
            continue
        phases = module.get("phases")
        if not isinstance(phases, list):
            continue
        if "duplicate phase id" in message:
            return _duplicate_id_path(phases, f"/modules/{module_index}/phases")
        if "duplicate surface id" in message:
            for phase_index, phase in enumerate(phases):
                if isinstance(phase, dict) and isinstance(phase.get("surfaces"), list):
                    duplicate = _duplicate_id_path(
                        phase["surfaces"], f"/modules/{module_index}/phases/{phase_index}/surfaces"
                    )
                    if duplicate:
                        return duplicate
    return ""


def _duplicate_id_path(items: list[object], prefix: str) -> str:
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        identifier = item["id"]
        if identifier in seen:
            return f"{prefix}/{index}/id"
        seen.add(identifier)
    return ""
