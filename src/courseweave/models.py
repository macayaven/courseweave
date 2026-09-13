"""Canonical manifest exports and ephemeral metadata-only navigation contracts."""
from __future__ import annotations

from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from courseweave.contracts.models import *
from courseweave.contracts.primitives import LocalPath as RelativePath
NonEmpty = DisplayText
SurfaceKind = Literal["html", "markdown", "source", "notebook", "video", "terminal", "external"]
class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

class WorkspaceContext(StrictModel):
    """Automatic navigation context. It intentionally contains metadata only."""

    source_id: Annotated[str, StringConstraints(min_length=1, max_length=240)]
    sequence: Annotated[int, Field(ge=0)]
    active_path: RelativePath | None = None
    active_cell_id: (
        Annotated[str, StringConstraints(min_length=1, max_length=160)] | None
    ) = None
    active_cell_tags: list[
        Annotated[str, StringConstraints(min_length=1, max_length=160)]
    ] = Field(default_factory=list)
    surface_kind: SurfaceKind | None = None
    explicit_module_id: Slug | None = None
    explicit_phase_id: Slug | None = None
    video_seconds: Annotated[float, Field(ge=0)] | None = None
    terminal_surface_id: Slug | None = None

    @model_validator(mode="after")
    def unique_cell_tags(self) -> WorkspaceContext:
        if len(self.active_cell_tags) != len(set(self.active_cell_tags)):
            raise ValueError("active_cell_tags must contain unique items")
        return self


class ResolutionState(StrictModel):
    """Ephemeral prior resolution supplied to the pure resolver."""

    last_module_id: Slug | None = None
    last_phase_id: Slug | None = None


class ResolvedContext(StrictModel):
    module_id: Slug | None
    phase_id: Slug | None
    surface_id: Slug | None
    reason: Literal[
        "explicit_phase",
        "cell_id",
        "cell_tag",
        "video_segment",
        "active_path",
        "terminal_surface",
        "surface_kind",
        "last_phase",
        "entry_phase",
        "empty_course",
    ]


class StoredContext(StrictModel):
    context: WorkspaceContext
    resolved: ResolvedContext
