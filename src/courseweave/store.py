"""Durable learner state and consented, exactly-once proposal application."""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import sqlite3
import tempfile
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from courseweave.manifest import (
    ManifestSnapshot,
    load_manifest,
    manifest_etag,
    parse_manifest_data,
    save_manifest,
)
from courseweave.models import NonEmpty, Slug, StrictModel

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


class RecordPrediction(StrictModel):
    type: Literal["record_prediction"]
    module_id: Slug
    phase_id: Slug
    record_id: Slug
    text: NonEmpty


class RecordReflection(StrictModel):
    type: Literal["record_reflection"]
    module_id: Slug
    phase_id: Slug
    record_id: Slug
    text: NonEmpty


class RecordEvidence(StrictModel):
    type: Literal["record_evidence"]
    module_id: Slug
    phase_id: Slug
    record_id: Slug
    reference: NonEmpty
    note: str = ""


class CompletePhase(StrictModel):
    type: Literal["complete_phase"]
    module_id: Slug
    phase_id: Slug
    record_id: Slug
    note: str = ""


class SetTimeBudget(StrictModel):
    type: Literal["set_time_budget"]
    minutes: Annotated[int, Field(ge=1, le=1440)]


StateOperation = Annotated[
    RecordPrediction
    | RecordReflection
    | RecordEvidence
    | CompletePhase
    | SetTimeBudget,
    Field(discriminator="type"),
]
_STATE_OPERATION = TypeAdapter(StateOperation)


class AuditSummary(StrictModel):
    sequence: int
    proposal_id: str
    proposal_revision: int
    status: Literal["accepted", "rejected", "failed"]
    proposal_type: str


class LearnerState(StrictModel):
    schema_version: Literal[1] = 1
    revision: int = 0
    predictions: dict[str, dict[str, JsonValue]] = Field(default_factory=dict)
    reflections: dict[str, dict[str, JsonValue]] = Field(default_factory=dict)
    evidence: dict[str, dict[str, JsonValue]] = Field(default_factory=dict)
    completed_phases: dict[str, dict[str, JsonValue]] = Field(default_factory=dict)
    time_budget_minutes: Annotated[int, Field(ge=1, le=1440)] | None = None
    profile: dict[str, JsonValue] = Field(default_factory=dict)
    audit: list[AuditSummary] = Field(default_factory=list)


class ProposalRequest(StrictModel):
    id: Slug | None = None
    type: Literal[
        "profile_patch",
        "manifest_replace",
        "workspace_file_replace",
        "phase_record",
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


def _record_key(operation: RecordPrediction | RecordReflection | RecordEvidence | CompletePhase) -> str:
    return f"{operation.module_id}/{operation.phase_id}/{operation.record_id}"


class CourseStore:
    """One per-course SQLite store plus a lock for DB/filesystem transactions."""

    def __init__(
        self, course_root: Path, *, crash_hook: CrashHook | None = None
    ) -> None:
        self.course_root = Path(course_root).resolve()
        self.state_dir = self.course_root / ".courseweave"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.state_dir / "courseweave.db"
        self.lock_path = self.state_dir / "courseweave.lock"
        self.crash_hook = crash_hook
        self._migrate()
        self.recover()

    def get_state(self) -> LearnerState:
        with self._connect() as connection:
            return self._read_state(connection)

    def apply_state(
        self,
        operation: StateOperation | dict[str, Any],
        expected_revision: int,
        idempotency_key: str,
    ) -> LearnerState:
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
            updated = self._mutate_state(state, parsed)
            self._write_state(connection, updated)
            self._idempotency_store(
                connection, idempotency_key, "state", request, updated
            )
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
        with self._connect() as connection:
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
        with self._connect() as connection:
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
                state = state.model_copy(
                    update={"profile": {**state.profile, **changes}}
                )
                result: dict[str, JsonValue] = {"applied": True}
            elif proposal.type == "phase_record":
                operation = self._parse_operation(proposal.payload.get("operation"))
                state = self._mutate_state(state, operation, increment=False)
                result = {"applied": True}
            elif proposal.type == "manifest_replace":
                current = (self.course_root / "courseweave.json").read_bytes()
                if _file_hash(current) != proposal.target_hash:
                    raise TargetChangedError("Manifest target hash changed")
                manifest = parse_manifest_data(
                    proposal.payload["manifest"], self.course_root
                )
                snapshot = save_manifest(
                    self.course_root, manifest, if_match=manifest_etag(current)
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
            if not all(_valid_profile_value(value) for value in changes.values()):
                raise InvalidProposalError(
                    "profile_patch values must be scalars or flat scalar lists"
                )
        elif request.type == "phase_record":
            if request.target != "learner_state":
                raise InvalidProposalError("phase_record target must be learner_state")
            operation = self._parse_operation(request.payload.get("operation"))
            request = request.model_copy(
                update={"payload": {"operation": operation.model_dump(mode="json")}}
            )
        elif request.type == "manifest_replace":
            if request.target != "courseweave.json":
                raise InvalidProposalError(
                    "manifest_replace target must be courseweave.json"
                )
            manifest = parse_manifest_data(
                request.payload.get("manifest"), self.course_root
            )
            current = (self.course_root / "courseweave.json").read_bytes()
            current_hash = _file_hash(current)
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
    ) -> LearnerState:
        update: dict[str, Any] = {}
        if isinstance(operation, RecordPrediction):
            values = dict(state.predictions)
            values[_record_key(operation)] = operation.model_dump(mode="json")
            update["predictions"] = values
        elif isinstance(operation, RecordReflection):
            values = dict(state.reflections)
            values[_record_key(operation)] = operation.model_dump(mode="json")
            update["reflections"] = values
        elif isinstance(operation, RecordEvidence):
            values = dict(state.evidence)
            values[_record_key(operation)] = operation.model_dump(mode="json")
            update["evidence"] = values
        elif isinstance(operation, CompletePhase):
            values = dict(state.completed_phases)
            values[_record_key(operation)] = operation.model_dump(mode="json")
            update["completed_phases"] = values
        elif isinstance(operation, SetTimeBudget):
            update["time_budget_minutes"] = operation.minutes
        if increment:
            update["revision"] = state.revision + 1
        return state.model_copy(update=update)

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
                "audit": [*state.audit, summary],
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
            state = LearnerState()
            connection.execute(
                """
                INSERT OR IGNORE INTO learner_state(singleton, revision, json)
                VALUES (1, 0, ?)
                """,
                (_canonical(state),),
            )
            connection.commit()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

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
    def _locked(self) -> Iterator[None]:
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @staticmethod
    def _read_state(connection: sqlite3.Connection) -> LearnerState:
        row = connection.execute(
            "SELECT json FROM learner_state WHERE singleton = 1"
        ).fetchone()
        if row is None:
            raise StoreCorruptError("Learner state is missing")
        try:
            return LearnerState.model_validate_json(row["json"])
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


def _valid_profile_value(value: Any) -> bool:
    scalar = value is None or isinstance(value, (str, int, float, bool))
    if scalar:
        return True
    return isinstance(value, list) and all(
        item is None or isinstance(item, (str, int, float, bool)) for item in value
    )
