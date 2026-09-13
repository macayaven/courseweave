"""Closed direct-action transport and separately versioned durable learner data."""
from typing import Annotated, Literal
from pydantic import Field, StrictBool, StrictInt, JsonValue
from courseweave.contracts.models import ClosedModel, Slug
from courseweave.contracts.records import Coordinate, RecordValue, Digest, LearnerRecord

Revision = Annotated[StrictInt, Field(ge=0)]

class PutRecord(ClosedModel):
    type: Literal['put_record']
    coordinate: Coordinate
    value: RecordValue
    curriculum_digest: Digest

class ClearRecord(ClosedModel):
    type: Literal['clear_record']
    coordinate: Coordinate
    curriculum_digest: Digest

class SetTimeBudget(ClosedModel):
    type: Literal['set_time_budget']
    minutes: Annotated[StrictInt, Field(ge=1, le=1440)] | None

class AdaptationPreferences(ClosedModel):
    enabled: StrictBool = False
    explanation: Literal['concise', 'balanced', 'detailed'] = 'balanced'
    practice: Literal['standard', 'extra'] = 'standard'

class SetPreferences(ClosedModel):
    type: Literal['set_preferences']
    preferences: AdaptationPreferences

class CheckAttempt(ClosedModel):
    type: Literal['check_attempt']
    module_id: Slug
    phase_id: Slug
    check_id: Slug
    option_id: Slug
    curriculum_digest: Digest

class ResetState(ClosedModel):
    type: Literal['reset_state', 'delete_state']

StateOperation = Annotated[PutRecord | ClearRecord | SetTimeBudget | SetPreferences | CheckAttempt | ResetState, Field(discriminator='type')]

class StateRequest(ClosedModel):
    origin: Literal['student_requested']
    expected_revision: Revision
    operation: StateOperation

class StoredAttempt(ClosedModel):
    module_id: Slug
    phase_id: Slug
    check_id: Slug
    option_id: Slug
    check_digest: Digest
    objective_digest: Digest
    objective_ids: tuple[Slug, ...]
    correct: StrictBool
    feedback: str

class LegacyImport(ClosedModel):
    source_digest: Digest
    source_key: str
    coordinate: Coordinate | None
    status: Literal['unbound', 'orphan']
    payload: dict[str, JsonValue]

class AuditSummary(ClosedModel):
    sequence: int
    proposal_id: str
    proposal_revision: int
    status: Literal['accepted', 'rejected', 'failed']
    proposal_type: str

class LearnerState(ClosedModel):
    schema_version: Literal[2] = 2
    course_id: str = ''
    root_fingerprint: str = ''
    revision: Revision = 0
    records: tuple[LearnerRecord, ...] = ()
    imports: tuple[LegacyImport, ...] = ()
    attempts: tuple[StoredAttempt, ...] = ()
    preferences: AdaptationPreferences = Field(default_factory=AdaptationPreferences)
    time_budget_minutes: Annotated[StrictInt, Field(ge=1, le=1440)] | None = None
    profile: dict[str, JsonValue] = Field(default_factory=dict)
    audit: tuple[AuditSummary, ...] = ()
