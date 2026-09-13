"""Effective teacher authority is derived solely from explicit policy and records."""
from typing import Iterable, Literal

from courseweave.contracts import CourseManifest
from courseweave.contracts.models import ClosedModel, TeacherGuidance
from courseweave.contracts.records import Coordinate, LearnerRecord
from .digests import find_phase
from .progress import inspect_records, record_satisfies


class EffectiveTeacherPolicy(ClosedModel):
    mode: Literal['available', 'disabled', 'observer_only']
    provider_callable: bool
    unmet_requirement_ids: tuple[str, ...]
    guidance: TeacherGuidance
    allowed_share_kinds: tuple[Literal['selection', 'cell', 'output'], ...]
    allowed_proposal_types: tuple[Literal['profile', 'course', 'workspace'], ...]
    max_shared_chars: int


def effective_teacher_policy(manifest: CourseManifest, module_id: str, phase_id: str,
                             records: Iterable[LearnerRecord | dict]) -> EffectiveTeacherPolicy:
    phase = find_phase(manifest, module_id, phase_id)
    _, valid = inspect_records(manifest, records)
    unmet = []
    for requirement_id in phase.teacher.access.requires:
        matching = valid.get(Coordinate(module_id=module_id, phase_id=phase_id, requirement_id=requirement_id), [])
        if not matching or not all(record_satisfies(record) for record in matching):
            unmet.append(requirement_id)
    callable_ = phase.teacher.access.mode == 'available' and not unmet
    return EffectiveTeacherPolicy(mode=phase.teacher.access.mode, provider_callable=callable_,
        unmet_requirement_ids=tuple(unmet), guidance=phase.teacher.guidance,
        allowed_share_kinds=tuple(k for k in phase.teacher.sharing.allow if k in manifest.policies.allowed_share_kinds) if callable_ else (),
        allowed_proposal_types=tuple(k for k in phase.teacher.proposals.allow if k in manifest.policies.allowed_proposal_types) if callable_ else (),
        max_shared_chars=manifest.policies.max_shared_chars)
