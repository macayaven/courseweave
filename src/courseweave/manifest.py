"""Normative manifest parsing, path validation, deterministic bytes, and CAS."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


from courseweave.contracts import CourseManifest
from courseweave.engine import manifest as canonical

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


def parse_manifest_data(
    data: object,
    course_root: Path,
    *,
    runnable: bool = False,
) -> CourseManifest:
    """Validate through the canonical v2 contract and semantic/path rules."""

    try:
        return canonical.parse_manifest_data(data, course_root, runnable=runnable)
    except canonical.ManifestValidationError as exc:
        raise ManifestValidationError(str(exc), issues=exc.issues) from None


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
    title = raw_name[:200] or "Untitled Course"
    return CourseManifest.model_validate(
        {
            "schema_version": 2,
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
                "allowed_share_kinds": [],
                "allowed_proposal_types": [],
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
    manifest = parse_manifest_data(manifest, root)
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
    try:
        canonical.validate_paths(manifest, course_root)
    except canonical.ManifestValidationError as exc:
        raise ManifestValidationError(str(exc), issues=exc.issues) from None


def validate_runnable(manifest: CourseManifest, course_root: Path) -> None:
    try:
        canonical.validate_runnable(manifest, course_root)
    except canonical.ManifestValidationError as exc:
        raise ManifestValidationError(str(exc), issues=exc.issues) from None


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
