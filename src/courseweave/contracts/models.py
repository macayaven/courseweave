"""Closed structural models for the canonical v2 course manifest."""

from __future__ import annotations

import re

from typing import Annotated, Literal, TypeAlias

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)


def _reject_schema_invalid_integer_coercion(value: object) -> object:
    if type(value) is not int:
        raise ValueError("integer fields require integer JSON numbers")
    return value


# StrictInt keeps bounds on the native integer schema, so generated JSON
# Schema emits minimum/maximum rather than ignored function-validator ge/le.
JsonInteger: TypeAlias = StrictInt
SchemaVersion: TypeAlias = Annotated[
    Literal[2], BeforeValidator(_reject_schema_invalid_integer_coercion)
]


Slug: TypeAlias = Annotated[
    str,
    Field(
        min_length=1,
        max_length=80,
        pattern=re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])"),
    ),
]
CustomIdentifier: TypeAlias = Annotated[
    str,
    Field(
        min_length=1,
        max_length=160,
        pattern=re.compile(r"^[a-z0-9]+(?:[.-][a-z0-9]+)+/[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])"),
    ),
]
DisplayText: TypeAlias = Annotated[str, Field(min_length=1, max_length=200, pattern=r".*\S.*")]
Description: TypeAlias = Annotated[str, Field(max_length=4000)]
Prompt: TypeAlias = Annotated[str, Field(min_length=1, max_length=4096, pattern=r".*\S.*")]
from .primitives import LocalPath, DirectoryPath, HttpsUrl, ReviewedDate, WorkspaceGlob, NotebookCellId, CommandToken


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, revalidate_instances="always")


class BuiltinExperience(ClosedModel):
    type: Literal["builtin"]
    id: Literal[
        "generic",
        "orientation",
        "reading",
        "media",
        "prediction",
        "experiment",
        "practice",
        "review",
        "project",
    ]


class CustomExperience(ClosedModel):
    type: Literal["custom"]
    id: CustomIdentifier


Experience: TypeAlias = Annotated[
    BuiltinExperience | CustomExperience, Field(discriminator="type")
]


class BuiltinTeacherStyle(ClosedModel):
    type: Literal["builtin"]
    id: Literal["orienting", "explanatory", "socratic", "debugging", "reviewing"]


class CustomTeacherStyle(ClosedModel):
    type: Literal["custom"]
    id: CustomIdentifier


TeacherStyle: TypeAlias = Annotated[
    BuiltinTeacherStyle | CustomTeacherStyle, Field(discriminator="type")
]


class CoursePolicies(ClosedModel):
    content_sharing: Literal["explicit_only"]
    allowed_share_kinds: tuple[Literal["selection", "cell", "output"], ...]
    max_shared_chars: Annotated[JsonInteger, Field(ge=1, le=131072)]
    allowed_proposal_types: tuple[Literal["profile", "course", "workspace"], ...]
    durable_mutation: Literal["proposal_or_direct_student_action"]
    terminal_execution: Literal["student_only"]
    conversation_memory: Literal["session_only"]
    workspace_write_globs: tuple[WorkspaceGlob, ...] = Field(max_length=128)

    @field_validator("allowed_share_kinds", "allowed_proposal_types", "workspace_write_globs")
    @classmethod
    def values_are_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("values must be unique")
        return values


class JupyterKernel(ClosedModel):
    type: Literal["python_uv_project"]


class JupyterRuntime(ClosedModel):
    type: Literal["jupyter"]
    kernel: JupyterKernel


class LearnerRecordRequirement(ClosedModel):
    id: Slug
    type: Literal["learner_record"]
    record_kind: Literal["text", "evidence", "attestation"]
    prompt: Prompt


class ArtifactExistsRequirement(ClosedModel):
    id: Slug
    type: Literal["artifact_exists"]
    prompt: Prompt
    path: LocalPath


Requirement: TypeAlias = Annotated[
    LearnerRecordRequirement | ArtifactExistsRequirement,
    Field(discriminator="type"),
]


class Completion(ClosedModel):
    requirements: tuple[Requirement, ...] = Field(max_length=64)

    @field_validator("requirements")
    @classmethod
    def requirement_ids_are_unique(
        cls, requirements: tuple[Requirement, ...]
    ) -> tuple[Requirement, ...]:
        if len({requirement.id for requirement in requirements}) != len(requirements):
            raise ValueError("requirement ids must be unique")
        return requirements


class TeacherAccess(ClosedModel):
    mode: Literal["available", "disabled", "observer_only"]
    requires: tuple[Slug, ...]

    @field_validator("requires")
    @classmethod
    def required_ids_are_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("teacher gate ids must be unique")
        return values


class TeacherGuidance(ClosedModel):
    style: TeacherStyle
    hint_level: Literal["none", "gentle", "graduated", "full"]
    text: Annotated[str, Field(min_length=1, max_length=2000)] | None = None


class TeacherSharing(ClosedModel):
    allow: tuple[Literal["selection", "cell", "output"], ...]

    @field_validator("allow")
    @classmethod
    def sharing_is_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("sharing values must be unique")
        return values


class TeacherProposals(ClosedModel):
    allow: tuple[Literal["profile", "course", "workspace"], ...]

    @field_validator("allow")
    @classmethod
    def proposals_are_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("proposal values must be unique")
        return values


class TeacherPolicy(ClosedModel):
    access: TeacherAccess
    guidance: TeacherGuidance
    sharing: TeacherSharing
    proposals: TeacherProposals

    @model_validator(mode="after")
    def disabled_authority_is_empty(self) -> TeacherPolicy:
        if self.access.mode in {"disabled", "observer_only"} and (
            self.access.requires or self.sharing.allow or self.proposals.allow
        ):
            raise ValueError("disabled and observer-only teachers have no authorities")
        return self


class WholeNotebookSelector(ClosedModel):
    type: Literal["whole_notebook"]


class CellIdsSelector(ClosedModel):
    type: Literal["cell_ids"]
    values: tuple[NotebookCellId, ...] = Field(min_length=1, max_length=256)

    @field_validator("values")
    @classmethod
    def cell_ids_are_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("notebook selector values must be unique")
        return values


class CellTagsSelector(ClosedModel):
    type: Literal["cell_tags"]
    values: tuple[Annotated[str, Field(min_length=1, max_length=160)], ...] = Field(min_length=1, max_length=256)
    match: Literal["any", "all"]

    @field_validator("values")
    @classmethod
    def cell_tags_are_unique(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("notebook selector values must be unique")
        return values


NotebookSelector: TypeAlias = Annotated[
    WholeNotebookSelector | CellIdsSelector | CellTagsSelector,
    Field(discriminator="type"),
]


class HtmlSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["html"]
    label: DisplayText
    path: LocalPath
    fragment: Annotated[str, Field(min_length=1, max_length=160, pattern=re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]*(?![\s\S])"))] | None = None


class MarkdownSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["markdown"]
    label: DisplayText
    path: LocalPath


class SourceSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["source"]
    label: DisplayText
    path: LocalPath


class NotebookSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["notebook"]
    label: DisplayText
    path: LocalPath
    selector: NotebookSelector


class VideoSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["video"]
    label: DisplayText
    src: LocalPath | HttpsUrl
    start_seconds: Annotated[JsonInteger, Field(ge=0, le=2147483647)] | None = None
    end_seconds: Annotated[JsonInteger, Field(ge=0, le=2147483647)] | None = None

    @model_validator(mode="after")
    def segment_is_complete_and_ordered(self) -> VideoSurface:
        if (self.start_seconds is None) != (self.end_seconds is None):
            raise ValueError("video segments require both bounds")
        if self.start_seconds is not None and self.start_seconds >= self.end_seconds:  # type: ignore[operator]
            raise ValueError("video start must precede end")
        return self


class TerminalSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["terminal"]
    label: DisplayText
    command: tuple[CommandToken, ...] = Field(
        min_length=1, max_length=128
    )
    cwd: DirectoryPath


class ExternalSurface(ClosedModel):
    id: Slug
    purpose: Literal["primary", "supporting", "reference"]
    type: Literal["external"]
    label: DisplayText
    url: HttpsUrl


Surface: TypeAlias = Annotated[
    HtmlSurface
    | MarkdownSurface
    | SourceSurface
    | NotebookSurface
    | VideoSurface
    | TerminalSurface
    | ExternalSurface,
    Field(discriminator="type"),
]


class Objective(ClosedModel):
    id: Slug
    text: Prompt


class Duration(ClosedModel):
    min_minutes: Annotated[JsonInteger, Field(ge=1, le=1440)]
    max_minutes: Annotated[JsonInteger, Field(ge=1, le=1440)]

    @model_validator(mode="after")
    def ordered(self) -> Duration:
        if self.min_minutes > self.max_minutes:
            raise ValueError("duration minimum must not exceed maximum")
        return self


class Hint(ClosedModel):
    id: Slug
    text: Prompt
    objective_ids: tuple[Slug, ...] = Field(default=(), max_length=32)


class SourceReference(ClosedModel):
    id: Slug
    label: DisplayText
    url: HttpsUrl
    reviewed_date: ReviewedDate | None = None


class CheckOption(ClosedModel):
    id: Slug
    text: Prompt
    feedback: Prompt


class SingleChoiceCheck(ClosedModel):
    id: Slug
    type: Literal["single_choice"]
    prompt: Prompt
    objective_ids: tuple[Slug, ...] = Field(default=(), max_length=32)
    options: tuple[CheckOption, ...] = Field(min_length=2, max_length=8)
    correct_option_id: Slug

    @model_validator(mode="after")
    def option_references(self) -> SingleChoiceCheck:
        ids = {option.id for option in self.options}
        if len(ids) != len(self.options) or self.correct_option_id not in ids:
            raise ValueError("check options must be unique and contain the correct option")
        return self


class Learning(ClosedModel):
    """Authored teaching metadata. Checks never confer completion or certification.

    Hints are progressive in array order. Correct IDs/feedback are author data,
    not suitable for unfiltered pre-attempt provider context.
    """
    objectives: tuple[Objective, ...] = Field(default=(), max_length=32)
    duration: Duration | None = None
    overview: Annotated[str, Field(min_length=1, max_length=8000, pattern=r".*\S.*")] | None = None
    hints: tuple[Hint, ...] = Field(default=(), max_length=20)
    sources: tuple[SourceReference, ...] = Field(default=(), max_length=32)
    checks: tuple[SingleChoiceCheck, ...] = Field(default=(), max_length=32)

    @model_validator(mode="after")
    def references(self) -> Learning:
        for items in (self.objectives, self.hints, self.sources, self.checks):
            if len({item.id for item in items}) != len(items):
                raise ValueError("learning identifiers must be unique within each collection")
        objectives = {item.id for item in self.objectives}
        for item in (*self.hints, *self.checks):
            if len(set(item.objective_ids)) != len(item.objective_ids) or not set(item.objective_ids).issubset(objectives):
                raise ValueError("objective references must be unique and defined in this phase")
        return self


class Phase(ClosedModel):
    id: Slug
    title: DisplayText
    progress: Literal["required", "optional", "excluded"]
    experience: Experience
    surfaces: tuple[Surface, ...] = Field(max_length=64)
    completion: Completion | None = None
    teacher: TeacherPolicy
    learning: Learning | None = None

    @model_validator(mode="after")
    def completion_and_gates_match_the_phase(self) -> Phase:
        if self.progress == "excluded" and self.completion is not None:
            raise ValueError("excluded phases must omit completion")
        if self.progress != "excluded" and self.completion is None:
            raise ValueError("required and optional phases require completion")
        learner_record_ids = {
            requirement.id
            for requirement in self.completion.requirements
            if isinstance(requirement, LearnerRecordRequirement)
        } if self.completion is not None else set()
        if not set(self.teacher.access.requires).issubset(learner_record_ids):
            raise ValueError("teacher gates must name same-phase learner records")
        if len({surface.id for surface in self.surfaces}) != len(self.surfaces):
            raise ValueError("surface ids must be unique within a phase")
        return self


class Module(ClosedModel):
    id: Slug
    title: DisplayText
    description: Description
    phases: tuple[Phase, ...] = Field(max_length=256)

    @field_validator("phases")
    @classmethod
    def phase_ids_are_unique(cls, phases: tuple[Phase, ...]) -> tuple[Phase, ...]:
        if len({phase.id for phase in phases}) != len(phases):
            raise ValueError("phase ids must be unique within a module")
        return phases


class CourseManifest(ClosedModel):
    schema_version: SchemaVersion
    id: Slug
    title: DisplayText
    description: Description
    entry_module_id: Slug | None
    runtime: JupyterRuntime | None = None
    policies: CoursePolicies
    modules: tuple[Module, ...] = Field(max_length=256)

    @model_validator(mode="after")
    def course_cross_references_and_authority_bounds(self) -> CourseManifest:
        module_ids = {module.id for module in self.modules}
        if len(module_ids) != len(self.modules):
            raise ValueError("module ids must be unique")
        if (not self.modules and self.entry_module_id is not None) or (self.modules and self.entry_module_id not in module_ids):
            raise ValueError("entry module must exist")
        notebook_exists = False
        for module in self.modules:
            for phase in module.phases:
                notebook_exists = notebook_exists or any(
                    isinstance(surface, NotebookSurface) for surface in phase.surfaces
                )
                if not set(phase.teacher.sharing.allow).issubset(
                    self.policies.allowed_share_kinds
                ):
                    raise ValueError("phase sharing exceeds course policy")
                if not set(phase.teacher.proposals.allow).issubset(
                    self.policies.allowed_proposal_types
                ):
                    raise ValueError("phase proposals exceed course policy")
        if notebook_exists and self.runtime is None:
            raise ValueError("notebook courses require a runtime declaration")
        return self
