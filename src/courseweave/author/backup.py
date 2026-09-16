"""Explicit private backups; restored projects never inherit live mutation authority."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
from typing import Literal
from uuid import uuid4

from pydantic import Field, StrictBool

from ..contracts.models import ClosedModel, Slug
from ..contracts.primitives import local_path
from .content import _ChangeStatus, _SavedChange, _entries, _lock, _recover, _saved
from .contracts import AuthorProject, InventoryFile, ResearchReport, ReviewReport, Revision, Sha256, SourceRecord
from .project import ProjectError, atomic_bytes, checked_local_path, excluded_path, inspect_source, local_directory, open_project, read_private, read_sources, source_file
from .quality import _review_names
from .sources import _report_names

MAX_FILES = 40_000
MAX_BYTES = 2 * 1024**3
MAX_METADATA = 16 * 1024**2
METADATA = 'COURSEWEAVE-AUTHOR-BACKUP.json'
Category = Literal['changes', 'reviews', 'research']


class BackupSelection(ClosedModel):
    categories: tuple[Category, ...] = Field(default=(), max_length=3)


class BackupFile(InventoryFile):
    executable: StrictBool = False


class ProjectIdentity(ClosedModel):
    format: Literal[1] = 1
    project_id: Slug
    revision: Revision


class BackupIndex(BackupSelection):
    format: Literal[1] = 1
    schema_version: Literal[2] = 2
    files: tuple[BackupFile, ...] = Field(min_length=2, max_length=MAX_FILES)


def _json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _selection(categories):
    try:
        result = BackupSelection(categories=tuple(categories)).categories
        if len(set(result)) != len(result):
            raise ValueError()
        return tuple(sorted(result))
    except ValueError:
        raise ProjectError('Select each supported backup category once.') from None


def _source_paths(record):
    prefix = 'sources/' + record.source_id + '/'
    paths = {record.snapshot_path: record.raw_sha256}
    if record.text_path:
        paths[record.text_path] = record.text_sha256
    for name, digest in paths.items():
        if (not name.startswith(prefix) or not re.fullmatch(r'(?:snapshot-[a-f0-9]{32}/)?(?:raw|text\.txt)', name[len(prefix):])
                or digest is None):
            raise ProjectError('A source snapshot reference is incompatible with this backup format.')
    return paths


def _validate_contents(index, read):
    """Validate the closed artifact layout and references before restoring any file."""
    files = {f.path: f for f in index.files}
    if len(files) != len(index.files) or len({p.casefold() for p in files}) != len(files):
        raise ValueError('Repeated archive paths.')
    prefixes = {}
    for name in files:
        for path in [Path(name), *Path(name).parents]:
            key = str(path)
            if key == '.':
                continue
            if prefixes.setdefault(key.casefold(), key) != key or (key != name and key in files):
                raise ValueError('Ambiguous file or directory path.')
    allowed = {'author-state/project.json', 'author-state/sources.json'}
    project = ProjectIdentity.model_validate_json(read('author-state/project.json', 16_384))
    sources = json.loads(read('author-state/sources.json', MAX_METADATA))
    if not isinstance(sources, list) or len(sources) > 10_000:
        raise ValueError('Source registry limit.')
    sources = [SourceRecord.model_validate(r) for r in sources]
    if len({r.source_id for r in sources}) != len(sources):
        raise ValueError('Repeated source identity.')
    for current in sources:
        records = [current]
        initial = 'author-state/sources/' + current.source_id + '/revision-0.json'
        if initial in files:
            record = SourceRecord.model_validate_json(read(initial, 64 * 1024))
            if record.source_id != current.source_id or record.revision != 0:
                raise ValueError('Initial source identity mismatch.')
            records.append(record);allowed.add(initial)
        for record in records:
            for path, digest in _source_paths(record).items():
                name = 'author-state/' + path
                if files[name].sha256 != digest:
                    raise ValueError('Source hash mismatch.')
                allowed.add(name)
    for name in files:
        local_path(name)
        if name.startswith('course/'):
            if excluded_path(name[7:]):
                raise ValueError('Private course path.')
            allowed.add(name)
        elif name.startswith('author-state/changes/') and name.endswith('/candidate.json'):
            match = re.fullmatch(r'author-state/changes/(change-[a-f0-9]{32})/candidate.json', name)
            if not match:
                raise ValueError('Invalid change path.')
            prefix = name.removesuffix('candidate.json')
            candidate = json.loads(read(name, 1024**2))
            saved = _SavedChange.model_validate(candidate | {'before_bytes': read(prefix+'before', 8 * 1024**2),
                'change': candidate['change'] | {'after_bytes': read(prefix+'after', 8 * 1024**2)}})
            status = _ChangeStatus.model_validate_json(read(prefix+'status.json', 1024)).status
            if (saved.change.change_id != match[1] or saved.change.project_id != project.project_id
                    or saved.basis.selection.project_id != project.project_id
                    or saved.change.context_digest != saved.basis.context_digest
                    or saved.change.before_sha256 != _hash(saved.before_bytes)
                    or saved.change.after_sha256 != _hash(saved.change.after_bytes) or status == 'prepared'
                    or ('changes' not in index.categories and status != 'applied')):
                raise ValueError('Unreconciled or mismatched change.')
            allowed.update(prefix + part for part in ('candidate.json', 'before', 'after', 'status.json'))
        elif re.fullmatch(r'author-state/reviews/review-[a-f0-9]{32}\.json', name) and 'reviews' in index.categories:
            report = ReviewReport.model_validate_json(read(name, 512 * 1024))
            if report.project_id != project.project_id or name != 'author-state/reviews/' + report.report_id + '.json':
                raise ValueError('Review identity mismatch.')
            allowed.add(name)
        elif re.fullmatch(r'author-state/research/research-[a-f0-9]{32}\.json', name) and 'research' in index.categories:
            report = ResearchReport.model_validate_json(read(name, 1024**2))
            if name != 'author-state/research/' + report.report_id + '.json' or any(f.content for f in report.fetches):
                raise ValueError('Research identity or payload mismatch.')
            allowed.add(name)
    if set(files) != allowed:
        raise ValueError('Unknown or missing backup artifact.')
    if 'course/courseweave.json' in files:
        manifest = json.loads(read('course/courseweave.json', 8 * 1024**2))
        if not isinstance(manifest, dict) or manifest.get('schema_version') != 2:
            raise ValueError('Unsupported course schema.')
    return project


def _plan(project, categories):
    project = open_project(project.course_root.parent)
    categories = _selection(categories)
    root = project.course_root.parent
    generated = {'author-state/project.json': _json(ProjectIdentity(project_id=project.project_id,
        revision=project.revision).model_dump(mode='json'))}
    names = {'author-state/project.json', 'author-state/sources.json'}
    names.update('course/' + file.path for file in inspect_source(project.course_root).files)
    for record in read_sources(project):
        names.update('author-state/' + path for path in _source_paths(record))
        initial = 'sources/' + record.source_id + '/revision-0.json'
        if (project.state_root / initial).exists():
            initial_record = SourceRecord.model_validate_json(read_private(project.state_root, initial, max_bytes=64 * 1024))
            names.add('author-state/' + initial)
            names.update('author-state/' + path for path in _source_paths(initial_record))
    for name in _entries(project, 'changes', 1000):
        if (project.state_root / 'changes' / name / 'candidate.json').exists():
            if 'changes' in categories or _saved(project, name).change.status == 'applied':
                names.update('author-state/changes/' + name + '/' + part for part in ('candidate.json', 'before', 'after', 'status.json'))
    if 'reviews' in categories:
        names.update('author-state/reviews/' + name + '.json' for name in _review_names(project))
    if 'research' in categories:
        names.update('author-state/research/' + name for name in _report_names(project))
    files, total = [], 0
    if len(names) > MAX_FILES:
        raise ProjectError('Backup exceeds 40,000 files; select fewer saved artifacts.')
    for name in sorted(names):
        if name in generated:
            raw = generated[name];size, digest, executable = len(raw), _hash(raw), False
        else:
            with source_file(root, name) as fd, os.fdopen(os.dup(fd), 'rb') as stream:
                info = os.fstat(fd);size = info.st_size
                if total + size > MAX_BYTES:
                    raise ProjectError('Backup exceeds the 2 GiB limit.')
                digest, executable = hashlib.file_digest(stream, 'sha256').hexdigest(), bool(info.st_mode & 0o111)
        total += size
        files.append(BackupFile(path=name, size=size, sha256=digest, executable=executable))
    index = BackupIndex(categories=categories, files=tuple(files))
    read = lambda name, limit: generated[name] if name in generated else read_private(root, name, max_bytes=limit)
    _validate_contents(index, read)
    return index, generated


def inspect_backup(project, categories=()):
    with _lock(project):
        _recover(project)
        index, _ = _plan(project, categories)
        return index.model_dump(mode='json') | {'inventory_sha256': _hash(_json(index.model_dump(mode='json'))),
            'total_bytes': sum(f.size for f in index.files),
            'notice': 'Private backup: saved course, current source snapshots, applied changes for provenance and selected artifacts. Chat, credentials, runtimes, Student homes and delivery files are excluded. Restored drafts and reports require fresh review.'}


@contextmanager
def _archive(path, expected_sha256=None):
    path = checked_local_path(path)
    try:
        with source_file(path.parent, path.name) as fd, os.fdopen(os.dup(fd), 'rb') as stream:
            if os.fstat(fd).st_size > MAX_BYTES + MAX_METADATA + MAX_FILES * 2048:
                raise ValueError('Archive size limit.')
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if expected_sha256 is not None and digest != expected_sha256:
                raise ValueError('Archive changed after inspection.')
            stream.seek(0)
            with tarfile.open(fileobj=stream, mode='r:') as archive:
                members, hashes, total = {}, {}, 0
                for member in archive:
                    local_path(member.name)
                    if not member.isfile() or member.name in members or len(members) >= MAX_FILES + 1:
                        raise ValueError('Unsupported or duplicate archive entry.')
                    total += member.size
                    if total > MAX_BYTES + MAX_METADATA:
                        raise ValueError('Archive content limit.')
                    members[member.name] = member
                    with archive.extractfile(member) as content:
                        hashes[member.name] = hashlib.file_digest(content, 'sha256').hexdigest()
                def read(name, limit):
                    member = members[name]
                    if member.size > limit:
                        raise ValueError('Artifact size limit.')
                    with archive.extractfile(member) as content:
                        return content.read(limit + 1)
                index = BackupIndex.model_validate_json(read(METADATA, MAX_METADATA))
                if len(set(index.categories)) != len(index.categories) or set(members) != {METADATA, *(f.path for f in index.files)}:
                    raise ValueError('Archive inventory mismatch.')
                for file in index.files:
                    if file.sha256 != hashes[file.path] or file.size != members[file.path].size:
                        raise ValueError('Archive content mismatch.')
                project = _validate_contents(index, read)
                yield archive, members, index, project, digest
    except ProjectError:
        raise
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError):
        raise ProjectError('Backup is changed, partial or incompatible. No existing project was overwritten; choose a complete verified archive.') from None


def inspect_restore(path):
    with _archive(path) as (_, _, index, project, digest):
        return {'archive_sha256': digest, 'original_project_id': project.project_id, 'categories': index.categories,
            'file_count': len(index.files), 'total_bytes': sum(f.size for f in index.files),
            'notice': 'Restore creates a new project. Pending drafts and saved reports become stale. Existing source decisions are retained; no old operation is replayed.'}


def backup_project(project, destination, categories, inventory_sha256):
    destination = checked_local_path(destination)
    if destination.suffix != '.tar' or destination.is_relative_to(project.course_root.parent):
        raise ProjectError('Choose a new .tar backup outside this author project.')
    with _lock(project), local_directory(destination.parent) as parent:
        _recover(project)
        index, generated = _plan(project, categories)
        if _hash(_json(index.model_dump(mode='json'))) != inventory_sha256:
            raise ProjectError('Backup selection changed; inspect the saved artifacts again.')
        if destination.exists() or destination.is_symlink():
            raise ProjectError('Backup destination exists; choose a new file.')
        temporary = '.author-backup-' + uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'wb') as stream, tarfile.open(fileobj=stream, mode='w', format=tarfile.PAX_FORMAT) as archive:
                raw = _json(index.model_dump(mode='json'))
                item = tarfile.TarInfo(METADATA);item.size = len(raw);item.mode = 0o600
                archive.addfile(item, io.BytesIO(raw))
                for file in index.files:
                    item = tarfile.TarInfo(file.path);item.size = file.size;item.mode = 0o700 if file.executable else 0o600
                    if file.path in generated:
                        archive.addfile(item, io.BytesIO(generated[file.path]))
                    else:
                        with source_file(project.course_root.parent, file.path) as source_fd, os.fdopen(os.dup(source_fd), 'rb') as content:
                            archive.addfile(item, content)
                archive.close();stream.flush();os.fsync(stream.fileno())
            current, _ = _plan(project, categories)
            if current != index:
                raise ProjectError('Backup files changed during preparation; inspect them again.')
            with _archive(destination.parent / temporary) as (_, _, saved, _, digest):
                if saved != index:
                    raise ProjectError('Backup contents changed during preparation.')
            os.link(temporary, destination.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.fsync(parent)
            return {'destination': str(destination), 'archive_sha256': digest, 'file_count': len(index.files),
                'categories': categories}
        finally:
            os.unlink(temporary, dir_fd=parent)


def restore_backup(path, destination, archive_sha256):
    destination = checked_local_path(destination)
    with _archive(path, archive_sha256) as (archive, members, index, previous, digest):
        project = AuthorProject(project_id=destination.name, revision=previous.revision + 1,
            course_root=destination / 'course', state_root=destination / 'author-state')
        with local_directory(destination.parent) as parent:
            try:
                os.mkdir(destination.name, mode=0o700, dir_fd=parent)
            except FileExistsError:
                raise ProjectError('Restore always needs a new project directory; this destination exists.') from None
            os.fsync(parent)
        for root in (project.course_root, project.state_root):
            with local_directory(root, create=True):
                pass
        for file in index.files:
            if file.path == 'author-state/project.json':
                continue  # Only the final completion marker publishes this project.
            with local_directory((destination / file.path).parent, create=True) as parent:
                name = Path(file.path).name
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if file.executable else 0o600, dir_fd=parent)
                digest_copy = hashlib.sha256()
                with os.fdopen(fd, 'wb') as stream, archive.extractfile(members[file.path]) as content:
                    while chunk := content.read(1024 * 1024):
                        digest_copy.update(chunk);stream.write(chunk)
                    stream.flush();os.fsync(stream.fileno())
                if digest_copy.hexdigest() != file.sha256:
                    raise ProjectError('Archive changed while restoring. The new directory remains incomplete; choose a verified backup and a new project ID.')
                os.fsync(parent)
        for file in index.files:
            if file.path.startswith('author-state/changes/') and file.path.endswith('/candidate.json'):
                directory = (destination / file.path).parent
                candidate = json.loads(read_private(directory, 'candidate.json', max_bytes=1024**2))
                candidate['change']['project_id'] = project.project_id
                candidate['basis']['selection']['project_id'] = project.project_id
                status = _ChangeStatus.model_validate_json(read_private(directory, 'status.json', max_bytes=1024)).status
                if status in {'pending', 'prepared'}:
                    status = 'stale'
                candidate['change']['status'] = status
                atomic_bytes(directory / 'candidate.json', _json(candidate), replace=True)
                atomic_bytes(directory / 'status.json', _json({'status': status}), replace=True)
            elif file.path.startswith('author-state/reviews/'):
                report = json.loads(read_private(destination, file.path, max_bytes=512 * 1024))
                report['project_id'] = report['selection']['project_id'] = project.project_id
                report['status'] = 'stale'
                report['stale_reasons'] = ['Restored into a new project; review the current content and evidence.']
                atomic_bytes(destination / file.path, _json(ReviewReport.model_validate(report).model_dump(mode='json')), replace=True)
        atomic_bytes(project.state_root / 'restore.json', _json({'format': 1, 'archive_sha256': digest,
            'original_project_id': previous.project_id, 'categories': index.categories,
            'restored_at': datetime.now(timezone.utc).isoformat(), 'notice': 'New project; no operation or approval was replayed.'}))
        atomic_bytes(project.state_root / 'project.json', _json(project.model_dump(mode='json')))
        return project
