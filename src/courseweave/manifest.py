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

    try:
        _SCHEMA_VALIDATOR.validate(data)
    except JSONSchemaValidationError as exc:
        path = ".".join(str(part) for part in exc.absolute_path)
        where = f" at {path}" if path else ""
        raise ManifestValidationError(
            f"JSON Schema validation failed{where}: {exc.message}"
        ) from exc
    try:
        manifest = CourseManifest.model_validate(data)
    except PydanticValidationError as exc:
        raise ManifestValidationError(str(exc)) from exc
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
    for module in manifest.modules:
        for phase in module.phases:
            for surface in phase.surfaces:
                if isinstance(
                    surface,
                    (HtmlSurface, MarkdownSurface, SourceSurface, NotebookSurface),
                ):
                    _resolve_inside(root, surface.path, f"surface '{surface.id}'")
                elif isinstance(surface, VideoSurface) and surface.path is not None:
                    _resolve_inside(root, surface.path, f"surface '{surface.id}'")
                elif isinstance(surface, TerminalSurface):
                    _resolve_inside(root, surface.cwd, f"surface '{surface.id}' cwd")
            if isinstance(phase.completion, ArtifactCompletion):
                _resolve_inside(
                    root,
                    phase.completion.path,
                    f"completion '{phase.completion.record_id}'",
                )


def validate_runnable(manifest: CourseManifest, course_root: Path) -> None:
    """Require ordinary local surfaces while allowing future completion artifacts."""

    root = Path(course_root).resolve()
    for module in manifest.modules:
        for phase in module.phases:
            for surface in phase.surfaces:
                if isinstance(
                    surface,
                    (HtmlSurface, MarkdownSurface, SourceSurface, NotebookSurface),
                ):
                    path = _resolve_inside(root, surface.path, f"surface '{surface.id}'")
                    if not path.is_file():
                        raise ManifestValidationError(
                            f"Runnable surface path is not an ordinary file: {surface.path}"
                        )
                elif isinstance(surface, VideoSurface) and surface.path is not None:
                    path = _resolve_inside(root, surface.path, f"surface '{surface.id}'")
                    if not path.is_file():
                        raise ManifestValidationError(
                            f"Runnable surface path is not an ordinary file: {surface.path}"
                        )
                    with path.open("rb") as stream:
                        if stream.read(len(_LFS_HEADER)) == _LFS_HEADER:
                            raise ManifestValidationError(
                                f"Local video is a Git LFS pointer, not playable media: {surface.path}"
                            )
                elif isinstance(surface, TerminalSurface):
                    path = _resolve_inside(root, surface.cwd, f"surface '{surface.id}' cwd")
                    if not path.is_dir():
                        raise ManifestValidationError(
                            f"Terminal cwd is not a directory: {surface.cwd}"
                        )


def _resolve_inside(root: Path, relative: str, label: str) -> Path:
    candidate = (root / relative).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ManifestValidationError(
            f"{label} resolves outside the course root: {relative}"
        ) from exc
    return candidate


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
