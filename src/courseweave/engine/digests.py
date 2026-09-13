"""Semantic revisions, separate from exact manifest-byte ETags."""
import hashlib
import json

from courseweave.contracts import CourseManifest
from courseweave.contracts.records import Coordinate


def digest(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def find_phase(manifest: CourseManifest, module_id: str, phase_id: str):
    for module in manifest.modules:
        if module.id == module_id:
            for phase in module.phases:
                if phase.id == phase_id:
                    return phase
    raise ValueError('unknown phase coordinate')


def find_requirement(manifest: CourseManifest, coordinate: Coordinate):
    phase = find_phase(manifest, coordinate.module_id, coordinate.phase_id)
    if phase.completion is not None:
        for requirement in phase.completion.requirements:
            if requirement.id == coordinate.requirement_id:
                return requirement
    raise ValueError('unknown requirement coordinate')


def requirement_digest(manifest: CourseManifest, coordinate: Coordinate) -> str:
    requirement = find_requirement(manifest, coordinate)
    return digest({'version': 1, 'coordinate': coordinate.model_dump(mode='json'), 'requirement': requirement.model_dump(mode='json')})


def curriculum_digest(manifest: CourseManifest) -> str:
    """All canonical fields, including teaching/policy edits, but no raw bytes.

    Requirement digests deliberately have narrower scope, preserving direct
    records across cosmetic, presentation, and teaching-only curriculum edits.
    """
    return digest(manifest.model_dump(mode='json'))
