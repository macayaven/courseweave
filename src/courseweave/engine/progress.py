"""Deterministic progress. Presence/submission is never correctness or mastery."""
from pathlib import Path
from typing import Literal, Iterable

from pydantic import TypeAdapter, ValidationError

from courseweave.contracts import CourseManifest
from courseweave.contracts.models import ClosedModel, LearnerRecordRequirement, ArtifactExistsRequirement
from courseweave.contracts.records import Coordinate, RecordValue, LearnerRecord, AttestationValue, value_kind
from .digests import find_requirement, requirement_digest
from .paths import ordinary_file_present


class RecordStatus(ClosedModel):
    coordinate: Coordinate | None
    status: Literal['valid', 'stale', 'orphan', 'invalid']


class RequirementStatus(ClosedModel):
    requirement_id: str
    type: Literal['learner_record', 'artifact_exists']
    satisfied: bool


class PhaseProgress(ClosedModel):
    module_id: str
    phase_id: str
    progress: Literal['required', 'optional', 'excluded']
    complete: bool | None
    requirements: tuple[RequirementStatus, ...]


class Progress(ClosedModel):
    required_total: int
    required_complete: int
    phases: tuple[PhaseProgress, ...]
    records: tuple[RecordStatus, ...]


_VALUE_ADAPTER = TypeAdapter(RecordValue)


def bind_record(manifest: CourseManifest, coordinate: Coordinate, value: RecordValue | dict) -> LearnerRecord:
    """Validate a direct submission and assign all authority fields server-side."""
    coordinate = Coordinate.model_validate(coordinate)
    value = _VALUE_ADAPTER.validate_python(value)
    requirement = find_requirement(manifest, coordinate)
    if not isinstance(requirement, LearnerRecordRequirement) or value_kind(value) != requirement.record_kind:
        raise ValueError('record value does not match the declared learner requirement')
    return LearnerRecord(coordinate=coordinate, value=value, kind=requirement.record_kind,
                         origin='direct_learner', requirement_digest=requirement_digest(manifest, coordinate))


def inspect_records(manifest: CourseManifest, records: Iterable[LearnerRecord | dict]) -> tuple[list[RecordStatus], dict[Coordinate, list[LearnerRecord]]]:
    """Invalid, stale, and orphaned records are inspectable and never count."""
    statuses = []
    valid: dict[Coordinate, list[LearnerRecord]] = {}
    for raw in records:
        try:
            record = LearnerRecord.model_validate(raw)
        except (ValidationError, ValueError, TypeError):
            candidate = getattr(raw, 'coordinate', None)
            try:
                coordinate = Coordinate.model_validate(candidate)
            except ValidationError:
                coordinate = None
            statuses.append(RecordStatus(coordinate=coordinate, status='invalid'))
            continue
        try:
            requirement = find_requirement(manifest, record.coordinate)
        except ValueError:
            status = 'orphan'
        else:
            if not isinstance(requirement, LearnerRecordRequirement):
                status = 'orphan'
            elif record.requirement_digest != requirement_digest(manifest, record.coordinate):
                status = 'stale'
            elif record.kind != requirement.record_kind:
                status = 'invalid'
            else:
                status = 'valid'
                valid.setdefault(record.coordinate, []).append(record)
        statuses.append(RecordStatus(coordinate=record.coordinate, status=status))
    return statuses, valid


def record_satisfies(record: LearnerRecord) -> bool:
    return not isinstance(record.value, AttestationValue) or record.value.attested


def evaluate_progress(manifest: CourseManifest, records: Iterable[LearnerRecord | dict], course_root: Path) -> Progress:
    statuses, valid = inspect_records(manifest, records)
    phases = []
    for module in manifest.modules:
        for phase in module.phases:
            requirements = []
            for requirement in phase.completion.requirements if phase.completion is not None else ():
                coordinate = Coordinate(module_id=module.id, phase_id=phase.id, requirement_id=requirement.id)
                if isinstance(requirement, ArtifactExistsRequirement):
                    satisfied = ordinary_file_present(course_root, requirement.path)
                else:
                    # Storage owns one current record per coordinate. Fail closed if
                    # contradictory duplicates are passed instead of guessing order.
                    matching = valid.get(coordinate, [])
                    satisfied = bool(matching) and all(record_satisfies(r) for r in matching)
                requirements.append(RequirementStatus(requirement_id=requirement.id, type=requirement.type, satisfied=satisfied))
            complete = None if phase.progress == 'excluded' else all(r.satisfied for r in requirements)
            phases.append(PhaseProgress(module_id=module.id, phase_id=phase.id, progress=phase.progress, complete=complete, requirements=tuple(requirements)))
    required = [phase for phase in phases if phase.progress == 'required']
    return Progress(required_total=len(required), required_complete=sum(phase.complete is True for phase in required), phases=tuple(phases), records=tuple(statuses))
