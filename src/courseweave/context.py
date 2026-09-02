"""Pure deterministic phase resolution and ephemeral per-source ordering."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock

from courseweave.models import (
    CourseManifest,
    NotebookSurface,
    ResolutionState,
    ResolvedContext,
    StoredContext,
    VideoSurface,
    WorkspaceContext,
)


class ContextError(Exception):
    """Base class for ephemeral context ordering errors."""


class StaleContextError(ContextError):
    """A source submitted a sequence below its current sequence."""


class ContextConflictError(ContextError):
    """A source reused a sequence with a different metadata payload."""


@dataclass(frozen=True)
class _Candidate:
    module_id: str
    phase_id: str
    surface_id: str
    surface: object


def resolve_context(
    manifest: CourseManifest,
    state: ResolutionState,
    context: WorkspaceContext,
) -> ResolvedContext:
    """Resolve one context without reading or mutating external state."""

    explicit = _find_phase(
        manifest, context.explicit_module_id, context.explicit_phase_id
    )
    if explicit is not None:
        return _resolved(*explicit, surface_id=None, reason="explicit_phase")

    path_candidates = _path_candidates(manifest, context.active_path)
    if context.active_cell_id is not None:
        for candidate in path_candidates:
            surface = candidate.surface
            if (
                isinstance(surface, NotebookSurface)
                and surface.match is not None
                and surface.match.cell_ids is not None
                and context.active_cell_id in surface.match.cell_ids
            ):
                return _from_candidate(candidate, "cell_id")

    if context.active_cell_tags:
        active_tags = set(context.active_cell_tags)
        for candidate in path_candidates:
            surface = candidate.surface
            if (
                isinstance(surface, NotebookSurface)
                and surface.match is not None
                and surface.match.cell_tags is not None
                and active_tags.intersection(surface.match.cell_tags)
            ):
                return _from_candidate(candidate, "cell_tag")

    if context.video_seconds is not None:
        for candidate in path_candidates:
            surface = candidate.surface
            if isinstance(surface, VideoSurface) and _contains_video_second(
                surface, context.video_seconds
            ):
                return _from_candidate(candidate, "video_segment")

    if path_candidates:
        for candidate in path_candidates:
            if (
                candidate.module_id == state.last_module_id
                and candidate.phase_id == state.last_phase_id
            ):
                return _from_candidate(candidate, "active_path")
        return _from_candidate(path_candidates[0], "active_path")

    current_module_id = _current_module_id(manifest, state, context)
    current_module = next(
        (module for module in manifest.modules if module.id == current_module_id), None
    )
    if current_module is not None and context.terminal_surface_id is not None:
        for phase in current_module.phases:
            for surface in phase.surfaces:
                if (
                    surface.type == "terminal"
                    and surface.id == context.terminal_surface_id
                ):
                    return _resolved(
                        current_module.id,
                        phase.id,
                        surface_id=surface.id,
                        reason="terminal_surface",
                    )

    if current_module is not None and context.surface_kind is not None:
        for phase in current_module.phases:
            for surface in phase.surfaces:
                if surface.type == context.surface_kind:
                    return _resolved(
                        current_module.id,
                        phase.id,
                        surface_id=surface.id,
                        reason="surface_kind",
                    )

    previous = _find_phase(manifest, state.last_module_id, state.last_phase_id)
    if previous is not None:
        return _resolved(*previous, surface_id=None, reason="last_phase")

    entry = next(
        (
            module
            for module in manifest.modules
            if module.id == manifest.entry_module_id
        ),
        None,
    )
    if entry is not None:
        return _resolved(
            entry.id,
            entry.phases[0].id,
            surface_id=None,
            reason="entry_phase",
        )
    return ResolvedContext(
        module_id=None,
        phase_id=None,
        surface_id=None,
        reason="empty_course",
    )


class ContextRegistry:
    """In-memory metadata registry with ordering isolated by ``source_id``."""

    def __init__(self, manifest: CourseManifest) -> None:
        self.manifest = manifest
        self._stored: dict[str, StoredContext] = {}
        self._payloads: dict[str, bytes] = {}
        self._lock = Lock()

    def submit(self, context: WorkspaceContext) -> ResolvedContext:
        payload = context.model_dump_json().encode("utf-8")
        with self._lock:
            current = self._stored.get(context.source_id)
            if current is not None:
                if context.sequence < current.context.sequence:
                    raise StaleContextError(
                        f"Sequence {context.sequence} is below "
                        f"{current.context.sequence} for source {context.source_id!r}"
                    )
                if context.sequence == current.context.sequence:
                    if payload == self._payloads[context.source_id]:
                        return current.resolved
                    raise ContextConflictError(
                        f"Sequence {context.sequence} was reused with different metadata"
                    )
                state = ResolutionState(
                    last_module_id=current.resolved.module_id,
                    last_phase_id=current.resolved.phase_id,
                )
            else:
                state = ResolutionState()
            resolved = resolve_context(self.manifest, state, context)
            self._stored[context.source_id] = StoredContext(
                context=context, resolved=resolved
            )
            self._payloads[context.source_id] = payload
            return resolved

    def get(self, source_id: str) -> StoredContext | None:
        with self._lock:
            return self._stored.get(source_id)


def _find_phase(
    manifest: CourseManifest,
    module_id: str | None,
    phase_id: str | None,
) -> tuple[str, str] | None:
    if module_id is None or phase_id is None:
        return None
    for module in manifest.modules:
        if module.id != module_id:
            continue
        for phase in module.phases:
            if phase.id == phase_id:
                return module.id, phase.id
    return None


def _path_candidates(
    manifest: CourseManifest, active_path: str | None
) -> list[_Candidate]:
    if active_path is None:
        return []
    candidates: list[_Candidate] = []
    for module in manifest.modules:
        for phase in module.phases:
            for surface in phase.surfaces:
                if getattr(surface, "path", None) == active_path:
                    candidates.append(
                        _Candidate(module.id, phase.id, surface.id, surface)
                    )
    return candidates


def _contains_video_second(surface: VideoSurface, seconds: float) -> bool:
    start = surface.start_seconds if surface.start_seconds is not None else 0
    return seconds >= start and (
        surface.end_seconds is None or seconds < surface.end_seconds
    )


def _current_module_id(
    manifest: CourseManifest,
    state: ResolutionState,
    context: WorkspaceContext,
) -> str | None:
    module_ids = {module.id for module in manifest.modules}
    if context.explicit_module_id in module_ids:
        return context.explicit_module_id
    if state.last_module_id in module_ids:
        return state.last_module_id
    return manifest.entry_module_id


def _from_candidate(candidate: _Candidate, reason: str) -> ResolvedContext:
    return _resolved(
        candidate.module_id,
        candidate.phase_id,
        surface_id=candidate.surface_id,
        reason=reason,
    )


def _resolved(
    module_id: str,
    phase_id: str,
    *,
    surface_id: str | None,
    reason: str,
) -> ResolvedContext:
    return ResolvedContext(
        module_id=module_id,
        phase_id=phase_id,
        surface_id=surface_id,
        reason=reason,
    )

