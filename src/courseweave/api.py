"""CourseWeave FastAPI application factory.

Task 0 walking skeleton: an authenticated ``/api/health`` route, the
capability-token middleware that guards every ``/api/*`` route on loopback, and
the static learner placeholder at ``/learn/``.

Contract: ``docs/contracts/api.md`` — all ``/api/*`` requests require
``Authorization: Bearer <per-launch-capability-token>``; failures use the
common error envelope ``{"code", "message", "details"}``.
"""

from __future__ import annotations

import hmac
import json
import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from courseweave import __version__
from courseweave.context import (
    ContextConflictError,
    ContextRegistry,
    StaleContextError,
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
from courseweave.models import WorkspaceContext
from courseweave.store import (
    CourseStore,
    IdempotencyConflictError,
    ProposalConflictError,
    ProposalNotFoundError,
    RevisionMismatchError,
    StoreError,
    StoreNotConfiguredError,
    TargetChangedError,
)

_STATIC_ROOT = Path(__file__).parent / "static"


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

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(
        _request: Request, _exc: RequestValidationError
    ) -> JSONResponse:
        return _error(422, "validation_error", "The request is invalid.")

    @app.middleware("http")
    async def require_capability_token(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            provided = request.headers.get("authorization", "")
            expected = f"Bearer {app.state.capability_token}"
            if not hmac.compare_digest(provided.encode(), expected.encode()):
                return JSONResponse(
                    status_code=403,
                    content={
                        "code": "forbidden",
                        "message": "A valid capability token is required.",
                        "details": {},
                    },
                )
        return await call_next(request)

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
