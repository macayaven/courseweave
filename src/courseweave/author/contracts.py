"""Closed, bounded author contracts. These never extend the student manifest.

Reply types are untrusted model input. Saved types are constructed by the
service, which resolves targets, revisions, validation and human decisions.
"""

from __future__ import annotations

from datetime import datetime, date
from pathlib import Path
from typing import Annotated, Literal, Protocol, TypeAlias

from pydantic import ConfigDict, Field, StrictInt, field_validator, model_validator

from ..contracts.models import ClosedModel, Slug
from ..contracts.primitives import LocalPath, NotebookCellId

Sha256: TypeAlias = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", max_length=64)]
Revision: TypeAlias = Annotated[StrictInt, Field(ge=0)]
AuthorRole: TypeAlias = Literal[
    "curator", "curriculum_designer", "source_researcher", "fact_checker",
    "proofreader", "compatibility_reviewer",
]
SourceStatus: TypeAlias = Literal["candidate", "approved", "rejected", "stale"]
Judgment: TypeAlias = Literal["supported", "contradicted", "insufficient", "not_checked"]
HumanDisposition: TypeAlias = Literal["accepted", "revised", "dismissed", "unreviewed"]
Text: TypeAlias = Annotated[str, Field(max_length=64000)]


class AuthorProject(ClosedModel):
    format: Literal[1] = 1
    project_id: Slug
    course_root: Path
    state_root: Path
    revision: Revision

    @field_validator("course_root", "state_root")
    @classmethod
    def resolved_path(cls, value: Path) -> Path:
        if not value.is_absolute() or value != value.resolve():
            raise ValueError("project paths must be absolute and resolved")
        return value

    @model_validator(mode="after")
    def separate_roots(self):
        if self.course_root.is_relative_to(self.state_root) or self.state_root.is_relative_to(self.course_root):
            raise ValueError("course and author state must be separate directories")
        if self.course_root.parent != self.state_root.parent:
            raise ValueError("course and author state must be adjacent within one project")
        return self


class AuthorSelection(ClosedModel):
    project_id: Slug
    course_id: Slug
    module_id: Slug | None = None
    phase_id: Slug | None = None
    file_path: LocalPath | None = None
    cell_ids: tuple[NotebookCellId, ...] = Field(default=(), max_length=128)
    manifest_unit: Literal["course", "module", "phase", "learning"] = "course"

    @model_validator(mode="after")
    def complete_selection(self):
        if self.phase_id and not self.module_id:
            raise ValueError("phase selection requires a module")
        if self.cell_ids and not self.file_path:
            raise ValueError("cell selection requires a file")
        if len(self.cell_ids) != len(set(self.cell_ids)):
            raise ValueError("selected cells must be unique")
        return self


class SourceRevision(ClosedModel):
    source_id: Slug
    revision: Revision
    raw_sha256: Sha256
    text_sha256: Sha256 | None = None
    extractor_version: Annotated[str, Field(min_length=1, max_length=80)] | None = None


class RequestBudget(ClosedModel):
    max_input_chars: Annotated[StrictInt, Field(ge=1, le=131072)] = 24000
    max_output_chars: Annotated[StrictInt, Field(ge=1, le=64000)] = 16000


class AuthorContext(ClosedModel):
    selection: AuthorSelection
    role: AuthorRole
    project_revision: Revision
    manifest_sha256: Sha256
    target_path: LocalPath
    target_sha256: Sha256
    target_exists: bool = True
    sources: tuple[SourceRevision, ...] = Field(default=(), max_length=32)
    permission_sha256: Sha256
    prompt_version: Annotated[str, Field(min_length=1, max_length=80)]
    provider_fingerprint: Sha256
    digest: Sha256
    content: Text
    omissions: tuple[Annotated[str, Field(max_length=1000)], ...] = Field(default=(), max_length=128)
    budget: RequestBudget = Field(default_factory=RequestBudget)

    @model_validator(mode="after")
    def bounded_content(self):
        if len(self.content) > self.budget.max_input_chars:
            raise ValueError("context exceeds request budget")
        if len({source.source_id for source in self.sources}) != len(self.sources):
            raise ValueError("selected sources must be unique")
        return self


class ManifestFragmentDraft(ClosedModel):
    kind: Literal["manifest_fragment_replace"]
    value: dict


class MarkdownDraft(ClosedModel):
    kind: Literal["markdown_replace"]
    text: Text


class NotebookCellsDraft(ClosedModel):
    kind: Literal["notebook_cells"]
    replace_sources: dict[NotebookCellId, Text] = Field(min_length=1, max_length=128)


ChangeDraft: TypeAlias = Annotated[
    ManifestFragmentDraft | MarkdownDraft | NotebookCellsDraft, Field(discriminator="kind")
]


class ValidationIssue(ClosedModel):
    code: Annotated[str, Field(min_length=1, max_length=120)]
    location: Annotated[str, Field(max_length=1000)]
    message: Annotated[str, Field(min_length=1, max_length=2000)]
    severity: Literal["error", "warning", "not_performed"]


class PendingChange(ClosedModel):
    model_config = ConfigDict(ser_json_bytes="base64", val_json_bytes="base64")
    change_id: Slug
    project_id: Slug
    revision: Revision
    target_path: LocalPath
    before_sha256: Sha256
    before_exists: bool = True
    after_sha256: Sha256
    after_bytes: Annotated[bytes, Field(max_length=8 * 1024 * 1024)]
    context_digest: Sha256
    status: Literal["pending", "rejected", "stale", "prepared", "applied", "conflict", "failed"]
    issues: tuple[ValidationIssue, ...] = Field(default=(), max_length=256)
    sources: tuple[SourceRevision, ...] = Field(default=(), max_length=32)


class ApplyReceipt(ClosedModel):
    operation_id: Slug
    change_id: Slug
    project_id: Slug
    revision: Revision
    target_path: LocalPath
    before_sha256: Sha256
    after_sha256: Sha256
    applied_at: datetime


class OriginRule(ClosedModel):
    origin: Annotated[str, Field(min_length=1, max_length=2048)]
    path_prefix: Annotated[str, Field(min_length=1, max_length=2048)] = "/"


class ResearchPolicy(ClosedModel):
    mode: Literal["allow_only", "public_web"]
    allow: tuple[OriginRule, ...] = Field(default=(), max_length=32)
    deny: tuple[OriginRule, ...] = Field(default=(), max_length=32)

    def permits(self, url: str) -> bool:
        from .sources import policy_permits
        return policy_permits(self, url)

    @model_validator(mode="after")
    def explicit_scope(self):
        if self.mode == "allow_only" and not self.allow:
            raise ValueError("allow_only research requires an allowed origin")
        return self


class ResearchRequest(ClosedModel):
    network_enabled: Literal[True]
    policy: ResearchPolicy
    queries: tuple[Annotated[str, Field(min_length=1, max_length=1000)], ...] = Field(default=(), max_length=2)
    urls: tuple[Annotated[str, Field(min_length=1, max_length=4096)], ...] = Field(default=(), max_length=5)

    @model_validator(mode="after")
    def explicit_request(self):
        if not self.queries and not self.urls:
            raise ValueError("research requires an explicit query or URL")
        return self


class SourceRecord(ClosedModel):
    source_id: Slug
    revision: Revision
    title: Annotated[str, Field(min_length=1, max_length=500)]
    origin: Annotated[str, Field(min_length=1, max_length=4096)]
    imported_at: datetime
    retrieved_at: datetime | None = None
    final_url: Annotated[str, Field(max_length=4096)] | None = None
    media_type: Annotated[str, Field(max_length=200)] | None = None
    publication_date: date | None = None
    raw_sha256: Sha256
    text_sha256: Sha256 | None = None
    extractor_version: Annotated[str, Field(max_length=80)] | None = None
    snapshot_path: LocalPath
    text_path: LocalPath | None = None
    status: SourceStatus = "candidate"
    intended_use: Literal["author_reference", "student_material"] = "author_reference"
    redistribution: Literal["undecided", "include", "exclude"] = "undecided"
    policy_decision: Literal["allowed", "denied", "local", "not_checked"]
    extraction: Literal["text", "unsupported", "unavailable"]
    extraction_note: Annotated[str, Field(max_length=2000)] = ""
    review_note: Annotated[str, Field(max_length=4000)] = ""


class SearchResult(ClosedModel):
    url: Annotated[str, Field(max_length=4096)]
    title: Annotated[str, Field(max_length=500)]
    snippet: Annotated[str, Field(max_length=4000)]
    query: Annotated[str, Field(max_length=1000)]
    retrieved_at: datetime
    publication_date: date | None = None
    policy_decision: Literal["allowed", "denied", "not_checked"] = "not_checked"


class FetchResult(ClosedModel):
    url: Annotated[str, Field(max_length=4096)]
    final_url: Annotated[str, Field(max_length=4096)] | None = None
    status: Literal["fetched", "denied", "unavailable", "unsupported", "cancelled", "limit_exceeded"]
    message: Annotated[str, Field(max_length=2000)]
    retrieved_at: datetime
    media_type: Annotated[str, Field(max_length=200)] | None = None
    content: Annotated[bytes, Field(max_length=2 * 1024 * 1024)] = b""
    redirects: tuple[Annotated[str, Field(max_length=4096)], ...] = Field(default=(), max_length=3)
    source: SourceRevision | None = None


class ResearchReport(ClosedModel):
    report_id: Slug
    started_at: datetime
    finished_at: datetime
    request: ResearchRequest
    status: Literal["complete", "partial", "unavailable", "cancelled", "limit_exceeded"]
    results: tuple[SearchResult, ...] = Field(default=(), max_length=10)
    fetches: tuple[FetchResult, ...] = Field(default=(), max_length=5)
    source_ids: tuple[Slug, ...] = Field(default=(), max_length=5)
    notices: tuple[Annotated[str, Field(max_length=2000)], ...] = Field(default=(), max_length=32)


class EvidenceReference(SourceRevision):
    quote: Annotated[str, Field(min_length=1, max_length=4000)]
    start: Annotated[StrictInt, Field(ge=0)]
    end: Annotated[StrictInt, Field(ge=1)]

    @model_validator(mode="after")
    def ordered_span(self):
        if self.end <= self.start:
            raise ValueError("quote end must follow its start")
        return self


class FindingDraft(ClosedModel):
    claim_id: Slug
    judgment: Judgment
    explanation: Annotated[str, Field(min_length=1, max_length=4000)]
    evidence: tuple[EvidenceReference, ...] = Field(default=(), max_length=8)


class AuthorReply(ClosedModel):
    version: Literal["author-reply-v1"]
    role: AuthorRole
    message: Annotated[str, Field(min_length=1, max_length=16000)]
    findings: tuple[FindingDraft, ...] = Field(default=(), max_length=64)
    change: ChangeDraft | None = None


class SavedFinding(FindingDraft):
    human_disposition: HumanDisposition = "unreviewed"
    disposition_reason: Annotated[str, Field(max_length=4000)] = ""
    provenance: Literal["located", "mismatch", "missing", "not_checked"] = "not_checked"


class ReviewReport(ClosedModel):
    report_id: Slug
    project_id: Slug
    revision: Revision
    context_digest: Sha256
    target_path: LocalPath
    target_sha256: Sha256
    role: AuthorRole
    sources: tuple[SourceRevision, ...] = Field(default=(), max_length=32)
    findings: tuple[SavedFinding, ...] = Field(max_length=64)
    status: Literal["current", "stale"]
    saved_at: datetime


class StudentProfile(ClosedModel):
    application_version: Literal["0.2.0", "0.3.0"]
    schema_version: Literal[2] = 2
    schema_sha256: Sha256
    baseline_commit: Annotated[str, Field(pattern=r"^[a-f0-9]{40}$", max_length=40)]
    platform: Literal["macos-apple-silicon"] = "macos-apple-silicon"
    python_versions: tuple[Literal["3.11", "3.12"], ...] = ("3.11", "3.12")


class CompatibilityReport(ClosedModel):
    profile: StudentProfile
    manifest_sha256: Sha256
    inventory_sha256: Sha256 | None = None
    structural: tuple[ValidationIssue, ...] = Field(default=(), max_length=10000)
    assets: tuple[ValidationIssue, ...] = Field(default=(), max_length=10000)
    links: tuple[ValidationIssue, ...] = Field(default=(), max_length=10000)
    profile_issues: tuple[ValidationIssue, ...] = Field(default=(), max_length=10000)
    not_performed: tuple[ValidationIssue, ...] = Field(default=(), max_length=10000)

    @property
    def passed(self) -> bool:
        return not any(issue.severity == "error" for group in
                       (self.structural, self.assets, self.links, self.profile_issues, self.not_performed)
                       for issue in group)


class InventoryFile(ClosedModel):
    path: LocalPath
    sha256: Sha256
    size: Annotated[StrictInt, Field(ge=0, le=1024 * 1024 * 1024)]


class ExportReceipt(ClosedModel):
    export_id: Slug
    project_id: Slug
    project_revision: Revision
    course_id: Slug
    course_version: Annotated[str, Field(min_length=1, max_length=80)]
    destination: Path
    package_sha256: Sha256
    inventory: tuple[InventoryFile, ...] = Field(max_length=10000)
    compatibility: CompatibilityReport
    kind: Literal["draft", "student_handoff"]
    created_at: datetime
    student_compatibility_target: Literal["0.2.0"] = "0.2.0"


class StudentRuntime(ClosedModel):
    version: Literal["0.2.0", "0.3.0"]
    platform_python: Path
    kernel_python: Path | None = None
    artifact_sha256: Sha256


class PreviewHandle(ClosedModel):
    preview_id: Slug
    export_id: Slug
    package_sha256: Sha256
    runtime: StudentRuntime
    home: Path
    pid: Annotated[StrictInt, Field(gt=0)]
    process_identity: Annotated[str, Field(min_length=1, max_length=1000)]
    port: Annotated[StrictInt, Field(ge=1024, le=65535)]
    started_at: datetime


class SearchClient(Protocol):
    def search(self, query: str, limit: int) -> tuple[SearchResult, ...]: ...


class FetchClient(Protocol):
    def fetch(self, url: str, policy: ResearchPolicy) -> FetchResult: ...
