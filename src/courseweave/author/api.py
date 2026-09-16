"""Author-only routes and per-project dispatch over the existing application.

The outer capability middleware authenticates before dispatch. Each child owns
one immutable course root; switching a tab never retargets another tab's writes.
"""
from pathlib import Path
import asyncio
import json
import os
import threading
from typing import Literal
from dataclasses import dataclass
from uuid import uuid4

from fastapi import Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field, ValidationError, StrictBool
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.requests import ClientDisconnect
from starlette.responses import Response

from ..contracts.models import ClosedModel, Slug
from .contracts import Sha256, Revision, SourceDecision
from .content import (
    ContentEdit, apply_change, change_diff, list_changes, read_change, read_content,
    reject_change, stage_manual_change,
)
from .project import (
    ProjectError, checked_local_path, create_project, inspect_source,
    local_directory, open_project, read_sources, update_source,
)
from .assistant import AuthorAssistantError, ContextRequest, build_author_context, parse_author_reply, replay_fingerprint
from .contracts import AuthorContext, AuthorReply, ResearchRequest
from .sources import ResearchControl, import_reference, source_excerpt, run_research, list_research_reports, read_research_report
from .quality import FindingDecision, course_coverage, delete_review, export_review, list_reviews, read_review, save_review, update_review
from .delivery import ExportRequest, export_course, export_payload, inspect_delivery, list_exports, student_inputs, build_student_handoff
from .quality import student_profile
from .preview import PreviewManager, PreviewObservations
from .backup import BackupSelection, inspect_backup, backup_project, inspect_restore, restore_backup
from .delivery import recovery_status, discard_interrupted_export


class ProjectBackup(BackupSelection):
    destination: Path
    inventory_sha256: Sha256


class InspectRestore(ClosedModel):
    archive: Path


class RestoreProject(InspectRestore):
    project_id: Slug
    archive_sha256: Sha256


class ConfirmRemoval(ClosedModel):
    confirm: Literal[True]


class CreateProject(ClosedModel):
    project_id: Slug
    source_root: Path | None = None
    selected_paths: tuple[str, ...] = Field(default=(), max_length=10_000)
    expected_inventory: Sha256 | None = None


class InspectSource(ClosedModel):
    source_root: Path


class CourseExport(ExportRequest):
    destination: Path


class StudentBundle(ClosedModel):
    export_id: Slug
    destination: Path
    student_version: Literal['0.2.0', '0.3.0']


class PreviewStart(ClosedModel):
    export_id: Slug
    student_version: Literal['0.2.0', '0.3.0']
    share_provider: StrictBool = False


class PreviewNotes(PreviewObservations):
    revision: Revision


class PreviewFileDecision(ClosedModel):
    revision: Revision
    confirm: StrictBool


class ImportReference(ClosedModel):
    path: str = Field(min_length=1, max_length=4096)


class ReviewedRevision(ClosedModel):
    reviewed_revision: Revision


class ApplyChange(ReviewedRevision):
    operation_id: Slug
    context_digest: Sha256


class AuthorRun(ClosedModel):
    context_id: Slug
    action: Literal["chat", "draft", "review"] = "chat"


class SaveDraft(ClosedModel):
    pass


@dataclass(frozen=True)
class _Context:
    id: str
    context: AuthorContext


@dataclass
class _Draft:
    history_key: tuple
    context_id: str
    context: AuthorContext
    reply: AuthorReply
    saved_change_id: str | None = None
    saved_report_id: str | None = None


def _forget_author_context(app, key, *, history=True):
    app.state.author_contexts.pop(key, None)
    for draft_id, draft in tuple(app.state.author_drafts.items()):
        if draft.history_key == key:
            app.state.author_drafts.pop(draft_id, None)
    if history:
        app.state.guide_history.pop(key, None)
        app.state.guide_attribution.pop(key, None)


def current_author_context(app, key, context_id):
    record = app.state.author_contexts.get(key)
    if record is None or record.id != context_id:
        raise AuthorAssistantError("Author scope changed or expired; preview the context again.")
    context = record.context
    try:
        fresh = build_author_context(app.state.author_project, context.selection, context.role,
            tuple(s.source_id for s in context.sources), provider_config=app.state.provider_config_factory())
        if fresh.digest != context.digest:
            raise AuthorAssistantError("Saved content or permitted sources changed; preview the context again.")
    except ProjectError:
        _forget_author_context(app, key)
        raise
    return context


async def finish_author_turn(app, professor, key, text):
    from .content import stage_change
    context = current_author_context(app, key, professor.author_context_id)
    if professor.request_action == "chat":
        return None
    reply = parse_author_reply(text, context)
    if reply.change is not None:
        try:
            stage_change(app.state.author_project, context, reply.change, validate_only=True)
        except ProjectError as exc:
            raise AuthorAssistantError(f"Draft rejected: {exc} Use manual editing or request a new draft.") from None
    draft_id = f"draft-{uuid4().hex}"
    app.state.author_drafts[draft_id] = _Draft(key, professor.author_context_id, context, reply)
    while len(app.state.author_drafts) > 128:
        app.state.author_drafts.pop(next(iter(app.state.author_drafts)))
    return {"draft_id": draft_id, "context_digest": context.digest, "reply": reply.model_dump(mode="json")}


async def author_guide_response(app, request, run_input, session_id, request_text):
    # Share the existing provider lifecycle and official AG-UI event writer.
    from ..api import _error, _guide_events, _touch_history
    from ..manifest import parse_manifest_data
    from ..models import ResolvedContext
    from ..professor import ProfessorService, ProfessorOutcome
    from ..providers import ModelResult
    from ..store import LearnerState
    from ..teaching import TurnContext
    from fastapi.responses import Response, StreamingResponse
    from ag_ui.encoder import EventEncoder
    import copy

    if not run_input.thread_id or len(run_input.thread_id) > 160:
        return _error(422, "validation_error", "A bounded conversation identifier is required.")
    key = (session_id, "author", run_input.thread_id)
    if key in app.state.guide_busy:
        return _error(409, "conversation_busy", "Wait for the current Author response to finish.")
    try:
        props = AuthorRun.model_validate(run_input.forwarded_props)
        context = current_author_context(app, key, props.context_id)
    except ValidationError:
        return _error(422, "validation_error", "Preview the selected Author context before sending.")
    except ProjectError as exc:
        return failure(409, str(exc))
    selection = context.selection
    snapshot = read_content(app.state.author_project, context.target_path, include_manifest=True)
    manifest = parse_manifest_data(snapshot["manifest"], app.state.course_root)
    resolved = ResolvedContext(module_id=selection.module_id, phase_id=selection.phase_id,
        surface_id=None, reason="explicit_phase" if selection.phase_id else "empty_course")
    config = app.state.provider_config_factory()
    professor = ProfessorService(manifest, resolved, LearnerState(), "author", config,
        model_factory=app.state.professor_model_factory, course_root=app.state.course_root,
        source_etag='"' + context.manifest_sha256 + '"', request_action=props.action, author_context=context)
    professor.author_context_id = props.context_id
    professor.turn_context = TurnContext.capture(module_id=selection.module_id, phase_id=selection.phase_id,
        surface_id=None, source_id="author-selection", manifest_etag=professor.source_etag,
        state_revision=context.project_revision, consent=False, teacher_mode=context.role, policy=None,
        lesson_scope_id=None, privacy_epoch=app.state.privacy_epoch, run_id=run_input.run_id,
        evidence_dependency=replay_fingerprint(context), evidence_references=[s.text_sha256 or s.raw_sha256 for s in context.sources],
        author={"context_id": props.context_id, "digest": context.digest, "selection": selection.model_dump(mode="json"),
            "role": context.role, "source_count": len(context.sources), "omissions": list(context.omissions)})
    replay = copy.deepcopy(app.state.guide_history.get(key, ()))
    replay = professor.bounded_replay(request_text, replay)
    if professor._input_chars(request_text, replay) > config.max_input_chars:
        return _error(422, "input_limit", "The request exceeds the input budget; shorten it or select less context.")
    try:
        prepared = professor.prepare(request_text)
    except Exception:
        return _error(502, "provider_error", "The provider could not be configured.")
    if isinstance(prepared, ProfessorOutcome):
        return _error(409, "not_configured", "No chat provider is configured. Manual Author editing remains available.")
    if await request.is_disconnected():
        if isinstance(prepared, ModelResult) and prepared.adapter is not None:
            await prepared.adapter.aclose()
        return Response(status_code=204)
    app.state.guide_busy.add(key)
    _touch_history(app, key)
    return StreamingResponse(_guide_events(app, professor, run_input.thread_id, run_input.run_id, request_text,
        prepared, request_text, replay, key, None, session_id, "author", "author-selection", resolved),
        media_type=EventEncoder().get_content_type())


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
                                 state_dir=project.state_root / "transactions", author_project=project,
                                 author_student_inputs=self.owner.state.author_student_inputs)
            child.state.provider_config_factory = self.owner.state.provider_config_factory
            child.state.professor_model_factory = self.owner.state.professor_model_factory
            # One cookie identifies the local Author session across project tabs.
            # Histories, previews and candidates remain separate in each child.
            child.state.guide_sessions = self.owner.state.guide_sessions
            child.state.author_research = self.owner.state.author_research
            child.state.author_previews = self.owner.state.author_previews
            self.children[project.project_id] = child
        return await child(scope, receive, send)


def install_routes(app, *, author_home: Path | None, author_project=None, student_runtime_inputs=None, factory):
    app.state.author_home = checked_local_path(author_home) if author_home is not None else None
    app.state.author_project = author_project
    app.state.author_student_inputs = student_runtime_inputs
    app.state.author_contexts = {}
    app.state.author_drafts = {}
    app.state.author_research = {"slot": threading.Lock(), "active": None}
    preview_root = app.state.author_home / 'previews' if app.state.author_home is not None else (
        author_project.course_root.parent.parent / '.courseweave-previews' if author_project is not None else None)
    app.state.author_previews = PreviewManager(preview_root) if preview_root else None

    async def close_previews():
        if app.state.author_previews is not None:
            await run_in_threadpool(app.state.author_previews.close)

    app.router.add_event_handler('shutdown', close_previews)
    app.state.author_projects_root = app.state.author_home / "projects" if app.state.author_home is not None else None
    if app.state.author_home is not None:
        with local_directory(app.state.author_projects_root, create=True):
            pass
        app.add_middleware(ProjectDispatcher, owner=app, factory=factory)

    @app.exception_handler(ProjectError)
    async def project_error(_request: Request, exc: ProjectError):
        return failure(409, str(exc))

    @app.exception_handler(ClientDisconnect)
    async def cancelled_body(_request: Request, _exc: ClientDisconnect):
        return Response(status_code=204)

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

    @app.post('/api/author/backups/inspect')
    async def backup_inventory(request: Request):
        if app.state.author_project is None:
            return failure(403, 'Backup requires a private author project.')
        try:
            body = await read_body(request, BackupSelection)
        except ValidationError:
            return failure(422, 'Select the saved author artifacts to back up.')
        return await run_in_threadpool(inspect_backup, app.state.author_project, body.categories)

    @app.post('/api/author/backups', status_code=201)
    async def save_backup(request: Request):
        if app.state.author_project is None:
            return failure(403, 'Backup requires a private author project.')
        try:
            body = await read_body(request, ProjectBackup)
        except ValidationError:
            return failure(422, 'Inspect the backup selection and choose a new local .tar file.')
        return await run_in_threadpool(backup_project, app.state.author_project,
            body.destination, body.categories, body.inventory_sha256)

    @app.post('/api/author/projects/restore/inspect')
    async def restore_inventory(request: Request):
        if app.state.author_home is None:
            return failure(403, 'Restore requires an Author home launch.')
        try:
            body = await read_body(request, InspectRestore)
        except ValidationError:
            return failure(422, 'Choose a local Author backup archive.')
        return await run_in_threadpool(inspect_restore, body.archive)

    @app.post('/api/author/projects/restore', status_code=201)
    async def restore_project(request: Request):
        if app.state.author_home is None:
            return failure(403, 'Restore requires an Author home launch.')
        try:
            body = await read_body(request, RestoreProject)
        except ValidationError:
            return failure(422, 'Inspect the backup and choose a new project ID before restoring.')
        project = await run_in_threadpool(restore_backup, body.archive,
            app.state.author_projects_root / body.project_id, body.archive_sha256)
        return project.model_dump(mode='json')

    @app.get('/api/author/recovery')
    def project_recovery():
        if app.state.author_project is None:
            return failure(403, 'Recovery requires a private author project.')
        return recovery_status(app.state.author_project)

    @app.post('/api/author/recovery/exports/{export_id}/discard')
    async def discard_export_staging(export_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, 'Recovery requires a private author project.')
        try:
            await read_body(request, ConfirmRemoval)
        except ValidationError:
            return failure(422, 'Confirm removal of this export attempt’s staging files.')
        return await run_in_threadpool(discard_interrupted_export, app.state.author_project, export_id)

    @app.get("/api/author/delivery")
    def delivery_inventory():
        if app.state.author_project is None:
            return failure(403, "Course delivery requires a private author project.")
        return inspect_delivery(app.state.author_project, student_profile()) | runtime_options()

    def runtime_options():
        try:
            return {'student_runtimes': sorted(student_inputs(app.state.author_student_inputs).runtimes)}
        except ProjectError as exc:
            return {'student_runtimes': [], 'student_runtime_notice': str(exc)}

    @app.post('/api/author/student-bundles', status_code=201)
    async def student_bundle(request: Request):
        if app.state.author_project is None:
            return failure(403, 'Student bundle creation requires a private author project.')
        try:
            body = await read_body(request, StudentBundle)
        except ValidationError:
            return failure(422, 'Choose a saved export, Student version and new bundle destination.')
        return await run_in_threadpool(build_student_handoff, app.state.author_project, body.export_id,
            body.destination, app.state.author_student_inputs, body.student_version)

    @app.get("/api/author/exports")
    def exports(offset: int = Query(default=0, ge=0)):
        if app.state.author_project is None:
            return failure(403, "Export receipts require a private author project.")
        return list_exports(app.state.author_project, offset=offset) | runtime_options()

    @app.post("/api/author/exports", status_code=201)
    async def new_export(request: Request):
        if app.state.author_project is None:
            return failure(403, "Course export requires a private author project.")
        try:
            body = await read_body(request, CourseExport)
        except ValidationError:
            return failure(422, "Review the inventory, course version, export kind and new destination before exporting.")
        selection = ExportRequest.model_validate(body.model_dump(exclude={"destination"}))
        result = await run_in_threadpool(export_course, app.state.author_project, body.destination, student_profile(), selection)
        return export_payload(result)

    @app.get('/api/author/previews')
    def previews(offset: int = Query(default=0, ge=0)):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        return app.state.author_previews.list(app.state.author_project, offset=offset)

    @app.post('/api/author/previews', status_code=202)
    async def start_preview(request: Request):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        try:
            body = await read_body(request, PreviewStart)
            provider = app.state.provider_config_factory() if body.share_provider else None
        except (ValidationError, ValueError):
            return failure(422, 'Choose a saved export, Student version and explicit provider-sharing decision.')
        return await run_in_threadpool(app.state.author_previews.start, app.state.author_project,
            body.export_id, app.state.author_student_inputs, body.student_version, provider=provider)

    @app.post('/api/author/previews/{preview_id}/open')
    def open_preview(preview_id: str):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        return app.state.author_previews.open(app.state.author_project, preview_id)

    @app.post('/api/author/previews/{preview_id}/stop')
    def stop_preview(preview_id: str):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        return app.state.author_previews.stop(app.state.author_project, preview_id)

    @app.post('/api/author/previews/{preview_id}/observations')
    async def preview_observations(preview_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        try:
            body = await read_body(request, PreviewNotes)
        except ValidationError:
            return failure(422, 'Choose observed surfaces/actions and bounded notes for the reviewed preview revision.')
        return await run_in_threadpool(app.state.author_previews.observe, app.state.author_project,
            preview_id, body.revision, body.model_dump(exclude={'revision'}))

    @app.post('/api/author/previews/{preview_id}/{action}')
    async def preview_files(preview_id: str, action: Literal['keep', 'discard'], request: Request):
        if app.state.author_project is None:
            return failure(403, 'Student preview requires a private author project.')
        try:
            body = await read_body(request, PreviewFileDecision)
            if not body.confirm:
                raise ValueError()
        except (ValidationError, ValueError):
            return failure(422, 'Confirm the file decision for this preview revision.')
        operation = app.state.author_previews.keep if action == 'keep' else app.state.author_previews.discard
        return await run_in_threadpool(operation, app.state.author_project, preview_id, body.revision)

    @app.post("/api/author/assistant/context")
    async def author_context(request: Request):
        from ..api import _guide_session, _touch_history, _SESSION_COOKIE
        if app.state.author_project is None:
            return failure(403, "The Author assistant requires a private author project.")
        try:
            body = await read_body(request, ContextRequest)
        except ValidationError:
            return failure(422, "Choose a valid role, saved selection and permitted sources.")
        session_id, new_session = _guide_session(app, request)
        key = (session_id, "author", body.thread_id)
        context = build_author_context(app.state.author_project, body.selection, body.role, body.source_ids,
            provider_config=app.state.provider_config_factory())
        previous = app.state.author_contexts.get(key)
        if previous is not None and previous.context.digest == context.digest:
            record = previous
        else:
            keep_history = previous is not None and replay_fingerprint(previous.context) == replay_fingerprint(context)
            _forget_author_context(app, key, history=not keep_history)
            record = _Context(f"context-{uuid4().hex}", context)
            app.state.author_contexts[key] = record
        _touch_history(app, key)
        response = JSONResponse({"context_id": record.id, "context": context.model_dump(mode="json"),
                                 "conversation_retained": bool(app.state.guide_history.get(key))})
        if new_session:
            response.set_cookie(_SESSION_COOKIE, session_id, httponly=True, samesite="lax")
        return response

    @app.post("/api/author/assistant/drafts/{draft_id}/save", status_code=201)
    async def save_author_draft(draft_id: str, request: Request):
        from ..api import _existing_session
        from .content import stage_change
        try:
            await read_body(request, SaveDraft)
        except ValidationError:
            return failure(422, "Save only the server's reviewed draft.")
        session_id = _existing_session(app, request)
        draft = app.state.author_drafts.get(draft_id)
        if draft is None or draft.history_key[0] != session_id:
            return failure(409, "This draft expired or belongs to a different session; request a new draft.")
        current_author_context(app, draft.history_key, draft.context_id)
        if draft.reply.change is None:
            return failure(409, "This reply has findings but no content change to save.")
        if draft.saved_change_id:
            change = read_change(app.state.author_project, draft.saved_change_id)
        else:
            # No await separates permission validation from this bounded save.
            change = stage_change(app.state.author_project, draft.context, draft.reply.change)
            draft.saved_change_id = change.change_id
        return change.model_dump(mode="json", exclude={"after_bytes"})

    @app.post("/api/author/assistant/drafts/{draft_id}/save-review", status_code=201)
    async def save_author_review(draft_id: str, request: Request):
        from ..api import _existing_session
        if app.state.author_project is None:
            return failure(403, "Saved reviews require a private author project.")
        try:
            await read_body(request, SaveDraft)
        except ValidationError:
            return failure(422, "Save only the server's completed review reply.")
        draft = app.state.author_drafts.get(draft_id)
        if draft is None or draft.history_key[0] != _existing_session(app, request):
            return failure(409, "This reply expired or belongs to another session; request a fresh review.")
        current_author_context(app, draft.history_key, draft.context_id)
        # Same session authority as Save draft; no await splits validation/save.
        if draft.saved_report_id:
            report = read_review(app.state.author_project, draft.saved_report_id)
        else:
            report = save_review(app.state.author_project, draft.context, draft.reply)
            draft.saved_report_id = report.report_id
        return report.model_dump(mode="json")

    @app.get("/api/author/reviews")
    def reviews(offset: int = Query(default=0, ge=0)):
        if app.state.author_project is None:
            return failure(403, "Saved reviews require a private author project.")
        reports = list_reviews(app.state.author_project, offset=offset)
        return {"reports": [report.model_dump(mode="json", include={"report_id", "role", "target_path", "status", "revision", "saved_at", "summary"}) for report in reports],
            "next_offset": offset + len(reports) if len(reports) == 20 else None}

    @app.get("/api/author/reviews/{report_id}")
    def review(report_id: str):
        if app.state.author_project is None:
            return failure(403, "Saved reviews require a private author project.")
        return read_review(app.state.author_project, report_id).model_dump(mode="json")

    @app.put("/api/author/reviews/{report_id}/findings/{claim_id}")
    async def review_decision(report_id: str, claim_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, "Review decisions require a private author project.")
        try:
            body = await read_body(request, FindingDecision)
        except ValidationError:
            return failure(422, "Choose a human disposition and reviewed revision; dismissing or revising requires a reason.")
        report = await run_in_threadpool(update_review, app.state.author_project, report_id, claim_id, body)
        return report.model_dump(mode="json")

    @app.delete("/api/author/reviews/{report_id}", status_code=204)
    async def remove_review(report_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, "Deleting reviews requires a private author project.")
        try:
            body = await read_body(request, ReviewedRevision)
        except ValidationError:
            return failure(422, "Review the saved report revision before deleting it.")
        await run_in_threadpool(delete_review, app.state.author_project, report_id, body.reviewed_revision)
        return Response(status_code=204)

    @app.get("/api/author/reviews/{report_id}/export")
    def download_review(report_id: str, revision: int = Query(ge=0)):
        if app.state.author_project is None:
            return failure(403, "Exporting reviews requires a private author project.")
        raw = export_review(app.state.author_project, report_id, revision)
        return Response(raw, media_type="application/json", headers={"Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{report_id}.json"'})

    @app.get("/api/author/coverage")
    def coverage(offset: int = Query(default=0, ge=0)):
        if app.state.author_project is None:
            return failure(403, "Coverage requires a private author project.")
        return course_coverage(app.state.author_project, offset=offset)

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

    @app.post("/api/author/sources/import", status_code=201)
    async def import_source(request: Request):
        if app.state.author_project is None:
            return failure(403, "Source import requires a private author project.")
        try:
            body = await read_body(request, ImportReference)
        except ValidationError:
            return failure(422, "Select one nonsynced local reference file.")
        record = await run_in_threadpool(import_reference, app.state.author_project, Path(body.path))
        return record.model_dump(mode="json")

    @app.get("/api/author/sources/{source_id}/text")
    def source_text(source_id: str, revision: int = Query(ge=0), start: int = Query(default=0, ge=0), limit: int = Query(default=8000, ge=1, le=8000)):
        if app.state.author_project is None:
            return failure(403, "Source review requires a private author project.")
        return source_excerpt(app.state.author_project, source_id, revision=revision, start=start, limit=limit)

    @app.get("/api/author/research")
    def research_configuration():
        if app.state.author_project is None:
            return failure(403, "Research requires a private author project.")
        active = app.state.author_research["active"]
        return {"network_enabled": False, "brave_configured": bool(os.environ.get("BRAVE_SEARCH_API_KEY")),
            "active": bool(active and active[0] == app.state.author_project.project_id),
            "busy": active is not None,
            "limits": {"queries": 2, "results": 10, "fetches": 5, "redirects": 3, "seconds": 60, "fetch_seconds": 10, "fetch_bytes": 2 * 1024 * 1024},
            "notice": "Brave Search is optional and uses the author's separate account. The author is responsible for that account's usage and charges. Discovery results are temporary and excluded from saved reports and backups. Public URL fetches do not need a search credential; respect the publisher's terms when retaining source pages."}

    @app.post("/api/author/research")
    async def research_run(request: Request):
        if app.state.author_project is None:
            return failure(403, "Research requires a private author project.")
        try:
            body = await read_body(request, ResearchRequest)
        except ValidationError:
            return failure(422, "Explicitly enable network research and review at most two queries, five URLs, and the source policy.")
        shared = app.state.author_research
        if not shared["slot"].acquire(blocking=False):
            return failure(409, "One research run is already active in this Author home; finish or cancel it first.")
        control = ResearchControl.seconds(60)
        shared["active"] = (app.state.author_project.project_id, control)
        task = asyncio.create_task(run_in_threadpool(run_research, app.state.author_project, body, control=control))
        def finished(done):
            shared["active"] = None
            shared["slot"].release()
            if not done.cancelled():
                done.exception()  # Observe failure even if the browser disconnected.
        task.add_done_callback(finished)
        try:
            while not task.done():
                await asyncio.wait({task}, timeout=0.05)
                if not task.done() and await request.is_disconnected():
                    control.cancel.set()
            report = await task
            return JSONResponse(report.model_dump(mode="json", exclude={"fetches": {"__all__": {"content"}}}),
                headers={"Cache-Control": "no-store"})
        finally:
            control.cancel.set()

    @app.post("/api/author/research/cancel", status_code=202)
    async def cancel_research(request: Request):
        if app.state.author_project is None:
            return failure(403, "Research requires a private author project.")
        try:
            await read_body(request, SaveDraft)
        except ValidationError:
            return failure(422, "Cancellation takes no additional data.")
        active = app.state.author_research["active"]
        if active is None or active[0] != app.state.author_project.project_id:
            return failure(409, "This project has no active research run. Reload its saved reports to check a finished request.")
        active[1].cancel.set()
        return {"status": "cancellation_requested", "message": "Subsequent research work will stop; completed evidence remains in the saved report."}

    @app.get("/api/author/research/reports")
    def research_reports(offset: int = Query(default=0, ge=0, le=500)):
        if app.state.author_project is None:
            return failure(403, "Research reports require a private author project.")
        reports = list_research_reports(app.state.author_project, offset=offset)
        return {"reports": [report.model_dump(mode="json", include={"report_id", "started_at", "finished_at", "status"}) for report in reports],
            "offset": offset, "next_offset": offset + 20 if len(reports) == 20 else None}

    @app.get("/api/author/research/reports/{report_id}")
    def research_report(report_id: str):
        if app.state.author_project is None:
            return failure(403, "Research reports require a private author project.")
        report = read_research_report(app.state.author_project, report_id)
        return report.model_dump(mode="json", exclude={"fetches": {"__all__": {"content"}}})

    @app.get("/api/author/content/files")
    def content_files():
        if app.state.author_project is None:
            return failure(403, "Content editing requires a private author project.")
        inventory = inspect_source(app.state.author_project.course_root)
        return {"files": [f.model_dump() for f in inventory.files], "omitted": [o.model_dump() for o in inventory.omitted]}

    @app.get("/api/author/content")
    def content(path: str):
        if app.state.author_project is None:
            return failure(403, "Content editing requires a private author project.")
        return read_content(app.state.author_project, path)

    @app.get("/api/author/changes")
    def changes(offset: int = 0):
        if app.state.author_project is None:
            return failure(403, "Content review requires a private author project.")
        return list_changes(app.state.author_project, offset=offset)

    @app.post("/api/author/changes", status_code=201)
    async def manual_change(request: Request):
        if app.state.author_project is None:
            return failure(403, "Content editing requires a private author project.")
        try:
            body = await read_body(request, ContentEdit)
        except ValidationError:
            return failure(422, "The file edit is invalid; select a supported action and saved revision.")
        change = await run_in_threadpool(stage_manual_change, app.state.author_project, body)
        return change.model_dump(mode="json", exclude={"after_bytes"})

    @app.get("/api/author/changes/{change_id}")
    def review_change(change_id: str):
        if app.state.author_project is None:
            return failure(403, "Content review requires a private author project.")
        change = read_change(app.state.author_project, change_id)
        result = {**change.model_dump(mode="json", exclude={"after_bytes"}),
                  "diff": change_diff(app.state.author_project, change_id)}
        if change.target_path.lower().endswith(".md"):
            result["text"] = change.after_bytes.decode("utf-8")
        elif change.target_path.lower().endswith(".ipynb"):
            result["notebook"] = json.loads(change.after_bytes)
        return result

    @app.post("/api/author/changes/{change_id}/apply")
    async def apply_reviewed_change(change_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, "Content review requires a private author project.")
        try:
            body = await read_body(request, ApplyChange)
        except ValidationError:
            return failure(422, "Review the exact candidate revision and use a valid operation ID.")
        receipt = await run_in_threadpool(apply_change, app.state.author_project, change_id,
            body.reviewed_revision, body.operation_id, context_digest=body.context_digest)
        return receipt.model_dump(mode="json")

    @app.post("/api/author/changes/{change_id}/reject")
    async def reject_reviewed_change(change_id: str, request: Request):
        if app.state.author_project is None:
            return failure(403, "Content review requires a private author project.")
        try:
            body = await read_body(request, ReviewedRevision)
        except ValidationError:
            return failure(422, "Review the exact candidate revision before rejecting it.")
        change = await run_in_threadpool(reject_change, app.state.author_project, change_id, body.reviewed_revision)
        return change.model_dump(mode="json", exclude={"after_bytes"})
