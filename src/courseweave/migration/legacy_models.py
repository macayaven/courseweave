"""Retained v1 reader used ONLY by explicit migration; no active runtime imports.

Copied from baseline d0251bb models.py and made coercion-strict for import.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BeforeValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

Slug = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=80,
        pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
    ),
]
NonEmpty = Annotated[
    str,
    StringConstraints(min_length=1, max_length=240, pattern=r".*\S.*"),
]


def _relative_path(value: str) -> str:
    if value.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", value):
        raise ValueError("path must be relative")
    if "\\" in value:
        raise ValueError("path must use forward slashes")
    if ".." in value.split("/"):
        raise ValueError("path must not contain a parent segment")
    return value


RelativePath = Annotated[
    str,
    StringConstraints(min_length=1, max_length=1024),
    AfterValidator(_relative_path),
]
SurfaceRole = Literal["primary", "reference", "exercise", "evidence"]
SurfaceKind = Literal[
    "html", "markdown", "source", "notebook", "video", "terminal", "external"
]


class StrictModel(BaseModel):
    """Base model that rejects fields outside the public contracts."""

    model_config = ConfigDict(extra="forbid", strict=True)


class Policies(StrictModel):
    content_sharing: Literal["explicit_only"]
    durable_mutation: Literal["proposal_or_direct_student_action"]
    terminal_execution: Literal["student_only"]
    conversation_memory: Literal["session_only"]
    max_shared_chars: Annotated[int, Field(ge=1, le=131072)]
    workspace_write_globs: list[
        Annotated[str, StringConstraints(min_length=1, max_length=1024)]
    ]

    @model_validator(mode="after")
    def unique_workspace_globs(self) -> Policies:
        if len(self.workspace_write_globs) != len(set(self.workspace_write_globs)):
            raise ValueError("workspace_write_globs must contain unique items")
        return self


class Capabilities(StrictModel):
    chat: bool
    hint_level: Literal["none", "gentle", "graduated", "full"]
    share_selection: bool
    share_cell: bool
    share_output: bool
    create_profile_proposal: bool
    create_course_proposal: bool
    create_workspace_proposal: bool


class ManualCompletion(StrictModel):
    type: Literal["manual"]


class RecordedCompletion(StrictModel):
    type: Literal["prediction_recorded", "receipt_recorded"]
    record_id: Slug


class ArtifactCompletion(StrictModel):
    type: Literal["artifact_exists"]
    record_id: Slug
    path: RelativePath


Completion = Annotated[
    ManualCompletion | RecordedCompletion | ArtifactCompletion,
    Field(discriminator="type"),
]


class HtmlSurface(StrictModel):
    id: Slug
    type: Literal["html"]
    role: SurfaceRole
    path: RelativePath


class MarkdownSurface(StrictModel):
    id: Slug
    type: Literal["markdown"]
    role: SurfaceRole
    path: RelativePath


class SourceSurface(StrictModel):
    id: Slug
    type: Literal["source"]
    role: SurfaceRole
    path: RelativePath


class NotebookMatch(StrictModel):
    cell_ids: (
        list[Annotated[str, StringConstraints(min_length=1, max_length=160)]] | None
    ) = None
    cell_tags: (
        list[Annotated[str, StringConstraints(min_length=1, max_length=160)]] | None
    ) = None

    @model_validator(mode="after")
    def nonempty_unique_match(self) -> NotebookMatch:
        if self.cell_ids is None and self.cell_tags is None:
            raise ValueError("notebook match must contain cell_ids or cell_tags")
        for name, values in (
            ("cell_ids", self.cell_ids),
            ("cell_tags", self.cell_tags),
        ):
            if values is not None:
                if not values:
                    raise ValueError(f"{name} must not be empty")
                if len(values) != len(set(values)):
                    raise ValueError(f"{name} must contain unique items")
        return self


class NotebookSurface(StrictModel):
    id: Slug
    type: Literal["notebook"]
    role: SurfaceRole
    path: RelativePath
    match: NotebookMatch | None = None


class VideoSurface(StrictModel):
    id: Slug
    type: Literal["video"]
    role: SurfaceRole
    path: RelativePath | None = None
    url: str | None = None
    start_seconds: Annotated[float, Field(ge=0)] | None = None
    end_seconds: Annotated[float, Field(gt=0)] | None = None

    @model_validator(mode="after")
    def exactly_one_source_and_ordered_range(self) -> VideoSurface:
        if (self.path is None) == (self.url is None):
            raise ValueError("video must contain exactly one of path or url")
        if self.url is not None and not self.url.startswith("https://"):
            raise ValueError("remote video url must use https")
        if (
            self.start_seconds is not None
            and self.end_seconds is not None
            and self.end_seconds <= self.start_seconds
        ):
            raise ValueError("video end_seconds must be greater than start_seconds")
        return self


class TerminalSurface(StrictModel):
    id: Slug
    type: Literal["terminal"]
    role: SurfaceRole
    label: NonEmpty
    argv: list[Annotated[str, StringConstraints(min_length=1, max_length=2048)]]
    cwd: RelativePath

    @model_validator(mode="after")
    def nonempty_argv(self) -> TerminalSurface:
        if not self.argv:
            raise ValueError("terminal argv must not be empty")
        return self


class ExternalSurface(StrictModel):
    id: Slug
    type: Literal["external"]
    role: SurfaceRole
    url: str

    @model_validator(mode="after")
    def https_url(self) -> ExternalSurface:
        if not self.url.startswith("https://"):
            raise ValueError("external url must use https")
        return self


Surface = Annotated[
    HtmlSurface
    | MarkdownSurface
    | SourceSurface
    | NotebookSurface
    | VideoSurface
    | TerminalSurface
    | ExternalSurface,
    Field(discriminator="type"),
]


class Phase(StrictModel):
    id: Slug
    title: NonEmpty
    kind: Literal[
        "orient",
        "read",
        "watch",
        "predict",
        "experiment",
        "lab",
        "review",
        "audit",
        "ship",
    ]
    teacher_mode: Literal[
        "orienter",
        "reading_companion",
        "socratic_guide",
        "debugging_coach",
        "reviewer",
        "observer",
        "curriculum_designer",
    ]
    surfaces: list[Surface]
    completion: Completion
    capabilities: Capabilities

    @model_validator(mode="after")
    def nonempty_unique_surfaces(self) -> Phase:
        if not self.surfaces:
            raise ValueError("phase surfaces must not be empty")
        ids = [surface.id for surface in self.surfaces]
        duplicate = _first_duplicate(ids)
        if duplicate is not None:
            raise ValueError(f"duplicate surface id '{duplicate}' in phase '{self.id}'")
        return self


class Module(StrictModel):
    id: Slug
    title: NonEmpty
    description: str
    phases: list[Phase]

    @model_validator(mode="after")
    def nonempty_unique_phases(self) -> Module:
        if not self.phases:
            raise ValueError("module phases must not be empty")
        ids = [phase.id for phase in self.phases]
        duplicate = _first_duplicate(ids)
        if duplicate is not None:
            raise ValueError(f"duplicate phase id '{duplicate}' in module '{self.id}'")
        return self


def _version(value: object) -> object:
    if type(value) is not int:
        raise ValueError("legacy version must be integer 1")
    return value


class CourseManifest(StrictModel):
    schema_version: Annotated[Literal[1], BeforeValidator(_version)]
    id: Slug
    title: NonEmpty
    description: str
    entry_module_id: Slug | None
    policies: Policies
    modules: list[Module]

    @model_validator(mode="after")
    def valid_unique_modules_and_entry(self) -> CourseManifest:
        ids = [module.id for module in self.modules]
        duplicate = _first_duplicate(ids)
        if duplicate is not None:
            raise ValueError(f"duplicate module id '{duplicate}'")
        if not self.modules:
            if self.entry_module_id is not None:
                raise ValueError("entry_module_id must be null when modules is empty")
        elif self.entry_module_id not in ids:
            raise ValueError("entry_module_id must identify an existing module")
        return self


def _first_duplicate(values: list[str]) -> str | None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            return value
        seen.add(value)
    return None
