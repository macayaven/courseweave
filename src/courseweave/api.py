"""CourseWeave FastAPI application factory.

Task 0 walking skeleton: an authenticated ``/api/health`` route, the
capability-token middleware that guards every ``/api/*`` route on loopback, and
the static learner placeholder at ``/learn/``.

Contract: ``docs/contracts/api.md`` — all ``/api/*`` requests require
``Authorization: Bearer <per-launch-capability-token>``; failures use the
common error envelope ``{"code", "message", "details"}``.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from pydantic_ai.ui.ag_ui import AGUIAdapter
from ag_ui.core import (
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    CustomEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui.encoder import EventEncoder
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from starlette.datastructures import Headers

from courseweave import __version__
from courseweave.context import (
    ContextConflictError,
    ContextRegistry,
    StaleContextError,
    resolve_context,
)
from courseweave.manifest import (
    ETagMismatchError,
    ManifestNotFoundError,
    ManifestValidationError,
    empty_manifest_draft,
    manifest_bytes,
    parse_manifest_data,
    read_manifest,
)
from courseweave.models import ResolutionState, WorkspaceContext
from courseweave.professor import (
    ProposalStager,
    ProfessorOutcome,
    ProfessorService,
    Role,
    build_professor_policy,
)
from courseweave.providers import ModelResult, ProviderConfig, create_model
from courseweave.store import (
    CourseStore,
    IdempotencyConflictError,
    ProposalConflictError,
    ProposalNotFoundError,
    RevisionMismatchError,
    StoreError,
    StoreNotConfiguredError,
    TargetChangedError,
    LearnerState,
    ProposalRequest,
)

_STATIC_ROOT = Path(__file__).parent / "static"
_SESSION_COOKIE = "courseweave_session"
_SESSION_TTL_SECONDS = 1800.0
_SHARE_TTL_SECONDS = 300.0
_CANDIDATE_TTL_SECONDS = 300.0
_INTERRUPTION_TTL_SECONDS = 300.0
_MAX_GUIDE_SESSIONS = 64
_MAX_SHARED_RUNS = 64
_MAX_PROPOSAL_CANDIDATES = 64
_MAX_INTERRUPTED_RUNS = 64
_MAX_GUIDE_HISTORIES = 128
_MAX_HISTORY_MESSAGES = 32


@dataclass(frozen=True)
class _EphemeralSlot:
    expires_at: float
    order: int


@dataclass(frozen=True)
class _SharedRun:
    kind: str
    label: str | None
    content: str
    expires_at: float
    order: int


@dataclass(frozen=True)
class _ProposalCandidate:
    request: ProposalRequest
    session_id: str
    role: Role
    source_id: str | None
    resolved: tuple[str | None, str | None, str | None]
    expires_at: float
    order: int


_SharedKey = tuple[str, Role, str, str]
_HistoryKey = tuple[str, Role, str]
_InterruptedKey = tuple[str, Role, str, str]


class _CapabilityTokenMiddleware:
    """Pure ASGI auth middleware that does not buffer streaming response sends."""

    def __init__(self, app, *, capability_token: str) -> None:
        self.app = app
        self.capability_token = capability_token

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "http" and scope["path"].startswith("/api/"):
            provided = Headers(scope=scope).get("authorization", "")
            expected = f"Bearer {self.capability_token}"
            if not hmac.compare_digest(provided.encode(), expected.encode()):
                await JSONResponse(
                    status_code=403,
                    content={
                        "code": "forbidden",
                        "message": "A valid capability token is required.",
                        "details": {},
                    },
                )(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(
    course_root: Path | None = None,
    *,
    capability_token: str | None = None,
) -> FastAPI:
    """Create the CourseWeave service application.

    ``capability_token`` pins the per-launch bearer token; when omitted a
    random token is generated per application instance and exposed as
    ``app.state.capability_token`` for the launcher.
    """
    app = FastAPI(title="CourseWeave", version=__version__)
    app.state.course_root = Path(course_root) if course_root is not None else None
    app.state.capability_token = capability_token or secrets.token_urlsafe(32)
    app.state.context_registry = None
    app.state.context_manifest_etag = None
    app.state.course_store = None
    # All process-local state is lazily expired.  The clock is injectable so
    # expiry and deterministic oldest-entry eviction do not need a daemon.
    app.state.ephemeral_clock = time.monotonic
    app.state.ephemeral_order = 0
    app.state.shared_runs: dict[_SharedKey, _SharedRun] = {}
    app.state.guide_history: dict[_HistoryKey, list[ModelMessage]] = {}
    app.state.guide_history_access: dict[_HistoryKey, _EphemeralSlot] = {}
    app.state.guide_sessions: dict[str, _EphemeralSlot] = {}
    app.state.interrupted_runs: dict[_InterruptedKey, _EphemeralSlot] = {}
    app.state.proposal_candidates: dict[str, _ProposalCandidate] = {}
    app.state.provider_config_factory = lambda: ProviderConfig.from_environ(os.environ)
    app.state.professor_model_factory = create_model
    app.add_middleware(
        _CapabilityTokenMiddleware, capability_token=app.state.capability_token
    )

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        _request: Request, _exc: RequestValidationError
    ) -> JSONResponse:
        return _error(422, "validation_error", "The request is invalid.")

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "courseweave", "version": __version__}

    @app.get("/api/course")
    async def get_course() -> Response:
        root = _configured_root(app)
        if root is None:
            return _error(
                409, "not_configured", "No course root is configured."
            )
        try:
            snapshot = read_manifest(root)
        except ManifestNotFoundError:
            draft = empty_manifest_draft(root)
            return Response(
                content=manifest_bytes(draft),
                media_type="application/json",
                headers={"ETag": '""'},
            )
        except ManifestValidationError as exc:
            return _error(422, "validation_error", "The manifest is invalid.", exc)
        return Response(
            content=snapshot.raw_bytes,
            media_type="application/json",
            headers={"ETag": snapshot.etag},
        )

    @app.put("/api/course")
    async def put_course(request: Request) -> Response:
        root = _configured_root(app)
        if root is None:
            return _error(
                409, "not_configured", "No course root is configured."
            )
        if_match = request.headers.get("if-match")
        idempotency_key = request.headers.get("idempotency-key")
        origin = request.headers.get("x-courseweave-origin")
        if not if_match or not idempotency_key or origin != "student_requested":
            return _error(
                400,
                "validation_error",
                "Manifest writes require If-Match, Idempotency-Key, and student_requested origin.",
            )
        raw_request = await request.body()
        if len(raw_request) > 1024 * 1024:
            return _error(
                413, "validation_error", "Request body exceeds the 1 MiB limit."
            )
        try:
            data = json.loads(raw_request)
            manifest = parse_manifest_data(data, root)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            return _error(422, "validation_error", "Malformed JSON.", exc)
        except ManifestValidationError as exc:
            return _error(422, "validation_error", "The manifest is invalid.", exc)

        try:
            snapshot = _course_store(app).save_course_manifest(
                manifest, if_match, idempotency_key
            )
        except ETagMismatchError as exc:
            return _error(
                409,
                "etag_mismatch",
                "The saved manifest changed; reload before saving.",
                exc,
            )
        except IdempotencyConflictError:
            return _error(
                409,
                "idempotency_conflict",
                "The idempotency key was already used for different content.",
            )
        except ManifestValidationError as exc:
            return _error(422, "validation_error", "The manifest is invalid.", exc)
        app.state.context_registry = ContextRegistry(snapshot.manifest)
        app.state.context_manifest_etag = snapshot.etag
        return Response(
            content=snapshot.raw_bytes,
            media_type="application/json",
            headers={"ETag": snapshot.etag},
        )

    @app.get("/api/context")
    async def get_context(
        source_id: str = Query(..., min_length=1, max_length=240),
    ) -> Response:
        registry_or_error = _context_registry(app)
        if isinstance(registry_or_error, Response):
            return registry_or_error
        stored = registry_or_error.get(source_id)
        if stored is None:
            return _error(
                404, "not_found", "No ephemeral context exists for that source."
            )
        return JSONResponse(stored.model_dump(mode="json"))

    @app.post("/api/context")
    async def post_context(request: Request) -> Response:
        registry_or_error = _context_registry(app)
        if isinstance(registry_or_error, Response):
            return registry_or_error
        raw_request = await request.body()
        if len(raw_request) > 1024 * 1024:
            return _error(
                413, "validation_error", "Request body exceeds the 1 MiB limit."
            )
        try:
            context = WorkspaceContext.model_validate_json(raw_request)
            resolved = registry_or_error.submit(context)
        except ValidationError as exc:
            return _error(
                422, "validation_error", "The context metadata is invalid.", exc
            )
        except StaleContextError as exc:
            return _error(
                409, "stale_context", "The context sequence is stale.", exc
            )
        except ContextConflictError as exc:
            return _error(
                409,
                "context_conflict",
                "The context sequence conflicts with accepted metadata.",
                exc,
            )
        return JSONResponse(resolved.model_dump(mode="json"))

    @app.post("/api/share")
    async def post_share(request: Request) -> Response:
        return await _share_response(app, request, "learner")

    @app.post("/api/author/share")
    async def post_author_share(request: Request) -> Response:
        return await _share_response(app, request, "author")

    @app.post("/api/guide")
    async def guide(request: Request) -> Response:
        session_id, new_session = _guide_session(app, request)
        response = await _guide_response(app, request, "learner", session_id)
        if new_session:
            response.set_cookie(_SESSION_COOKIE, session_id, httponly=True, samesite="lax")
        return response

    @app.post("/api/author/guide")
    async def author_guide(request: Request) -> Response:
        session_id, new_session = _guide_session(app, request)
        response = await _guide_response(app, request, "author", session_id)
        if new_session:
            response.set_cookie(_SESSION_COOKIE, session_id, httponly=True, samesite="lax")
        return response

    @app.get("/api/state")
    async def get_state() -> Response:
        try:
            state = _course_store(app).get_state()
        except StoreError as exc:
            return _store_error(exc)
        return JSONResponse(state.model_dump(mode="json"))

    @app.patch("/api/state")
    async def patch_state(request: Request) -> Response:
        idempotency_key = request.headers.get("idempotency-key")
        if not idempotency_key:
            return _error(
                400, "validation_error", "Idempotency-Key is required."
            )
        body_or_error = await _request_json(request)
        if isinstance(body_or_error, Response):
            return body_or_error
        body = body_or_error
        if body.get("origin") != "student_requested":
            return _error(
                403,
                "forbidden",
                "Direct learner-state changes require student_requested origin.",
            )
        try:
            state = _course_store(app).apply_state(
                body.get("operation"),
                int(body.get("expected_revision")),
                idempotency_key,
            )
        except (TypeError, ValueError):
            return _error(422, "validation_error", "The state request is invalid.")
        except StoreError as exc:
            return _store_error(exc)
        return JSONResponse(state.model_dump(mode="json"))

    @app.get("/api/proposals")
    async def list_proposals() -> Response:
        try:
            proposals = _course_store(app).list_proposals()
        except StoreError as exc:
            return _store_error(exc)
        return JSONResponse([item.model_dump(mode="json") for item in proposals])

    @app.post("/api/proposals", status_code=201)
    async def create_proposal(request: Request) -> Response:
        idempotency_key = request.headers.get("idempotency-key")
        if not idempotency_key:
            return _error(
                400, "validation_error", "Idempotency-Key is required."
            )
        body_or_error = await _request_json(request)
        if isinstance(body_or_error, Response):
            return body_or_error
        try:
            if set(body_or_error) == {"candidate_id"}:
                candidate_id = body_or_error["candidate_id"]
                if not isinstance(candidate_id, str):
                    return _error(422, "validation_error", "The proposal request is invalid.")
                candidate_or_error = _authorized_candidate(app, request, candidate_id)
                if isinstance(candidate_or_error, Response):
                    return candidate_or_error
                proposal = _course_store(app).create_proposal(
                    candidate_or_error.request, idempotency_key
                )
                return JSONResponse(proposal.model_dump(mode="json"), status_code=201)
            if body_or_error.get("origin") == "teacher_suggested":
                return _error(
                    403,
                    "forbidden",
                    "Teacher suggestions must be emitted by an authenticated guide run.",
                )
            proposal = _course_store(app).create_proposal(
                body_or_error, idempotency_key
            )
        except StoreError as exc:
            return _store_error(exc)
        return JSONResponse(
            proposal.model_dump(mode="json"), status_code=201
        )

    @app.post("/api/proposals/{proposal_id}/edit")
    async def edit_proposal(proposal_id: str, request: Request) -> Response:
        idempotency_key = request.headers.get("idempotency-key")
        if not idempotency_key:
            return _error(
                400, "validation_error", "Idempotency-Key is required."
            )
        body_or_error = await _request_json(request)
        if isinstance(body_or_error, Response):
            return body_or_error
        body = body_or_error
        try:
            proposal = _course_store(app).edit_proposal(
                proposal_id,
                int(body.get("expected_revision")),
                body.get("request", body),
                idempotency_key,
            )
        except (TypeError, ValueError):
            return _error(
                422, "validation_error", "The proposal edit is invalid."
            )
        except StoreError as exc:
            return _store_error(exc)
        return JSONResponse(proposal.model_dump(mode="json"))

    @app.post("/api/proposals/{proposal_id}/accept")
    async def accept_proposal(proposal_id: str, request: Request) -> Response:
        return await _proposal_decision(app, proposal_id, request, "accept")

    @app.post("/api/proposals/{proposal_id}/reject")
    async def reject_proposal(proposal_id: str, request: Request) -> Response:
        return await _proposal_decision(app, proposal_id, request, "reject")

    app.mount(
        "/learn",
        StaticFiles(directory=_STATIC_ROOT / "learn", html=True),
        name="learn",
    )
    return app


def _configured_root(app: FastAPI) -> Path | None:
    root = app.state.course_root
    return Path(root) if root is not None else None


def _context_registry(app: FastAPI) -> ContextRegistry | Response:
    root = _configured_root(app)
    if root is None:
        return _error(409, "not_configured", "No course root is configured.")
    try:
        snapshot = read_manifest(root)
        manifest = snapshot.manifest
        etag = snapshot.etag
    except ManifestNotFoundError:
        manifest = empty_manifest_draft(root)
        etag = '""'
    except ManifestValidationError as exc:
        return _error(422, "validation_error", "The manifest is invalid.", exc)
    if app.state.context_registry is None or app.state.context_manifest_etag != etag:
        app.state.context_registry = ContextRegistry(manifest)
        app.state.context_manifest_etag = etag
    return app.state.context_registry


def _course_store(app: FastAPI) -> CourseStore:
    root = _configured_root(app)
    if root is None:
        raise StoreNotConfiguredError("No course root is configured")
    if app.state.course_store is None:
        app.state.course_store = CourseStore(root)
    return app.state.course_store


async def _request_json(request: Request) -> dict[str, Any] | Response:
    raw = await request.body()
    if len(raw) > 1024 * 1024:
        return _error(413, "validation_error", "Request body exceeds the 1 MiB limit.")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _error(422, "validation_error", "Malformed JSON.")
    if not isinstance(value, dict):
        return _error(422, "validation_error", "The request must be a JSON object.")
    return value


async def _share_response(app: FastAPI, request: Request, role: Role) -> Response:
    """Admit one explicit excerpt under a server-issued session and resolved source."""
    session_id, new_session = _guide_session(app, request)
    registry_or_error = _context_registry(app)
    if isinstance(registry_or_error, Response):
        response = registry_or_error
    else:
        body_or_error = await _request_json(request)
        if isinstance(body_or_error, Response):
            response = body_or_error
        else:
            body = body_or_error
            allowed = {"run_id", "kind", "label", "content", "source_id"}
            if set(body) - allowed or not {"run_id", "kind", "content"} <= set(body):
                response = _error(422, "validation_error", "The Share request is invalid.")
            else:
                run_id = body.get("run_id")
                kind = body.get("kind")
                label = body.get("label")
                content = body.get("content")
                source_id = body.get("source_id")
                if (
                    not isinstance(run_id, str)
                    or not run_id
                    or len(run_id) > 240
                    or kind not in {"selection", "cell", "output", "text"}
                    or not isinstance(content, str)
                    or (label is not None and (not isinstance(label, str) or len(label) > 240))
                    or (source_id is not None and (not isinstance(source_id, str) or not source_id or len(source_id) > 240))
                ):
                    response = _error(422, "validation_error", "The Share request is invalid.")
                elif len(content) > registry_or_error.manifest.policies.max_shared_chars:
                    response = _error(422, "validation_error", "Shared content exceeds the course limit.")
                else:
                    source_or_error = _server_source(registry_or_error, source_id, require_existing=True)
                    if isinstance(source_or_error, Response):
                        response = source_or_error
                    else:
                        resolved, history_source = source_or_error
                        policy = build_professor_policy(
                            registry_or_error.manifest, resolved, LearnerState(), role
                        )
                        if not _share_is_allowed(policy, str(kind)):
                            response = _error(403, "forbidden", "Sharing is unavailable for the active phase.")
                        else:
                            _cleanup_ephemeral_state(app)
                            key: _SharedKey = (session_id, role, history_source, run_id)
                            if key in app.state.shared_runs:
                                response = _error(409, "validation_error", "A Share excerpt already exists for this run.")
                            else:
                                order = _next_ephemeral_order(app)
                                now = _ephemeral_now(app)
                                app.state.shared_runs[key] = _SharedRun(
                                    kind=str(kind), label=label, content=content,
                                    expires_at=now + _SHARE_TTL_SECONDS, order=order,
                                )
                                _trim_mapping(app.state.shared_runs, _MAX_SHARED_RUNS)
                                response = JSONResponse(
                                    {"run_id": run_id, "kind": kind, "label": label, "char_count": len(content)}
                                )
    if new_session:
        response.set_cookie(_SESSION_COOKIE, session_id, httponly=True, samesite="lax")
    return response


async def _guide_response(
    app: FastAPI, request: Request, role: Role, session_id: str
) -> Response:
    """Build trusted dependencies and return either a pre-stream error or AG-UI SSE."""
    _cleanup_ephemeral_state(app)
    raw_request = await request.body()
    recoverable_run_id = _recover_run_id(raw_request)
    if len(raw_request) > 1024 * 1024:
        if recoverable_run_id is not None:
            _clear_shared_run(app, session_id, role, recoverable_run_id)
        return _error(413, "validation_error", "Request body exceeds the 1 MiB limit.")
    try:
        run_input = AGUIAdapter.build_run_input(raw_request)
    except ValidationError:
        if recoverable_run_id is not None:
            _clear_shared_run(app, session_id, role, recoverable_run_id)
        return _error(422, "validation_error", "The AG-UI request is invalid.")

    request_text = _newest_user_text(run_input.messages)
    if request_text is None:
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return _error(422, "validation_error", "The AG-UI request requires a user message.")
    registry_or_error = _context_registry(app)
    if isinstance(registry_or_error, Response):
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return registry_or_error
    manifest = registry_or_error.manifest
    source_id = _source_id(run_input.forwarded_props)
    source_or_error = _server_source(registry_or_error, source_id)
    if isinstance(source_or_error, Response):
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return source_or_error
    resolved, history_source = source_or_error
    history_key = (session_id, role, history_source)
    try:
        store = _course_store(app)
        learner_state = store.get_state()
    except StoreError as exc:
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return _store_error(exc)

    model_factory = app.state.professor_model_factory
    professor = ProfessorService(
        manifest,
        resolved,
        learner_state,
        role,
        ProviderConfig(provider=None),
        store=store,
        model_factory=model_factory,
    )
    gate = professor.gate(request_text)
    shared, share_mismatch = _shared_for(
        app, session_id, role, history_source, run_input.run_id
    )
    if share_mismatch:
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return _error(403, "forbidden", "Share does not match the active session context.")
    if shared is not None and not _share_is_allowed(professor.policy, shared.kind):
        _clear_shared_run(app, session_id, role, run_input.run_id)
        return _error(403, "forbidden", "Sharing is unavailable for the active phase.")
    if gate is None:
        try:
            professor.provider_config = app.state.provider_config_factory()
            prepared = professor.prepare(request_text)
        except Exception:
            _clear_shared_run(app, session_id, role, run_input.run_id)
            return _error(502, "provider_error", "The provider could not be configured.")
        if isinstance(prepared, ProfessorOutcome) and prepared.status == "not_configured":
            _clear_shared_run(app, session_id, role, run_input.run_id)
            return _error(409, "not_configured", "No chat provider is configured.")
    else:
        prepared = gate

    if await request.is_disconnected():
        _clear_shared_run(app, session_id, role, run_input.run_id)
        _mark_interrupted(app, session_id, role, history_source, run_input.run_id)
        if isinstance(prepared, ModelResult) and prepared.adapter is not None:
            await prepared.adapter.aclose()
        return Response(status_code=204)

    model_request = _request_with_shared_content(request_text, shared)
    return StreamingResponse(
        _guide_events(
            app,
            professor,
            run_input.thread_id,
            run_input.run_id,
            model_request,
            prepared,
            request_text,
            app.state.guide_history.get(history_key, ()),
            history_key,
            shared,
            session_id,
            role,
            source_id,
            resolved,
        ),
        media_type=EventEncoder().get_content_type(),
    )


def _newest_user_text(messages: list[Any]) -> str | None:
    """Accept only the newest AG-UI user-authored text; all other client data is inert."""
    newest: str | None = None
    for message in messages:
        if getattr(message, "role", None) != "user":
            continue
        content = getattr(message, "content", None)
        if isinstance(content, str):
            newest = content
        elif isinstance(content, list):
            newest = "".join(
                part.text
                for part in content
                if getattr(part, "type", None) == "text"
                and isinstance(getattr(part, "text", None), str)
            )
    return newest


def _source_id(forwarded_props: Any) -> str | None:
    """Allow only a source identifier to select already-held server context."""
    if not isinstance(forwarded_props, dict):
        return None
    source_id = forwarded_props.get("source_id")
    return source_id if isinstance(source_id, str) and source_id else None


def _guide_session(app: FastAPI, request: Request) -> tuple[str, bool]:
    """Return a live, bounded process-local session or issue a fresh opaque ID."""
    _cleanup_ephemeral_state(app)
    session_id = request.cookies.get(_SESSION_COOKIE)
    if session_id is not None and session_id in app.state.guide_sessions:
        _touch_session(app, session_id)
        return session_id, False
    session_id = secrets.token_urlsafe(32)
    _touch_session(app, session_id)
    _trim_mapping(app.state.guide_sessions, _MAX_GUIDE_SESSIONS)
    return session_id, True


def _existing_session(app: FastAPI, request: Request) -> str | None:
    """Return only an unexpired server-issued cookie; REST never mints candidate authority."""
    _cleanup_ephemeral_state(app)
    session_id = request.cookies.get(_SESSION_COOKIE)
    if session_id is None or session_id not in app.state.guide_sessions:
        return None
    _touch_session(app, session_id)
    return session_id


def _server_source(
    registry: ContextRegistry, source_id: str | None, *, require_existing: bool = False
) -> tuple[Any, str] | Response:
    """Resolve a client-selected identifier only against already-held server context."""
    stored = registry.get(source_id) if source_id is not None else None
    if require_existing and source_id is not None and stored is None:
        return _error(404, "not_found", "No ephemeral context exists for that source.")
    resolved = (
        stored.resolved
        if stored is not None
        else resolve_context(
            registry.manifest,
            ResolutionState(),
            WorkspaceContext(source_id="courseweave-guide", sequence=0),
        )
    )
    return resolved, stored.context.source_id if stored is not None else _default_history_source(resolved)


def _ephemeral_now(app: FastAPI) -> float:
    return float(app.state.ephemeral_clock())


def _next_ephemeral_order(app: FastAPI) -> int:
    app.state.ephemeral_order += 1
    return app.state.ephemeral_order


def _touch_session(app: FastAPI, session_id: str) -> None:
    app.state.guide_sessions[session_id] = _EphemeralSlot(
        expires_at=_ephemeral_now(app) + _SESSION_TTL_SECONDS,
        order=_next_ephemeral_order(app),
    )


def _trim_mapping(mapping: dict[Any, Any], maximum: int) -> None:
    """Evict deterministic oldest slots after lazy expiry has run."""
    overflow = len(mapping) - maximum
    if overflow > 0:
        for key, _value in sorted(
            mapping.items(), key=lambda item: (item[1].order, repr(item[0]))
        )[:overflow]:
            mapping.pop(key, None)


def _cleanup_ephemeral_state(app: FastAPI) -> None:
    """Lazily expire and bound sessions, private excerpts, history, candidates, and interruption markers."""
    now = _ephemeral_now(app)
    for mapping in (app.state.guide_sessions, app.state.shared_runs, app.state.proposal_candidates, app.state.interrupted_runs):
        for key, value in tuple(mapping.items()):
            if value.expires_at <= now:
                mapping.pop(key, None)
    for key, access in tuple(app.state.guide_history_access.items()):
        if access.expires_at <= now or key[0] not in app.state.guide_sessions:
            app.state.guide_history_access.pop(key, None)
            app.state.guide_history.pop(key, None)
    _trim_mapping(app.state.guide_sessions, _MAX_GUIDE_SESSIONS)
    _trim_mapping(app.state.shared_runs, _MAX_SHARED_RUNS)
    _trim_mapping(app.state.proposal_candidates, _MAX_PROPOSAL_CANDIDATES)
    _trim_mapping(app.state.interrupted_runs, _MAX_INTERRUPTED_RUNS)
    _trim_mapping(app.state.guide_history_access, _MAX_GUIDE_HISTORIES)
    for key in tuple(app.state.guide_history):
        if key not in app.state.guide_history_access:
            app.state.guide_history.pop(key, None)


def _touch_history(app: FastAPI, key: _HistoryKey) -> None:
    app.state.guide_history_access[key] = _EphemeralSlot(
        expires_at=_ephemeral_now(app) + _SESSION_TTL_SECONDS,
        order=_next_ephemeral_order(app),
    )


def _shared_for(
    app: FastAPI, session_id: str, role: Role, source: str, run_id: str
) -> tuple[_SharedRun | None, bool]:
    key = (session_id, role, source, run_id)
    shared = app.state.shared_runs.get(key)
    mismatch = any(
        candidate_key[0] == session_id
        and candidate_key[1] == role
        and candidate_key[3] == run_id
        and candidate_key != key
        for candidate_key in app.state.shared_runs
    )
    return shared, mismatch


def _mark_interrupted(
    app: FastAPI, session_id: str, role: Role, source: str, run_id: str
) -> None:
    app.state.interrupted_runs[(session_id, role, source, run_id)] = _EphemeralSlot(
        expires_at=_ephemeral_now(app) + _INTERRUPTION_TTL_SECONDS,
        order=_next_ephemeral_order(app),
    )
    _trim_mapping(app.state.interrupted_runs, _MAX_INTERRUPTED_RUNS)


def _default_history_source(resolved) -> str:
    """Namespace fallback context by the server's deterministic resolution."""
    return ":".join(
        part or "none" for part in (resolved.module_id, resolved.phase_id, resolved.surface_id)
    )


def _recover_run_id(raw_request: bytes) -> str | None:
    """Recover only a plausible correlation identifier for pre-validation cleanup."""
    try:
        payload = json.loads(raw_request)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    run_id = payload.get("runId")
    return run_id if isinstance(run_id, str) and run_id else None


def _share_is_allowed(policy, kind: str) -> bool:
    """Apply server-resolved phase capabilities immediately before provider use."""
    capabilities = policy.capabilities
    if capabilities is None:
        return False
    return {
        "selection": capabilities.share_selection,
        "cell": capabilities.share_cell,
        "output": capabilities.share_output,
        "text": capabilities.share_selection,
    }[kind]


def _request_with_shared_content(
    request_text: str, shared: _SharedRun | None
) -> str:
    """Attach private excerpts to one provider request without retaining them in history."""
    if not shared:
        return request_text
    return f"{request_text}\n\n[Explicitly shared {shared.kind}]\n{shared.content}"


async def _guide_events(
    app: FastAPI,
    professor: ProfessorService,
    thread_id: str,
    run_id: str,
    request_text: str,
    prepared: ProfessorOutcome | ModelResult,
    user_text: str,
    message_history: tuple[ModelMessage, ...] | list[ModelMessage],
    history_key: tuple[str, Role, str],
    shared: _SharedRun | None,
    session_id: str,
    role: Role,
    source_id: str | None,
    resolved,
):
    """Emit official AG-UI events and clear all one-run data on every exit path."""
    encoder = EventEncoder()
    message_id = f"{run_id}-assistant"
    stager = ProposalStager() if shared is None else None
    candidate_ids: list[str] = []
    completed = False
    terminal_emitted = False
    try:
        yield encoder.encode(RunStartedEvent(threadId=thread_id, runId=run_id))
        if isinstance(prepared, ProfessorOutcome):
            content = _redact_shared_content(prepared.content or "", shared)
            yield encoder.encode(TextMessageStartEvent(messageId=message_id))
            yield encoder.encode(TextMessageContentEvent(messageId=message_id, delta=content))
        else:
            chunks: list[str] = []
            started_message = False
            redactor = _SharedChunkRedactor(shared.content if shared is not None else None)
            async with professor.stream_prepared(
                request_text,
                prepared,
                message_history=message_history,
                proposal_stager=stager,
                allow_proposals=shared is None,
            ) as result:
                async for delta in result.stream_text(delta=True, debounce_by=None):
                    if not started_message:
                        yield encoder.encode(TextMessageStartEvent(messageId=message_id))
                        started_message = True
                    if shared is None:
                        chunks.append(delta)
                    safe_delta = redactor.feed(delta)
                    if safe_delta:
                        yield encoder.encode(
                            TextMessageContentEvent(messageId=message_id, delta=safe_delta)
                        )
            if not started_message:
                yield encoder.encode(TextMessageStartEvent(messageId=message_id))
                yield encoder.encode(TextMessageContentEvent(messageId=message_id, delta=""))
            safe_remainder = redactor.flush()
            if safe_remainder:
                yield encoder.encode(
                    TextMessageContentEvent(messageId=message_id, delta=safe_remainder)
                )
            content = "".join(chunks) if shared is None else ""
        yield encoder.encode(TextMessageEndEvent(messageId=message_id))
        if stager is not None:
            for candidate in stager.candidates():
                _store_proposal_candidate(app, candidate, session_id, role, source_id, resolved)
                candidate_ids.append(str(candidate.id))
                yield encoder.encode(
                    CustomEvent(
                        name="courseweave.proposal_candidate",
                        value={"candidate": candidate.model_dump(mode="json")},
                    )
                )
        terminal_emitted = True
        yield encoder.encode(RunFinishedEvent(threadId=thread_id, runId=run_id))
        if shared is None:
            history = app.state.guide_history.setdefault(history_key, [])
            history.extend(
                [
                    ModelRequest(parts=[UserPromptPart(content=user_text)]),
                    ModelResponse(parts=[TextPart(content=content)]),
                ]
            )
            del history[:-_MAX_HISTORY_MESSAGES]
            _touch_history(app, history_key)
        completed = True
    except asyncio.CancelledError:
        _mark_interrupted(app, session_id, role, history_key[2], run_id)
        return
    except GeneratorExit:
        _mark_interrupted(app, session_id, role, history_key[2], run_id)
        raise
    except Exception:
        if terminal_emitted:
            raise
        yield encoder.encode(RunErrorEvent(message="The provider request failed."))
    finally:
        if not completed and stager is not None:
            stager.discard()
            for candidate_id in candidate_ids:
                app.state.proposal_candidates.pop(candidate_id, None)
        _clear_shared_run(app, session_id, role, run_id)


def _clear_shared_run(app: FastAPI, session_id: str, role: Role, run_id: str) -> None:
    for key in tuple(app.state.shared_runs):
        if key[0] == session_id and key[1] == role and key[3] == run_id:
            app.state.shared_runs.pop(key, None)


def _redact_shared_content(
    content: str, shared: _SharedRun | None
) -> str:
    """Do not reflect a private excerpt through an AG-UI content event."""
    redactor = _SharedChunkRedactor(shared.content if shared is not None else None)
    return redactor.feed(content) + redactor.flush()


class _SharedChunkRedactor:
    """Emit text incrementally without completing the shared excerpt."""

    def __init__(self, excerpt: str | None) -> None:
        self.excerpt = excerpt or ""
        self.failure = _kmp_failure_table(self.excerpt)
        self.state = 0

    def feed(self, chunk: str) -> str:
        if not self.excerpt:
            return chunk
        output: list[str] = []
        for char in chunk:
            next_state = self.state
            while next_state and char != self.excerpt[next_state]:
                next_state = self.failure[next_state - 1]
            if char == self.excerpt[next_state]:
                next_state += 1
            if next_state == len(self.excerpt):
                continue
            output.append(char)
            self.state = next_state
        return "".join(output)

    def flush(self) -> str:
        return ""


def _kmp_failure_table(pattern: str) -> list[int]:
    """Return the longest proper-prefix length for each pattern position."""
    failure = [0] * len(pattern)
    prefix = 0
    for position in range(1, len(pattern)):
        while prefix and pattern[position] != pattern[prefix]:
            prefix = failure[prefix - 1]
        if pattern[position] == pattern[prefix]:
            prefix += 1
        failure[position] = prefix
    return failure


def _store_proposal_candidate(
    app: FastAPI,
    request: ProposalRequest,
    session_id: str,
    role: Role,
    source_id: str | None,
    resolved,
) -> None:
    """Keep a validated guide candidate inert until the same session requests REST persistence."""
    _cleanup_ephemeral_state(app)
    now = _ephemeral_now(app)
    app.state.proposal_candidates[str(request.id)] = _ProposalCandidate(
        request=request,
        session_id=session_id,
        role=role,
        source_id=source_id,
        resolved=(resolved.module_id, resolved.phase_id, resolved.surface_id),
        expires_at=now + _CANDIDATE_TTL_SECONDS,
        order=_next_ephemeral_order(app),
    )
    _trim_mapping(app.state.proposal_candidates, _MAX_PROPOSAL_CANDIDATES)


def _authorized_candidate(
    app: FastAPI, request: Request, candidate_id: str
) -> _ProposalCandidate | Response:
    """Revalidate server-owned session, source, role, phase, and capability before REST persists."""
    session_id = _existing_session(app, request)
    candidate = app.state.proposal_candidates.get(candidate_id)
    if session_id is None or candidate is None or candidate.session_id != session_id:
        return _error(403, "forbidden", "The proposal candidate is unavailable for this session.")
    registry_or_error = _context_registry(app)
    if isinstance(registry_or_error, Response):
        return registry_or_error
    source_or_error = _server_source(registry_or_error, candidate.source_id, require_existing=True)
    if isinstance(source_or_error, Response):
        return _error(403, "forbidden", "The proposal candidate context is no longer available.")
    resolved, _history_source = source_or_error
    if (resolved.module_id, resolved.phase_id, resolved.surface_id) != candidate.resolved:
        return _error(403, "forbidden", "The proposal candidate no longer matches the active context.")
    policy = build_professor_policy(
        registry_or_error.manifest, resolved, LearnerState(), candidate.role
    )
    if (
        candidate.request.origin != "teacher_suggested"
        or candidate.request.type not in policy.proposal_types
    ):
        return _error(403, "forbidden", "The proposal candidate is no longer permitted.")
    return candidate


async def _proposal_decision(
    app: FastAPI, proposal_id: str, request: Request, action: str
) -> Response:
    idempotency_key = request.headers.get("idempotency-key")
    if not idempotency_key:
        return _error(400, "validation_error", "Idempotency-Key is required.")
    body_or_error = await _request_json(request)
    if isinstance(body_or_error, Response):
        return body_or_error
    try:
        revision = int(body_or_error.get("expected_revision"))
        store = _course_store(app)
        proposal = (
            store.accept_proposal(proposal_id, revision, idempotency_key)
            if action == "accept"
            else store.reject_proposal(proposal_id, revision, idempotency_key)
        )
    except (TypeError, ValueError):
        return _error(422, "validation_error", "The proposal decision is invalid.")
    except StoreError as exc:
        return _store_error(exc)
    return JSONResponse(proposal.model_dump(mode="json"))


def _store_error(exc: StoreError) -> JSONResponse:
    if isinstance(exc, StoreNotConfiguredError):
        return _error(409, "not_configured", "No course root is configured.")
    if isinstance(exc, RevisionMismatchError):
        return _error(
            409,
            "revision_mismatch",
            "The learner state changed; reload before saving.",
        )
    if isinstance(exc, IdempotencyConflictError):
        return _error(
            409,
            "idempotency_conflict",
            "The idempotency key was already used for a different operation.",
        )
    if isinstance(exc, ProposalNotFoundError):
        return _error(404, "not_found", "The proposal was not found.")
    if isinstance(exc, ProposalConflictError):
        return _error(
            409, "proposal_conflict", "The proposal can no longer be changed."
        )
    if isinstance(exc, TargetChangedError):
        return _error(
            409, "target_changed", "The proposal target changed; review it again."
        )
    return _error(422, "validation_error", "The mutation request is invalid.")


def _error(
    status_code: int,
    code: str,
    message: str,
    exc: Exception | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message, "details": {}},
    )
