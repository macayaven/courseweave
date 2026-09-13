"""Durable learner state and consented, exactly-once proposal application."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import JsonValue, TypeAdapter, ValidationError

from courseweave.manifest import (
    ManifestSnapshot,
    load_manifest,
    ManifestNotFoundError,
    empty_manifest_draft,
    manifest_etag,
    parse_manifest_data,
    save_manifest,
)
from courseweave.models import NonEmpty, Slug, StrictModel
from courseweave.state_contracts import (PutRecord, ClearRecord, SetTimeBudget, SetPreferences,
    CheckAttempt, ResetState, StateOperation, LearnerState, AuditSummary, StoredAttempt, LegacyImport, AdaptationPreferences)
from courseweave.engine import curriculum_digest, bind_record, find_requirement, find_phase, evaluate_progress, effective_teacher_policy
from courseweave.contracts.records import Coordinate


try:  # pragma: no cover - Windows fallback is exercised only on Windows.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

MAX_TEXT_BYTES = 1024 * 1024
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1\n"
CrashHook = Callable[[str], None]


class StoreError(Exception):
    """Base class for stable persistence-boundary failures."""


class StoreNotConfiguredError(StoreError):
    """No course root is available for a durable store."""


class StoreCorruptError(StoreError):
    """Persisted state is malformed and must not be silently replaced."""


class CourseIdentityChangedError(StoreError):
    """An open store is bound to a draft identity superseded by another instance."""


class RevisionMismatchError(StoreError):
    """The caller supplied a stale learner-state or proposal revision."""


class IdempotencyConflictError(StoreError):
    """An idempotency key was reused for a different operation."""


class ProposalNotFoundError(StoreError):
    """The requested proposal ID or revision does not exist."""


class ProposalConflictError(StoreError):
    """The proposal is not in the state required for the operation."""


class TargetChangedError(StoreError):
    """The target no longer has the bytes shown in the proposal."""


class InvalidProposalError(StoreError):
    """A state operation or proposal violates the durable mutation contract."""


_STATE_OPERATION = TypeAdapter(StateOperation)


class ProposalRequest(StrictModel):
    id: Slug | None = None
    type: Literal[
        "profile_patch",
        "manifest_replace",
        "workspace_file_replace",
    ]
    origin: Literal["student_requested", "teacher_suggested"]
    summary: NonEmpty
    target: JsonValue
    payload: dict[str, JsonValue]
    target_hash: str | None = None


class ProposalEdit(StrictModel):
    summary: NonEmpty | None = None
    payload: dict[str, JsonValue] | None = None
    target_hash: str | None = None


class Proposal(StrictModel):
    id: str
    revision: int
    type: str
    origin: str
    status: Literal["pending", "accepted", "rejected", "superseded", "failed"]
    summary: str
    created_at: str
    target: JsonValue
    payload: dict[str, JsonValue]
    target_hash: str | None
    result: dict[str, JsonValue] | None = None


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _jsonable(value.model_dump(mode="json"))
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _canonical(value: Any) -> str:
    return json.dumps(
        _jsonable(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _request_hash(scope: str, value: Any) -> str:
    return hashlib.sha256(f"{scope}\0{_canonical(value)}".encode()).hexdigest()


def _file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def resolve_state_dir(course_root: Path, course_id: str) -> Path:
    """Personal platform data; neither source nor legacy state are touched."""
    override = os.environ.get("COURSEWEAVE_STATE_HOME")
    if override:
        base = Path(override)
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support' / 'CourseWeave'
    elif sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local')) / 'CourseWeave'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share')) / 'courseweave'
    fingerprint = hashlib.sha256(str(course_root.resolve()).encode()).hexdigest()
    return base / 'courses' / course_id / fingerprint


def _external_path(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    if resolved.is_relative_to(root):
        raise InvalidProposalError('State locations must be outside course source')
    return resolved


def _storage_paths(root: Path, course_id: str, state_dir: Path | None) -> tuple[Path, Path, Path]:
    fingerprint = hashlib.sha256(str(root).encode()).hexdigest()
    directory = Path(state_dir).resolve() if state_dir is not None else resolve_state_dir(root, course_id)
    base = directory.parent if state_dir is not None else directory.parents[2]
    registry = directory / 'root-identity.json' if state_dir is not None else base / 'roots' / f'{fingerprint}.json'
    lock = base / 'locks' / f'{fingerprint}.lock'
    # Check every writable destination before mkdir, lock creation, or SQLite.
    directory, lock, registry = (_external_path(path, root) for path in (directory, lock, registry))
    for suffix in ('', '-wal', '-shm', '-journal'):
        _external_path(directory / f'courseweave.db{suffix}', root)
    return directory, lock, registry


def _registered_identity(root: Path, registry: Path) -> str | None:
    try:
        data = json.loads(registry.read_text())
        if set(data) != {'course_id', 'root_fingerprint'} or data['root_fingerprint'] != hashlib.sha256(str(root).encode()).hexdigest():
            raise ValueError('Mismatched root')
        return TypeAdapter(Slug).validate_python(data['course_id'])
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError) as exc:
        raise StoreCorruptError('Draft identity registry is corrupt or belongs to another root') from exc


def _database_identity(root: Path, directory: Path) -> str | None:
    """A fixed explicit directory needs only SQLite as its identity authority."""
    database = directory / 'courseweave.db'
    if not database.exists():
        return None
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learner_state'").fetchone() is None:
                return None  # Initialization may have stopped before schema creation.
            row = connection.execute('SELECT json FROM learner_state WHERE singleton = 1').fetchone()
            if row is None:
                return None  # Initialization may have stopped before its first insert.
            state = LearnerState.model_validate_json(row[0])
        if state.root_fingerprint != hashlib.sha256(str(root).encode()).hexdigest():
            raise StoreCorruptError('State belongs to another course root')
        return state.course_id
    except (sqlite3.Error, ValueError, TypeError) as exc:
        raise StoreCorruptError('Learner state is corrupt') from exc


def has_persisted_store(course_root: Path, *, state_dir: Path | None = None) -> bool:
    """Discover external state without materializing an untouched Author root."""
    root = Path(course_root).resolve()
    initial_id = empty_manifest_draft(root).id
    directory, _, registry = _storage_paths(root, initial_id, state_dir)
    selected_id = _database_identity(root, directory) if state_dir is not None else _registered_identity(root, registry)
    if selected_id is not None:
        _storage_paths(root, selected_id, state_dir)
        return True
    return (directory / 'courseweave.db').exists()


class CourseStore:
    """One per-course SQLite store plus a lock for DB/filesystem transactions."""

    def __init__(
        self, course_root: Path, *, state_dir: Path | None = None, course_id: str | None = None, crash_hook: CrashHook | None = None
    ) -> None:
        self.course_root = Path(course_root).resolve()
        self._explicit_state_dir = state_dir is not None
        self._state_dir_override = state_dir
        self.root_fingerprint = hashlib.sha256(str(self.course_root).encode()).hexdigest()
        initial_id = TypeAdapter(Slug).validate_python(course_id) if course_id else empty_manifest_draft(self.course_root).id
        self.state_dir, self.lock_path, self.registry_path = _storage_paths(self.course_root, initial_id, state_dir)
        self.course_id = self._selected_identity(initial_id)
        _storage_paths(self.course_root, self.course_id, state_dir)
        self.crash_hook = crash_hook
        self.lock_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._locked(validate_identity=False):
            self.course_id = self._selected_identity(initial_id)
            self._select_storage()
            self._migrate()
            self._get_state_unlocked()  # Reject mismatched existing state before registering it.
            self._persist_identity()
        self.recover()

    def _selected_identity(self, initial_id: str) -> str:
        registered = self._stored_identity()
        try:
            saved_id = load_manifest(self.course_root).id
        except ManifestNotFoundError:
            return registered or initial_id
        if registered is not None and registered != saved_id:
            raise StoreCorruptError('Saved course identity differs from registered state')
        return saved_id

    def _stored_identity(self) -> str | None:
        if self._explicit_state_dir:
            return _database_identity(self.course_root, self.state_dir)
        return _registered_identity(self.course_root, self.registry_path)

    def _select_storage(self) -> None:
        self.state_dir, self.lock_path, self.registry_path = _storage_paths(self.course_root, self.course_id, self._state_dir_override)
        self.db_path = self.state_dir / 'courseweave.db'
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _persist_identity(self) -> None:
        if self._explicit_state_dir:
            return  # SQLite commits the fixed directory's identity atomically.
        data = _canonical({'course_id': self.course_id, 'root_fingerprint': self.root_fingerprint}).encode()
        self._atomic_replace(self.registry_path, data, expected_hash=self._current_hash(self.registry_path))

    def rebind_empty_draft(self, course_id: str) -> CourseStore:
        """Select identity for the first Author save, before any durable work exists."""
        course_id = TypeAdapter(Slug).validate_python(course_id)
        with self._locked():
            if (self.course_root / 'courseweave.json').exists():
                raise InvalidProposalError('Saved course identity cannot be replaced')
            with self._connect() as connection:
                if self._read_state(connection).revision != 0 or connection.execute('SELECT 1 FROM proposals LIMIT 1').fetchone():
                    raise InvalidProposalError('An existing draft has durable state; reopen its chosen course identity')
            if self._explicit_state_dir:
                with self._connect() as connection, self._transaction(connection):
                    state = self._read_state(connection)
                    self._write_state(connection, state.model_copy(update={'course_id':course_id}))
                self.course_id = course_id
            else:
                _storage_paths(self.course_root, course_id, self._state_dir_override)
                self.course_id = course_id
                self._select_storage()
                self._migrate()
                self._get_state_unlocked()
            self._persist_identity()
            return self

    def get_state(self) -> LearnerState:
        with self._locked():
            return self._get_state_unlocked()

    def _get_state_unlocked(self) -> LearnerState:
        with self._connect() as connection:
            return self._read_state(connection)

    def apply_state(
        self,
        operation: StateOperation | dict[str, Any],
        expected_revision: int,
        idempotency_key: str,
    ) -> LearnerState:
        if type(expected_revision) is not int or expected_revision < 0:
            raise InvalidProposalError("State revision must be a nonnegative integer")
        parsed = self._parse_operation(operation)
        request = {"expected_revision": expected_revision, "operation": parsed}
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(
                connection, idempotency_key, "state", request
            )
            if replay is not None:
                return LearnerState.model_validate(replay)
            state = self._read_state(connection)
            if state.revision != expected_revision:
                raise RevisionMismatchError(
                    f"Expected state revision {expected_revision}, found {state.revision}"
                )
            manifest = None
            if isinstance(parsed, (PutRecord, ClearRecord, CheckAttempt)):
                manifest = load_manifest(self.course_root)
                self._check_identity(manifest.id)
                if parsed.curriculum_digest != curriculum_digest(manifest):
                    raise RevisionMismatchError("Curriculum changed; reload before submitting")
            updated = self._mutate_state(state, parsed, manifest=manifest)
            if isinstance(parsed, ResetState):
                # Privacy reset purges snapshots as well as live records. Keep only
                # the new reset receipt so its exact retry cannot delete later work.
                connection.execute('DELETE FROM idempotency')
                connection.execute('DELETE FROM intents')
                connection.execute('DELETE FROM proposals')
            self._write_state(connection, updated)
            self._idempotency_store(
                connection, idempotency_key, "state", request, updated
            )
            return updated

    def import_legacy(self, source: Path, mappings: dict[str, Any], expected_revision: int,
                      idempotency_key: str) -> LearnerState:
        """Copy a stable legacy SQLite snapshot, importing only durable record fields.

        Mapping keys are collection:module/phase/record. Even exact mappings are
        unbound review material: only explicit learner resubmission can count.
        No source database is opened, upgraded, checkpointed, or written.
        """
        source = Path(source)
        with tempfile.TemporaryDirectory(dir=self.state_dir, prefix='legacy-import-') as temporary:
            snapshots = {}
            for suffix in ('', '-wal'):
                path = Path(str(source) + suffix)
                if path.exists():
                    snapshots[suffix] = path.read_bytes()
                    Path(temporary, 'legacy.db' + suffix).write_bytes(snapshots[suffix])
            if '' not in snapshots:
                raise InvalidProposalError('Legacy database is missing')
            for suffix, content in snapshots.items():
                if Path(str(source) + suffix).read_bytes() != content:
                    raise InvalidProposalError('Legacy database changed during copy; close its runtime and retry')
            try:
                with sqlite3.connect(Path(temporary, 'legacy.db')) as copy:
                    row = copy.execute('SELECT json FROM learner_state WHERE singleton = 1').fetchone()
                    legacy = json.loads(row[0])
            except (sqlite3.Error, ValueError, TypeError):
                raise InvalidProposalError('Invalid legacy learner database') from None
        if not isinstance(legacy, dict) or legacy.get('schema_version') != 1:
            raise InvalidProposalError('Expected legacy state schema 1')
        digest = 'sha256:' + _file_hash(_canonical(legacy).encode())
        request = {'source_digest': digest, 'mappings': mappings, 'expected_revision': expected_revision}
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(connection, idempotency_key, 'legacy.import', request)
            if replay is not None:
                return LearnerState.model_validate(replay)
            state = self._read_state(connection)
            if type(expected_revision) is not int or state.revision != expected_revision:
                raise RevisionMismatchError('Learner state changed before import')
            manifest = load_manifest(self.course_root)
            self._check_identity(manifest.id)
            imports = list(state.imports)
            used = set()
            for collection in ('predictions', 'reflections', 'evidence', 'completed_phases'):
                values = legacy.get(collection, {})
                if not isinstance(values, dict):
                    raise InvalidProposalError('Malformed legacy records')
                for key, payload in values.items():
                    if not isinstance(payload, dict) or set(payload) - {'type', 'module_id', 'phase_id', 'record_id', 'text', 'reference', 'note'}:
                        raise InvalidProposalError('Malformed legacy record fields')
                    source_key = f'{collection}:{key}'
                    coordinate = None
                    status = 'orphan'
                    if source_key in mappings:
                        used.add(source_key)
                        try:
                            coordinate = Coordinate.model_validate(mappings[source_key])
                            find_requirement(manifest, coordinate)
                        except (ValueError, ValidationError):
                            raise InvalidProposalError('An explicit legacy mapping does not resolve') from None
                        status = 'unbound'
                    if not any(i.source_digest == digest and i.source_key == source_key for i in imports):
                        imports.append(LegacyImport(source_digest=digest, source_key=source_key,
                            coordinate=coordinate, status=status, payload=payload))
            if used != set(mappings):
                raise InvalidProposalError('An explicit mapping has no source record')
            updated = state.model_copy(update={'revision': state.revision + 1, 'imports': tuple(imports)})
            self._write_state(connection, updated)
            self._idempotency_store(connection, idempotency_key, 'legacy.import', request, updated)
            return updated

    def save_course_manifest(
        self,
        manifest: Any,
        if_match: str,
        idempotency_key: str,
    ) -> ManifestSnapshot:
        request = {
            "if_match": if_match,
            "manifest": manifest.model_dump(mode="json"),
        }
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(
                connection, idempotency_key, "manifest", request
            )
            if replay is not None:
                raw = replay["raw_bytes"].encode("utf-8")
                return ManifestSnapshot(
                    manifest=parse_manifest_data(replay["manifest"], self.course_root),
                    raw_bytes=raw,
                    etag=replay["etag"],
                )
            self._check_identity(manifest.id)
            snapshot = save_manifest(self.course_root, manifest, if_match=if_match)
            response = {
                "manifest": snapshot.manifest.model_dump(mode="json"),
                "raw_bytes": snapshot.raw_bytes.decode("utf-8"),
                "etag": snapshot.etag,
            }
            self._idempotency_store(
                connection, idempotency_key, "manifest", request, response
            )
            return snapshot

    def list_proposals(self) -> list[Proposal]:
        with self._locked(), self._connect() as connection:
            rows = connection.execute(
                """
                SELECT p.*
                FROM proposals p
                JOIN (
                    SELECT id, MAX(revision) AS revision
                    FROM proposals GROUP BY id
                ) latest USING (id, revision)
                ORDER BY p.created_order, p.id
                """
            ).fetchall()
            return [self._proposal_from_row(row) for row in rows]

    def proposal_history(self, proposal_id: str) -> list[Proposal]:
        with self._locked(), self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM proposals WHERE id = ? ORDER BY revision",
                (proposal_id,),
            ).fetchall()
            return [self._proposal_from_row(row) for row in rows]

    def create_proposal(
        self, request: ProposalRequest | dict[str, Any], idempotency_key: str
    ) -> Proposal:
        parsed = self._parse_proposal_request(request)
        request_value = parsed.model_dump(mode="json")
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(
                connection, idempotency_key, "proposal.create", request_value
            )
            if replay is not None:
                return Proposal.model_validate(replay)
            normalized = self._validate_proposal_request(parsed)
            proposal_id = parsed.id or str(uuid.uuid4())
            exists = connection.execute(
                "SELECT 1 FROM proposals WHERE id = ?", (proposal_id,)
            ).fetchone()
            if exists:
                raise ProposalConflictError(f"Proposal {proposal_id!r} already exists")
            proposal = Proposal(
                id=proposal_id,
                revision=1,
                type=parsed.type,
                origin=parsed.origin,
                status="pending",
                summary=parsed.summary,
                created_at=datetime.now(UTC).isoformat(),
                target=normalized["target"],
                payload=normalized["payload"],
                target_hash=normalized["target_hash"],
                result=None,
            )
            self._insert_proposal(connection, proposal)
            self._idempotency_store(
                connection,
                idempotency_key,
                "proposal.create",
                request_value,
                proposal,
            )
            return proposal

    def edit_proposal(
        self,
        proposal_id: str,
        expected_revision: int,
        request: ProposalEdit | dict[str, Any],
        idempotency_key: str,
    ) -> Proposal:
        try:
            edit = (
                request
                if isinstance(request, ProposalEdit)
                else ProposalEdit.model_validate(request)
            )
        except ValidationError as exc:
            raise InvalidProposalError("Invalid proposal edit") from exc
        request_value = {
            "id": proposal_id,
            "expected_revision": expected_revision,
            "edit": edit,
        }
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(
                connection, idempotency_key, "proposal.edit", request_value
            )
            if replay is not None:
                return Proposal.model_validate(replay)
            current = self._require_proposal(
                connection, proposal_id, expected_revision, "pending"
            )
            merged = ProposalRequest(
                id=current.id,
                type=current.type,  # type: ignore[arg-type]
                origin=current.origin,  # type: ignore[arg-type]
                summary=edit.summary or current.summary,
                target=current.target,
                payload=edit.payload or current.payload,
                target_hash=(
                    edit.target_hash
                    if edit.target_hash is not None
                    else current.target_hash
                ),
            )
            normalized = self._validate_proposal_request(merged)
            connection.execute(
                "UPDATE proposals SET status = 'superseded' WHERE id = ? AND revision = ?",
                (proposal_id, expected_revision),
            )
            next_proposal = Proposal(
                id=current.id,
                revision=current.revision + 1,
                type=current.type,
                origin=current.origin,
                status="pending",
                summary=merged.summary,
                created_at=datetime.now(UTC).isoformat(),
                target=normalized["target"],
                payload=normalized["payload"],
                target_hash=normalized["target_hash"],
                result=None,
            )
            self._insert_proposal(connection, next_proposal)
            self._idempotency_store(
                connection,
                idempotency_key,
                "proposal.edit",
                request_value,
                next_proposal,
            )
            return next_proposal

    def reject_proposal(
        self, proposal_id: str, expected_revision: int, idempotency_key: str
    ) -> Proposal:
        request = {"id": proposal_id, "revision": expected_revision}
        with self._locked(), self._connect() as connection, self._transaction(connection):
            replay = self._idempotency_lookup(
                connection, idempotency_key, "proposal.reject", request
            )
            if replay is not None:
                return Proposal.model_validate(replay)
            proposal = self._require_proposal(
                connection, proposal_id, expected_revision, "pending"
            )
            rejected = proposal.model_copy(
                update={"status": "rejected", "result": {"applied": False}}
            )
            self._update_proposal(connection, rejected)
            state = self._append_audit(self._read_state(connection), rejected)
            self._write_state(connection, state)
            self._idempotency_store(
                connection,
                idempotency_key,
                "proposal.reject",
                request,
                rejected,
            )
            return rejected

    def accept_proposal(
        self, proposal_id: str, expected_revision: int, idempotency_key: str
    ) -> Proposal:
        request = {"id": proposal_id, "revision": expected_revision}
        with self._locked():
            with self._connect() as connection, self._transaction(connection):
                replay = self._idempotency_lookup(
                    connection, idempotency_key, "proposal.accept", request
                )
                if replay is not None:
                    return Proposal.model_validate(replay)
                proposal = self._require_proposal(
                    connection, proposal_id, expected_revision, "pending"
                )
            if proposal.type == "workspace_file_replace":
                return self._accept_workspace(proposal, idempotency_key, request)
            return self._accept_non_workspace(proposal, idempotency_key, request)

    def recover(self) -> list[Proposal]:
        recovered: list[Proposal] = []
        with self._locked(), self._connect() as connection:
            intents = connection.execute(
                "SELECT * FROM intents WHERE status = 'prepared' ORDER BY created_order"
            ).fetchall()
            for intent in intents:
                proposal = self._proposal_by_revision(
                    connection, intent["proposal_id"], intent["proposal_revision"]
                )
                if proposal is None or proposal.status != "pending":
                    with self._transaction(connection):
                        connection.execute(
                            "UPDATE intents SET status = 'finalized' WHERE proposal_id = ? AND proposal_revision = ?",
                            (intent["proposal_id"], intent["proposal_revision"]),
                        )
                    continue
                target = self._workspace_target_path(proposal)
                current_hash = self._current_hash(target)
                if current_hash == intent["after_hash"]:
                    result = {"applied": True, "recovered": True}
                    status = "accepted"
                elif current_hash == intent["before_hash"]:
                    result = {"applied": False, "error": "interrupted_before_replace"}
                    status = "failed"
                else:
                    result = {"applied": False, "error": "target_changed"}
                    status = "failed"
                final = proposal.model_copy(update={"status": status, "result": result})
                with self._transaction(connection):
                    self._update_proposal(connection, final)
                    state = self._append_audit(self._read_state(connection), final)
                    self._write_state(connection, state)
                    connection.execute(
                        "UPDATE intents SET status = 'finalized' WHERE proposal_id = ? AND proposal_revision = ?",
                        (proposal.id, proposal.revision),
                    )
                    self._idempotency_store(
                        connection,
                        intent["idempotency_key"],
                        "proposal.accept",
                        {"id": proposal.id, "revision": proposal.revision},
                        final,
                    )
                recovered.append(final)
        return recovered

    def _accept_non_workspace(
        self, proposal: Proposal, idempotency_key: str, request: dict[str, Any]
    ) -> Proposal:
        with self._connect() as connection, self._transaction(connection):
            proposal = self._require_proposal(
                connection, proposal.id, proposal.revision, "pending"
            )
            state = self._read_state(connection)
            if proposal.type == "profile_patch":
                changes = proposal.payload["changes"]
                if not isinstance(changes, dict):
                    raise InvalidProposalError("profile_patch changes must be an object")
                if not state.preferences.enabled:
                    raise InvalidProposalError('Enable adaptation preferences before accepting a profile proposal')
                try:
                    preferences = AdaptationPreferences.model_validate({**state.preferences.model_dump(), **changes})
                except ValidationError:
                    raise InvalidProposalError('Invalid adaptation preferences') from None
                state = state.model_copy(update={'preferences':preferences})
                result: dict[str, JsonValue] = {"applied": True}
            elif proposal.type == "manifest_replace":
                manifest_path = self.course_root / "courseweave.json"
                current = manifest_path.read_bytes() if manifest_path.exists() else None
                current_hash = _file_hash(current) if current is not None else None
                if current_hash != proposal.target_hash:
                    raise TargetChangedError("Manifest target hash changed")
                manifest = parse_manifest_data(
                    proposal.payload["manifest"], self.course_root
                )
                self._check_identity(manifest.id)
                snapshot = save_manifest(
                    self.course_root, manifest, if_match=manifest_etag(current) if current is not None else '""'
                )
                result = {"applied": True, "etag": snapshot.etag}
            else:
                raise InvalidProposalError(f"Unsupported proposal type {proposal.type}")
            accepted = proposal.model_copy(
                update={"status": "accepted", "result": result}
            )
            self._update_proposal(connection, accepted)
            state = self._append_audit(state, accepted)
            self._write_state(connection, state)
            self._idempotency_store(
                connection,
                idempotency_key,
                "proposal.accept",
                request,
                accepted,
            )
            return accepted

    def _accept_workspace(
        self, proposal: Proposal, idempotency_key: str, request: dict[str, Any]
    ) -> Proposal:
        target = self._workspace_target_path(proposal)
        content = proposal.payload["content"]
        if not isinstance(content, str):
            raise InvalidProposalError("Workspace content must be text")
        after_bytes = content.encode("utf-8")
        before_hash = self._current_hash(target)
        if before_hash != proposal.target_hash:
            raise TargetChangedError("Workspace target hash changed")
        after_hash = _file_hash(after_bytes)
        self._crash("before_intent")
        with self._connect() as connection, self._transaction(connection):
            self._require_proposal(
                connection, proposal.id, proposal.revision, "pending"
            )
            connection.execute(
                """
                INSERT INTO intents (
                    proposal_id, proposal_revision, target_path, before_hash,
                    after_hash, idempotency_key, status
                ) VALUES (?, ?, ?, ?, ?, ?, 'prepared')
                """,
                (
                    proposal.id,
                    proposal.revision,
                    str(proposal.target["path"]),
                    before_hash,
                    after_hash,
                    idempotency_key,
                ),
            )
        self._crash("after_intent")
        self._atomic_replace(target, after_bytes, expected_hash=before_hash)
        self._crash("after_replace")
        self._crash("before_finalize")
        accepted = proposal.model_copy(
            update={
                "status": "accepted",
                "result": {"applied": True, "target_hash": after_hash},
            }
        )
        with self._connect() as connection, self._transaction(connection):
            self._update_proposal(connection, accepted)
            state = self._append_audit(self._read_state(connection), accepted)
            self._write_state(connection, state)
            connection.execute(
                "UPDATE intents SET status = 'finalized' WHERE proposal_id = ? AND proposal_revision = ?",
                (proposal.id, proposal.revision),
            )
            self._idempotency_store(
                connection,
                idempotency_key,
                "proposal.accept",
                request,
                accepted,
            )
        return accepted

    def _validate_proposal_request(
        self, request: ProposalRequest
    ) -> dict[str, Any]:
        target_hash = request.target_hash
        if request.type == "profile_patch":
            if request.target != "learner_profile":
                raise InvalidProposalError("profile_patch target must be learner_profile")
            changes = request.payload.get("changes")
            if not isinstance(changes, dict) or not changes:
                raise InvalidProposalError("profile_patch changes must be non-empty")
            if set(request.payload) != {'changes'} or set(changes) - {'explanation', 'practice'}:
                raise InvalidProposalError('Profile proposals contain only declared adaptation preferences')
            try:
                AdaptationPreferences.model_validate(changes)
            except ValidationError:
                raise InvalidProposalError('Invalid adaptation preferences') from None
        elif request.type == "manifest_replace":
            if request.target != "courseweave.json":
                raise InvalidProposalError(
                    "manifest_replace target must be courseweave.json"
                )
            manifest = parse_manifest_data(
                request.payload.get("manifest"), self.course_root
            )
            manifest_path = self.course_root / "courseweave.json"
            current = manifest_path.read_bytes() if manifest_path.exists() else None
            current_hash = _file_hash(current) if current is not None else None
            if target_hash is None:
                target_hash = current_hash
            if target_hash != current_hash:
                raise TargetChangedError("Manifest target hash changed")
            request = request.model_copy(
                update={
                    "payload": {"manifest": manifest.model_dump(mode="json")},
                    "target_hash": target_hash,
                }
            )
        elif request.type == "workspace_file_replace":
            path = self._workspace_path_from_target(request.target)
            content = request.payload.get("content")
            diff = request.payload.get("diff")
            if not isinstance(content, str) or not isinstance(diff, str):
                raise InvalidProposalError(
                    "workspace payload requires text content and diff"
                )
            target_hash = self._validate_workspace_target(path, content, target_hash)
            request = request.model_copy(update={"target_hash": target_hash})
        return {
            "target": request.target,
            "payload": request.payload,
            "target_hash": request.target_hash,
        }

    def _validate_workspace_target(
        self, relative: str, content: str, expected_hash: str | None
    ) -> str | None:
        manifest = load_manifest(self.course_root)
        if not any(
            fnmatch.fnmatchcase(relative, pattern)
            for pattern in manifest.policies.workspace_write_globs
        ):
            raise InvalidProposalError("Workspace target is outside allowed globs")
        target = (self.course_root / relative).resolve(strict=False)
        try:
            target.relative_to(self.course_root)
        except ValueError as exc:
            raise InvalidProposalError("Workspace target escapes course root") from exc
        lexical = self.course_root / relative
        if lexical.is_symlink():
            raise InvalidProposalError("Workspace target must not be a symlink")
        if lexical.exists():
            if not lexical.is_file():
                raise InvalidProposalError("Workspace target must be one regular file")
            data = lexical.read_bytes()
            self._validate_text_bytes(data)
            current_hash = _file_hash(data)
        else:
            parent = lexical.parent.resolve(strict=False)
            try:
                parent.relative_to(self.course_root)
            except ValueError as exc:
                raise InvalidProposalError("Workspace parent escapes course root") from exc
            current_hash = None
        self._validate_text_bytes(content.encode("utf-8"))
        if expected_hash != current_hash:
            raise TargetChangedError("Workspace target hash changed")
        return current_hash

    def _workspace_path_from_target(self, target: JsonValue) -> str:
        if not isinstance(target, dict) or set(target) != {"path"}:
            raise InvalidProposalError("Workspace target requires exactly one path")
        path = target["path"]
        if not isinstance(path, str) or not path or "\\" in path:
            raise InvalidProposalError("Workspace target path is invalid")
        if path.startswith("/") or ".." in path.split("/"):
            raise InvalidProposalError("Workspace target path is invalid")
        return path

    def _workspace_target_path(self, proposal: Proposal) -> Path:
        relative = self._workspace_path_from_target(proposal.target)
        return self.course_root / relative

    @staticmethod
    def _validate_text_bytes(data: bytes) -> None:
        if len(data) > MAX_TEXT_BYTES:
            raise InvalidProposalError("Workspace text exceeds 1 MiB")
        if b"\0" in data:
            raise InvalidProposalError("Workspace target must be UTF-8 text")
        if data.startswith(LFS_HEADER):
            raise InvalidProposalError("Git LFS pointer replacement is forbidden")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise InvalidProposalError("Workspace target must be UTF-8 text") from exc

    def _atomic_replace(
        self, target: Path, data: bytes, *, expected_hash: str | None
    ) -> None:
        if target.is_symlink() or self._current_hash(target) != expected_hash:
            raise TargetChangedError("Workspace target changed before replacement")
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(
            prefix=".courseweave.", suffix=".tmp", dir=target.parent
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, target)
            dir_descriptor = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(dir_descriptor)
            finally:
                os.close(dir_descriptor)
        except BaseException:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    def _mutate_state(
        self,
        state: LearnerState,
        operation: StateOperation,
        *,
        increment: bool = True,
        manifest: Any = None,
    ) -> LearnerState:
        update: dict[str, Any] = {}
        if isinstance(operation, (PutRecord, ClearRecord)):
            assert manifest is not None
            try:
                requirement = find_requirement(manifest, operation.coordinate)
                if requirement.type != 'learner_record':
                    raise ValueError()
                records = [r for r in state.records if r.coordinate != operation.coordinate]
                if isinstance(operation, PutRecord):
                    records.append(bind_record(manifest, operation.coordinate, operation.value))
                update['records'] = tuple(records)
            except (ValueError, ValidationError):
                raise InvalidProposalError("Invalid learner coordinate or record value") from None
        elif isinstance(operation, SetTimeBudget):
            update['time_budget_minutes'] = operation.minutes
        elif isinstance(operation, SetPreferences):
            update['preferences'] = operation.preferences
            if not operation.preferences.enabled:
                update['profile'] = {}
        elif isinstance(operation, CheckAttempt):
            assert manifest is not None
            try:
                phase = find_phase(manifest, operation.module_id, operation.phase_id)
                check = next(c for c in phase.learning.checks if c.id == operation.check_id)
                option = next(o for o in check.options if o.id == operation.option_id)
                objectives = [o for o in phase.learning.objectives if o.id in check.objective_ids]
            except (ValueError, AttributeError, StopIteration):
                raise InvalidProposalError("Unknown check or answer option") from None
            attempt = StoredAttempt(module_id=operation.module_id, phase_id=operation.phase_id,
                check_id=check.id, option_id=option.id,
                check_digest='sha256:' + _file_hash(_canonical(check).encode()),
                objective_digest='sha256:' + _file_hash(_canonical(objectives).encode()),
                objective_ids=check.objective_ids, correct=option.id == check.correct_option_id,
                feedback=option.feedback)
            update['attempts'] = (*state.attempts, attempt)
        elif isinstance(operation, ResetState):
            update = LearnerState(course_id=self.course_id, root_fingerprint=self.root_fingerprint).model_dump()
        if increment:
            update['revision'] = state.revision + 1
        return LearnerState.model_validate({**state.model_dump(), **update})

    def _check_identity(self, course_id: str) -> None:
        if course_id != self.course_id:
            raise InvalidProposalError("Course identity changed; reopen the course")

    def _current_manifest(self):
        try:
            manifest = load_manifest(self.course_root)
        except ManifestNotFoundError:
            manifest = empty_manifest_draft(self.course_root).model_copy(update={'id':self.course_id})
        self._check_identity(manifest.id)
        return manifest

    def get_manifest(self):
        """Project the saved manifest or the selected canonical Author draft."""
        with self._locked():
            return self._current_manifest()

    def state_view(self, state: LearnerState | None = None, *, include_manifest: bool = False) -> dict[str, Any]:
        with self._locked():
            state = state or self._get_state_unlocked()
            manifest = self._current_manifest()
            attempt_statuses = []
            for index, attempt in enumerate(state.attempts):
                try:
                    phase = find_phase(manifest, attempt.module_id, attempt.phase_id)
                    check = next(c for c in phase.learning.checks if c.id == attempt.check_id)
                    objectives = [o for o in phase.learning.objectives if o.id in check.objective_ids]
                    valid = (attempt.check_digest == 'sha256:' + _file_hash(_canonical(check).encode()) and
                             attempt.objective_digest == 'sha256:' + _file_hash(_canonical(objectives).encode()))
                    status = 'valid' if valid else 'stale'
                except (ValueError, AttributeError, StopIteration):
                    status = 'orphan'
                attempt_statuses.append({'index':index, 'module_id':attempt.module_id,
                    'phase_id':attempt.phase_id, 'check_id':attempt.check_id, 'status':status})
            return {**({'manifest':manifest.model_dump(mode='json')} if include_manifest else {}),
                **state.model_dump(mode='json'), 'curriculum_digest': curriculum_digest(manifest),
                'attempt_statuses':attempt_statuses,
                'progress': evaluate_progress(manifest, state.records, self.course_root).model_dump(mode='json'),
                'teacher_availability': {f'{m.id}/{p.id}': self._available_teacher(manifest, m.id, p.id, state.records)
                    for m in manifest.modules for p in m.phases}}


    @staticmethod
    def _available_teacher(manifest, module_id, phase_id, records):
        effective = effective_teacher_policy(manifest, module_id, phase_id, records).model_dump(mode='json')
        effective['allowed_proposal_types'] = [kind for kind in effective['allowed_proposal_types'] if kind != 'workspace']
        return effective

    def _append_audit(self, state: LearnerState, proposal: Proposal) -> LearnerState:
        sequence = state.audit[-1].sequence + 1 if state.audit else 1
        summary = AuditSummary(
            sequence=sequence,
            proposal_id=proposal.id,
            proposal_revision=proposal.revision,
            status=proposal.status,  # type: ignore[arg-type]
            proposal_type=proposal.type,
        )
        return state.model_copy(
            update={
                "revision": state.revision + 1,
                "audit": (*state.audit, summary),
            }
        )

    def _parse_operation(self, operation: Any) -> StateOperation:
        try:
            return _STATE_OPERATION.validate_python(operation)
        except (ValidationError, TypeError) as exc:
            raise InvalidProposalError("Invalid learner-state operation") from exc

    @staticmethod
    def _parse_proposal_request(
        request: ProposalRequest | dict[str, Any],
    ) -> ProposalRequest:
        try:
            return (
                request
                if isinstance(request, ProposalRequest)
                else ProposalRequest.model_validate(request)
            )
        except ValidationError as exc:
            raise InvalidProposalError("Invalid proposal request") from exc

    def _migrate(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS learner_state (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    revision INTEGER NOT NULL,
                    json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS idempotency (
                    key TEXT PRIMARY KEY,
                    scope TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    response_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS proposals (
                    id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    status TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    target_json TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    target_hash TEXT,
                    result_json TEXT,
                    created_order INTEGER PRIMARY KEY AUTOINCREMENT,
                    UNIQUE (id, revision)
                );
                CREATE TABLE IF NOT EXISTS intents (
                    proposal_id TEXT NOT NULL,
                    proposal_revision INTEGER NOT NULL,
                    target_path TEXT NOT NULL,
                    before_hash TEXT,
                    after_hash TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_order INTEGER PRIMARY KEY AUTOINCREMENT,
                    UNIQUE (proposal_id, proposal_revision)
                );
                """
            )
            state = LearnerState(course_id=self.course_id, root_fingerprint=self.root_fingerprint)
            connection.execute(
                """
                INSERT OR IGNORE INTO learner_state(singleton, revision, json)
                VALUES (1, 0, ?)
                """,
                (_canonical(state),),
            )
            connection.commit()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA secure_delete = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    @contextmanager
    def _transaction(connection: sqlite3.Connection) -> Iterator[None]:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()

    @contextmanager
    def _locked(self, *, validate_identity: bool = True) -> Iterator[None]:
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            if validate_identity:
                registered = self._stored_identity()
                if registered is not None and registered != self.course_id:
                    raise CourseIdentityChangedError('Draft identity changed; reopen the course')
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _read_state(self, connection: sqlite3.Connection) -> LearnerState:
        row = connection.execute(
            "SELECT json FROM learner_state WHERE singleton = 1"
        ).fetchone()
        if row is None:
            raise StoreCorruptError("Learner state is missing")
        try:
            state = LearnerState.model_validate_json(row["json"])
            if state.course_id != self.course_id or state.root_fingerprint != self.root_fingerprint:
                raise StoreCorruptError("State belongs to another course identity")
            return state
        except (ValidationError, ValueError, TypeError) as exc:
            raise StoreCorruptError("Learner state is corrupt") from exc

    @staticmethod
    def _write_state(connection: sqlite3.Connection, state: LearnerState) -> None:
        connection.execute(
            "UPDATE learner_state SET revision = ?, json = ? WHERE singleton = 1",
            (state.revision, _canonical(state)),
        )

    def _idempotency_lookup(
        self,
        connection: sqlite3.Connection,
        key: str,
        scope: str,
        request: Any,
    ) -> Any | None:
        if not key:
            raise InvalidProposalError("Idempotency key is required")
        row = connection.execute(
            "SELECT scope, request_hash, response_json FROM idempotency WHERE key = ?",
            (key,),
        ).fetchone()
        if row is None:
            return None
        expected = _request_hash(scope, request)
        if row["scope"] != scope or row["request_hash"] != expected:
            raise IdempotencyConflictError(
                "Idempotency key was reused for a different operation"
            )
        return json.loads(row["response_json"])

    def _idempotency_store(
        self,
        connection: sqlite3.Connection,
        key: str,
        scope: str,
        request: Any,
        response: Any,
    ) -> None:
        connection.execute(
            """
            INSERT INTO idempotency(key, scope, request_hash, response_json)
            VALUES (?, ?, ?, ?)
            """,
            (key, scope, _request_hash(scope, request), _canonical(response)),
        )

    @staticmethod
    def _insert_proposal(connection: sqlite3.Connection, proposal: Proposal) -> None:
        connection.execute(
            """
            INSERT INTO proposals (
                id, revision, type, origin, status, summary, created_at,
                target_json, payload_json, target_hash, result_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                proposal.id,
                proposal.revision,
                proposal.type,
                proposal.origin,
                proposal.status,
                proposal.summary,
                proposal.created_at,
                _canonical(proposal.target),
                _canonical(proposal.payload),
                proposal.target_hash,
                _canonical(proposal.result) if proposal.result is not None else None,
            ),
        )

    @staticmethod
    def _update_proposal(connection: sqlite3.Connection, proposal: Proposal) -> None:
        connection.execute(
            """
            UPDATE proposals SET status = ?, result_json = ?
            WHERE id = ? AND revision = ?
            """,
            (
                proposal.status,
                _canonical(proposal.result) if proposal.result is not None else None,
                proposal.id,
                proposal.revision,
            ),
        )

    def _require_proposal(
        self,
        connection: sqlite3.Connection,
        proposal_id: str,
        revision: int,
        required_status: str,
    ) -> Proposal:
        proposal = self._proposal_by_revision(connection, proposal_id, revision)
        if proposal is None:
            latest = connection.execute(
                "SELECT MAX(revision) AS revision FROM proposals WHERE id = ?",
                (proposal_id,),
            ).fetchone()
            if latest is None or latest["revision"] is None:
                raise ProposalNotFoundError(f"Proposal {proposal_id!r} does not exist")
            raise RevisionMismatchError(
                f"Expected proposal revision {revision}, found {latest['revision']}"
            )
        if proposal.status != required_status:
            raise ProposalConflictError(
                f"Proposal is {proposal.status}, expected {required_status}"
            )
        return proposal

    @staticmethod
    def _proposal_by_revision(
        connection: sqlite3.Connection, proposal_id: str, revision: int
    ) -> Proposal | None:
        row = connection.execute(
            "SELECT * FROM proposals WHERE id = ? AND revision = ?",
            (proposal_id, revision),
        ).fetchone()
        return CourseStore._proposal_from_row(row) if row is not None else None

    @staticmethod
    def _proposal_from_row(row: sqlite3.Row) -> Proposal:
        return Proposal(
            id=row["id"],
            revision=row["revision"],
            type=row["type"],
            origin=row["origin"],
            status=row["status"],
            summary=row["summary"],
            created_at=row["created_at"],
            target=json.loads(row["target_json"]),
            payload=json.loads(row["payload_json"]),
            target_hash=row["target_hash"],
            result=json.loads(row["result_json"]) if row["result_json"] else None,
        )

    @staticmethod
    def _current_hash(path: Path) -> str | None:
        if not path.exists():
            return None
        if path.is_symlink() or not path.is_file():
            raise InvalidProposalError("Workspace target is no longer a regular file")
        return _file_hash(path.read_bytes())

    def _crash(self, stage: str) -> None:
        if self.crash_hook is not None:
            self.crash_hook(stage)
