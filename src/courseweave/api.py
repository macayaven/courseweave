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
import secrets
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from courseweave import __version__

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

    @app.middleware("http")
    async def require_capability_token(request: Request, call_next):  # noqa: ANN001, ANN202
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

    app.mount(
        "/learn",
        StaticFiles(directory=_STATIC_ROOT / "learn", html=True),
        name="learn",
    )
    return app
