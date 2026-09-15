"""Author-only routes and per-project dispatch over the existing application.

The outer capability middleware authenticates before dispatch. Each child owns
one immutable course root; switching a tab never retargets another tab's writes.
"""
from pathlib import Path
from datetime import date
import os
from typing import Literal

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers

from ..contracts.models import ClosedModel, Slug
from .contracts import Sha256, Revision, SourceStatus
from .project import (
    ProjectError, checked_local_path, create_project, inspect_source,
    local_directory, open_project, read_sources, update_source,
)


class CreateProject(ClosedModel):
    project_id: Slug
    source_root: Path | None = None
    selected_paths: tuple[str, ...] = Field(default=(), max_length=10_000)
    expected_inventory: Sha256 | None = None


class InspectSource(ClosedModel):
    source_root: Path


class SourceDecision(ClosedModel):
    revision: Revision
    title: str = Field(min_length=1, max_length=500)
    publication_date: date | None = None
    status: SourceStatus
    intended_use: Literal["author_reference", "student_material"]
    redistribution: Literal["undecided", "include", "exclude"]
    review_note: str = Field(default="", max_length=4000)


def failure(status: int, message: str) -> JSONResponse:
    return JSONResponse({"code": "author_project_error", "message": message, "details": {}}, status_code=status)


class ProjectDispatcher:
    def __init__(self, app, *, owner, factory):
        self.app, self.owner, self.factory = app, owner, factory
        self.children = {}

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/") or path.startswith("/api/author/projects"):
            return await self.app(scope, receive, send)
        selected = Headers(scope=scope).get("x-courseweave-project")
        if not selected:
            if scope["method"] == "GET" and path in {"/api/health", "/api/course"}:
                return await self.app(scope, receive, send)
            return await failure(409, "Select an author project first.")(scope, receive, send)
        try:
            request = CreateProject(project_id=selected)
            project = await run_in_threadpool(open_project, self.owner.state.author_projects_root / request.project_id)
        except ValidationError:
            return await failure(422, "Invalid project ID.")(scope, receive, send)
        except ProjectError as exc:
            return await failure(409, str(exc))(scope, receive, send)
        child = self.children.get(project.project_id)
        if child is None:
            if len(self.children) >= 32:
                return await failure(429, "Open-project limit reached; restart Author to open more projects.")(scope, receive, send)
            child = self.factory(project.course_root, capability_token=self.owner.state.capability_token,
                                 state_dir=project.state_root / "transactions", author_project=project)
            child.state.provider_config_factory = self.owner.state.provider_config_factory
            child.state.professor_model_factory = self.owner.state.professor_model_factory
            self.children[project.project_id] = child
        return await child(scope, receive, send)


def install_routes(app, *, author_home: Path | None, author_project=None, factory):
    app.state.author_home = checked_local_path(author_home) if author_home is not None else None
    app.state.author_project = author_project
    app.state.author_projects_root = app.state.author_home / "projects" if app.state.author_home is not None else None
    if app.state.author_home is not None:
        with local_directory(app.state.author_projects_root, create=True):
            pass
        app.add_middleware(ProjectDispatcher, owner=app, factory=factory)

    @app.exception_handler(ProjectError)
    async def project_error(_request: Request, exc: ProjectError):
        return failure(409, str(exc))

    @app.get("/api/author/projects")
    def projects():
        home = app.state.author_projects_root
        if home is None:
            return {"enabled": False}
        projects, unavailable = [], []
        with local_directory(home) as fd:
            with os.scandir(fd) as entries:
                for index, entry in enumerate(entries):
                    if index >= 1000:
                        raise ProjectError("Author home entry limit exceeded (1,000).")
                    if entry.name.startswith("."):
                        continue
                    try:
                        project = open_project(home / entry.name)
                        projects.append(project.model_dump(mode="json"))
                    except ProjectError:
                        unavailable.append(entry.name)
        return {"enabled": True, "projects": sorted(projects, key=lambda p: p["project_id"]), "unavailable": sorted(unavailable)}

    async def read_body(request, model):
        # Do not accumulate an unbounded body from an authenticated client.
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 1024 * 1024:
                raise ProjectError("Request exceeds the 1 MiB limit.")
        return model.model_validate_json(bytes(raw))

    @app.post("/api/author/projects/inventory")
    async def inventory(request: Request):
        if app.state.author_home is None:
            return failure(403, "Project import requires an Author home launch.")
        try:
            body = await read_body(request, InspectSource)
        except ValidationError:
            return failure(422, "Choose a local source directory.")
        result = await run_in_threadpool(inspect_source, body.source_root)
        return result.model_dump(mode="json")

    @app.post("/api/author/projects", status_code=201)
    async def new_project(request: Request):
        if app.state.author_home is None:
            return failure(403, "Project creation requires an Author home launch.")
        try:
            body = await read_body(request, CreateProject)
        except ValidationError:
            return failure(422, "The project selection is invalid.")
        if body.source_root is not None and body.expected_inventory is None:
            return failure(422, "Inspect and review the source inventory before importing.")
        project = await run_in_threadpool(create_project, body.source_root, app.state.author_projects_root / body.project_id,
                                         body.selected_paths, expected_inventory=body.expected_inventory)
        return project.model_dump(mode="json")

    @app.get("/api/author/sources")
    def sources():
        if app.state.author_project is None:
            return failure(403, "Source curation requires a private author project.")
        return {"sources": [s.model_dump(mode="json") for s in read_sources(app.state.author_project)]}

    @app.put("/api/author/sources/{source_id}")
    async def source_decision(source_id: str, request: Request):
        from ..api import _course_store
        if app.state.author_project is None:
            return failure(403, "Source curation requires a private author project.")
        try:
            body = await read_body(request, SourceDecision)
        except ValidationError:
            return failure(422, "Source decision is invalid.")
        store = await run_in_threadpool(_course_store, app)
        record = await run_in_threadpool(update_source, app.state.author_project, store, source_id,
                                        body.revision, body.model_dump(exclude={"revision"}))
        return record.model_dump(mode="json")
