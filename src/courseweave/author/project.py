"""Private author projects, bounded inventories and immutable source snapshots.

All inputs here are direct author selections. Imported material is data: nothing
executes, excluded paths are never opened, and the completion marker is last.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
from uuid import uuid4

from pydantic import Field, ValidationError

from ..contracts.models import ClosedModel
from ..contracts.primitives import local_path
from ..manifest import ManifestValidationError, parse_manifest_data
from .contracts import AuthorProject, SourceRecord

MAX_FILES = 10_000
MAX_BYTES = 1024 * 1024 * 1024
MAX_ENTRIES = 40_000
MAX_DEPTH = 64
TEXT_BYTES = 2 * 1024 * 1024
_EXCLUDED = {
    "node_modules", "__pycache__", "venv", "env", "runtimes", "runtime",
    "state", "user-state", "author-state", "personal-notebooks", "chats",
    "chat.json", "conversation.json", "credentials.json", "secrets.json",
    "cache", "build", "dist", "courseweave.db", "courseweave.db-wal", "courseweave.db-shm",
}
_TEXT_EXTENSIONS = {".md", ".txt", ".rst", ".csv"}


class ProjectError(ValueError):
    """An actionable, credential-free project error."""


class InventoryFile(ClosedModel):
    path: str
    size: int
    sha256: str


class InventoryOmission(ClosedModel):
    path: str
    reason: str


class SourceInventory(ClosedModel):
    files: tuple[InventoryFile, ...] = Field(max_length=10_000)
    omitted: tuple[InventoryOmission, ...] = Field(max_length=40_000)
    total_bytes: int
    digest: str


def checked_local_path(value: Path) -> Path:
    """Reject cloud storage and symlink components before any traversal."""
    path = Path(os.path.abspath(value.expanduser()))
    parts = path.parts
    if ("Mobile Documents" in parts or any(p.startswith("GoogleDrive-") for p in parts)
            or path.is_relative_to(Path.home() / "Desktop")
            or path.is_relative_to(Path.home() / "Documents")):
        raise ProjectError("Choose nonsynced local storage outside cloud Drive, Desktop and Documents.")
    cursor = Path(path.anchor)
    for part in parts[1:]:
        cursor /= part
        if cursor.is_symlink():
            raise ProjectError("Symlink paths are unsupported; choose the actual local directory.")
    return path


@contextmanager
def local_directory(path: Path, *, create: bool = False):
    """Open the whole absolute path without following any symlink component.

    Descriptor-relative operations keep a concurrent path swap from changing
    the destination of reads/writes after the author has selected a root.
    """
    path = checked_local_path(path)
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        yield fd
    except OSError:
        raise ProjectError("Local directory is unavailable or changed; select it again.") from None
    finally:
        os.close(fd)


@contextmanager
def source_file(root: Path, relative: str):
    local_path(relative)
    with local_directory(root / Path(relative).parent) as parent:
        try:
            fd = os.open(Path(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ProjectError("Selected source must be an ordinary file.")
                yield fd
            finally:
                os.close(fd)
        except OSError:
            raise ProjectError("Selected source is unavailable or changed; inspect it again.") from None


def read_private(root: Path, relative: str, *, max_bytes: int) -> bytes:
    with source_file(root, relative) as fd:
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ProjectError("File exceeds the supported size limit.")
        return data


def atomic_json(path: Path, value: object, *, replace: bool = False) -> None:
    """Publish one fsynced JSON file; default is immutable/no overwrite.

    Callers using replace must hold the project's CourseStore lock and check
    the reviewed revision before entering this function.
    """
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    atomic_bytes(path, data, replace=replace)


def atomic_bytes(path: Path, data: bytes, *, replace: bool = False) -> None:
    """Publish immutable bytes, or replace under the caller's course lock."""
    with local_directory(path.parent, create=True) as parent:
        temporary = f".write-{uuid4().hex}"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if replace:
                os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            else:
                os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def _excluded(name: str) -> bool:
    return name.startswith(".") or name.casefold() in _EXCLUDED or name.casefold().endswith((".pyc", ".pem", ".key", ".env"))


def excluded_path(relative: str) -> bool:
    return any(_excluded(part) for part in Path(relative).parts)


def _identity(info):
    # atime may change from our own read and is not a source revision.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inspect_source(source_root: Path) -> SourceInventory:
    root = checked_local_path(source_root)
    if _excluded(root.name):
        raise ProjectError("Private or runtime directories cannot be inventory roots.")
    files: list[InventoryFile] = []
    omitted: list[InventoryOmission] = []
    total_bytes = 0
    entries_seen = 0

    def walk(directory: int, prefix: str, depth: int):
        nonlocal total_bytes, entries_seen
        if depth > MAX_DEPTH:
            raise ProjectError("Source traversal depth limit exceeded.")
        entries = []
        with os.scandir(directory) as iterator:
            for entry in iterator:
                entries_seen += 1
                if entries_seen > MAX_ENTRIES:
                    raise ProjectError("Source traversal entry limit exceeded.")
                entries.append(entry.name)
        for name in sorted(entries):
            relative = f"{prefix}/{name}" if prefix else name
            if _excluded(name):
                omitted.append(InventoryOmission(path=relative, reason="excluded private or runtime path"))
                continue
            try:
                local_path(relative)
            except ValueError:
                omitted.append(InventoryOmission(path=relative, reason="unsupported path"))
                continue
            before = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISLNK(before.st_mode) or not (stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode)):
                omitted.append(InventoryOmission(path=relative, reason="symlink or special file"))
                continue
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if stat.S_ISDIR(before.st_mode):
                flags |= os.O_DIRECTORY
            fd = os.open(name, flags, dir_fd=directory)
            try:
                if _identity(before) != _identity(os.fstat(fd)):
                    raise ProjectError("Source changed during inventory; inspect it again.")
                if stat.S_ISDIR(before.st_mode):
                    walk(fd, relative, depth + 1)
                else:
                    if len(files) >= MAX_FILES or total_bytes + before.st_size > MAX_BYTES:
                        raise ProjectError("Source inventory limit is 10,000 files and 1 GiB.")
                    digest = hashlib.sha256()
                    size = 0
                    while chunk := os.read(fd, 1024 * 1024):
                        size += len(chunk)
                        if total_bytes + size > MAX_BYTES:
                            raise ProjectError("Source inventory size limit exceeded.")
                        digest.update(chunk)
                    if size != before.st_size or _identity(before) != _identity(os.fstat(fd)):
                        raise ProjectError("Source changed during inventory; inspect it again.")
                    total_bytes += size
                    files.append(InventoryFile(path=relative, size=size, sha256=digest.hexdigest()))
            finally:
                os.close(fd)

    with local_directory(root) as fd:
        walk(fd, "", 0)
    files.sort(key=lambda item: item.path)
    value = {"root": str(root), "files": [f.model_dump() for f in files], "omitted": [o.model_dump() for o in omitted]}
    digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    return SourceInventory(files=tuple(files), omitted=tuple(omitted), total_bytes=total_bytes, digest=digest)


def _copy_selected(root: Path, file: InventoryFile, destinations: tuple[Path, ...]) -> None:
    # Stream one selected file at a time. Each destination is exclusive and
    # remains incomplete if the original changes. No source writes occur.
    from contextlib import ExitStack
    with ExitStack() as stack:
        source = stack.enter_context(source_file(root, file.path))
        outputs = []
        for path in destinations:
            parent = stack.enter_context(local_directory(path.parent, create=True))
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            outputs.append(stack.enter_context(os.fdopen(fd, "wb")))
        digest = hashlib.sha256()
        size = 0
        while chunk := os.read(source, 1024 * 1024):
            size += len(chunk)
            if size > file.size:
                raise ProjectError("Selected source changed during import; project remains incomplete.")
            digest.update(chunk)
            for output in outputs:
                output.write(chunk)
        if size != file.size or digest.hexdigest() != file.sha256:
            raise ProjectError("Selected source changed during import; project remains incomplete.")
        for output in outputs:
            output.flush()
            os.fsync(output.fileno())
        for path in destinations:
            with local_directory(path.parent) as parent:
                os.fsync(parent)


def create_project(source_root: Path | None, destination: Path, selected_paths: tuple[str, ...],
                   *, expected_inventory: str | None = None) -> AuthorProject:
    destination = checked_local_path(destination)
    try:
        project = AuthorProject(project_id=destination.name, course_root=destination / "course",
                                state_root=destination / "author-state", revision=0)
    except ValidationError:
        raise ProjectError("Project ID must use letters, numbers, underscores or hyphens.") from None
    if destination.exists():
        raise ProjectError("Destination already exists; choose a new project ID.")
    files = {}
    if source_root is not None:
        source_root = checked_local_path(source_root)
        if source_root.is_relative_to(destination) or destination.is_relative_to(source_root):
            raise ProjectError("Project destination and import source must be separate.")
        inventory = inspect_source(source_root)
        if expected_inventory is not None and expected_inventory != inventory.digest:
            raise ProjectError("Source inventory changed; inspect it again before importing.")
        files = {entry.path: entry for entry in inventory.files}
    if len(selected_paths) != len(set(selected_paths)) or any(p not in files for p in selected_paths):
        raise ProjectError("Select only distinct ordinary files from the inspected inventory.")
    if source_root and "courseweave.json" in selected_paths:
        try:
            parse_manifest_data(json.loads(read_private(source_root, "courseweave.json", max_bytes=1024 * 1024)), source_root)
        except (ValueError, ManifestValidationError):
            raise ProjectError("Imported manifest is invalid; repair it or deselect it before importing.") from None
    with local_directory(destination.parent) as parent:
        try:
            os.mkdir(destination.name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            raise ProjectError("Destination already exists; choose a new project ID.") from None
        os.fsync(parent)
    for root in (project.course_root, project.state_root):
        with local_directory(root, create=True):
            pass
    records = []
    for relative in selected_paths:
        file = files[relative]
        source_id = f"source-{uuid4().hex}"
        snapshot = f"sources/{source_id}/raw"
        _copy_selected(source_root, file, (project.course_root / relative, project.state_root / snapshot))
        text = None
        if Path(relative).suffix.casefold() in _TEXT_EXTENSIONS and file.size <= TEXT_BYTES:
            try:
                read_private(project.state_root, snapshot, max_bytes=TEXT_BYTES).decode("utf-8")
                text = snapshot
            except UnicodeError:
                pass
        record = SourceRecord(source_id=source_id, revision=0, title=relative, origin=str(source_root / relative),
            imported_at=datetime.now(timezone.utc), raw_sha256=file.sha256,
            text_sha256=file.sha256 if text else None, snapshot_path=snapshot, text_path=text,
            extractor_version="utf8-v1" if text else None, policy_decision="local",
            extraction="text" if text else "unsupported")
        atomic_json(project.state_root / "sources" / source_id / "revision-0.json", record.model_dump(mode="json"))
        records.append(record.model_dump(mode="json"))
    atomic_json(project.state_root / "sources.json", records)
    atomic_json(project.state_root / "project.json", project.model_dump(mode="json"))
    return project


def open_project(destination: Path) -> AuthorProject:
    destination = checked_local_path(destination)
    try:
        project = AuthorProject.model_validate_json(read_private(destination, "author-state/project.json", max_bytes=16_384))
        if (project.course_root != destination / "course" or project.state_root != destination / "author-state"
                or project.project_id != destination.name):
            raise ValueError()
        with local_directory(project.course_root):
            pass
        return project
    except (ValueError, OSError):
        raise ProjectError("Project is incomplete, corrupt or moved; restore or import a verified copy.") from None


def read_sources(project: AuthorProject) -> tuple[SourceRecord, ...]:
    try:
        raw = json.loads(read_private(project.state_root, "sources.json", max_bytes=16 * 1024 * 1024))
        if not isinstance(raw, list) or len(raw) > MAX_FILES:
            raise ValueError()
        records = tuple(SourceRecord.model_validate(record) for record in raw)
        if len({r.source_id for r in records}) != len(records):
            raise ValueError()
        return records
    except (ValueError, OSError):
        raise ProjectError("Source registry is corrupt; restore a verified backup.") from None


def import_resource(project: AuthorProject, source_path: Path) -> SourceRecord:
    """Snapshot one explicitly chosen replacement, under the caller's course lock.

    It remains a candidate with undecided redistribution. No course file is
    changed here. The import origin and snapshot survive a rejected replacement.
    """
    source_path = checked_local_path(source_path)
    if any(_excluded(part) for part in source_path.parts[1:]):
        raise ProjectError("Private or runtime files cannot be imported as lesson resources.")
    data = read_private(source_path.parent, source_path.name, max_bytes=8 * 1024 * 1024)
    records = list(read_sources(project))
    if len(records) >= MAX_FILES:
        raise ProjectError("Source registry limit reached.")
    source_id = f"source-{uuid4().hex}"
    snapshot = f"sources/{source_id}/raw"
    digest = hashlib.sha256(data).hexdigest()
    _copy_selected(source_path.parent, InventoryFile(path=source_path.name, size=len(data), sha256=digest),
                   (project.state_root / snapshot,))
    text = None
    if source_path.suffix.lower() in _TEXT_EXTENSIONS and len(data) <= TEXT_BYTES:
        try:
            data.decode("utf-8")
            text = snapshot
        except UnicodeError:
            pass
    record = SourceRecord(source_id=source_id, revision=0, title=source_path.name, origin=str(source_path),
        imported_at=datetime.now(timezone.utc), raw_sha256=digest, text_sha256=digest if text else None,
        snapshot_path=snapshot, text_path=text, extractor_version="utf8-v1" if text else None,
        policy_decision="local", extraction="text" if text else "unsupported", intended_use="student_material")
    atomic_json(project.state_root / "sources" / source_id / "revision-0.json", record.model_dump(mode="json"))
    records.append(record)
    atomic_json(project.state_root / "sources.json", [r.model_dump(mode="json") for r in records], replace=True)
    return record


def update_source(project: AuthorProject, store, source_id: str, revision: int, decision: dict) -> SourceRecord:
    """Record one explicit human decision under the course's shared lock."""
    with store.author_lock():
        records = list(read_sources(project))
        index = next((i for i, r in enumerate(records) if r.source_id == source_id), None)
        if index is None:
            raise ProjectError("Source does not exist in this project.")
        current = records[index]
        if current.revision != revision:
            raise ProjectError("Source decision changed; reload before reviewing this revision.")
        updated = SourceRecord.model_validate({**current.model_dump(), **decision, "revision": revision + 1})
        # A unique immutable artifact may be orphaned by interruption before
        # publishing sources.json. Only the registry publishes current decisions.
        artifact = f"sources/{source_id}/decision-{uuid4().hex}.json"
        atomic_json(project.state_root / artifact, updated.model_dump(mode="json"))
        records[index] = updated
        atomic_json(project.state_root / "sources.json", [r.model_dump(mode="json") for r in records], replace=True)
        return updated
