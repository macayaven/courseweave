"""Explicit, pure v1 -> v2 conversion. No save, launch, or active-model imports."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from courseweave.contracts import CourseManifest
from courseweave.contracts.models import ClosedModel
from .legacy_models import CourseManifest as LegacyManifest


class SemanticMapping(ClosedModel):
    path: str
    kind: Literal['version', 'experience', 'progress', 'teacher', 'completion', 'surface', 'policies', 'runtime']
    explanation: str


class MigrationIssue(ClosedModel):
    path: str
    code: Literal['legacy_invalid', 'mixed_notebook_selector', 'unsupported_video_range', 'target_invalid']
    explanation: str


class MigrationResult(ClosedModel):
    manifest: CourseManifest | None
    mappings: tuple[SemanticMapping, ...]
    issues: tuple[MigrationIssue, ...]


_EXPERIENCE = {'orient': 'orientation', 'read': 'reading', 'watch': 'media', 'predict': 'prediction',
               'experiment': 'experiment', 'lab': 'practice', 'review': 'review', 'audit': 'review', 'ship': 'project'}
_STYLE = {'orienter': 'orienting', 'reading_companion': 'explanatory', 'socratic_guide': 'socratic',
          'debugging_coach': 'debugging', 'reviewer': 'reviewing', 'observer': 'reviewing', 'curriculum_designer': 'reviewing'}


def convert_legacy(data: object) -> MigrationResult:
    """Return a complete v2 candidate plus every semantic mapping, or issues.

    IDs/content paths are preserved. Incompatible selectors/ranges block a
    candidate rather than silently dropping meaning. This never reads content,
    runs commands, touches state, or modifies the input mapping.
    """
    mappings: list[SemanticMapping] = []
    issues: list[MigrationIssue] = []

    def mapping(path, kind, explanation):
        mappings.append(SemanticMapping(path=path, kind=kind, explanation=explanation))

    def issue(path, code, explanation):
        issues.append(MigrationIssue(path=path, code=code, explanation=explanation))

    try:
        legacy = LegacyManifest.model_validate(data)
    except ValidationError as exc:
        for error in exc.errors():
            path = '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in error['loc'])
            issue(path, 'legacy_invalid', 'Input does not satisfy the retained strict schema-v1 reader.')
        return MigrationResult(manifest=None, mappings=(), issues=tuple(issues))
    candidate = legacy.model_dump(mode='json')
    candidate['schema_version'] = 2
    mapping('/schema_version', 'version', 'Version 1 becomes canonical version 2. Course, module, phase and existing record IDs are preserved.')
    shares: set[str] = set()
    proposals: set[str] = set()
    notebook_exists = False
    for mi, module in enumerate(candidate['modules']):
        for pi, phase in enumerate(module['phases']):
            base = f'/modules/{mi}/phases/{pi}'
            kind = phase.pop('kind')
            phase['experience'] = {'type': 'builtin', 'id': _EXPERIENCE[kind]}
            mapping(f'{base}/experience', 'experience', f'Legacy {kind} presentation maps to builtin {_EXPERIENCE[kind]}; experience grants no authority.')
            phase['progress'] = 'required'
            mapping(f'{base}/progress', 'progress', 'Legacy phases become required; legacy had no optional/excluded distinction.')
            completion = phase['completion']
            completion_type = completion['type']
            if completion_type == 'manual':
                requirement = {'id': 'acknowledgement', 'type': 'learner_record', 'record_kind': 'attestation', 'prompt': f'Confirm completion of {phase["title"]}.'}
                explanation = 'Manual completion becomes a direct learner attestation named acknowledgement; it is not verified mastery.'
            elif completion_type == 'artifact_exists':
                requirement = {'id': completion['record_id'], 'type': 'artifact_exists', 'path': completion['path'], 'prompt': f'Create the artifact for {phase["title"]}.'}
                explanation = 'Artifact record_id becomes requirement id; path is preserved. Only ordinary-file presence counts, never content correctness.'
            else:
                record_kind = 'text' if completion_type == 'prediction_recorded' else 'evidence'
                requirement = {'id': completion['record_id'], 'type': 'learner_record', 'record_kind': record_kind, 'prompt': f'Record your {"prediction" if record_kind == "text" else "evidence"} for {phase["title"]}.'}
                explanation = f'{completion_type} becomes direct learner {record_kind}; record_id is preserved and an explicit prompt is authored from the phase title. Old state requires separate explicit import.'
            phase['completion'] = {'requirements': [requirement]}
            mapping(f'{base}/completion', 'completion', explanation)
            caps = phase.pop('capabilities')
            teacher_mode = phase.pop('teacher_mode')
            mode = 'disabled' if not caps['chat'] else ('observer_only' if teacher_mode == 'observer' else 'available')
            requires = [requirement['id']] if completion_type == 'prediction_recorded' and mode == 'available' else []
            allowed_shares = [k for k in ('selection', 'cell', 'output') if caps[f'share_{k}']] if mode == 'available' else []
            allowed_proposals = [k for k in ('profile', 'course', 'workspace') if caps[f'create_{k}_proposal']] if mode == 'available' else []
            phase['teacher'] = {'access': {'mode': mode, 'requires': requires},
                'guidance': {'style': {'type': 'builtin', 'id': _STYLE[teacher_mode]}, 'hint_level': caps['hint_level']},
                'sharing': {'allow': allowed_shares}, 'proposals': {'allow': allowed_proposals}}
            shares.update(allowed_shares); proposals.update(allowed_proposals)
            mapping(f'{base}/teacher', 'teacher',
                f'Legacy chat={caps["chat"]} and teacher_mode={teacher_mode} map to explicit {mode} access and {_STYLE[teacher_mode]} guidance; hint_level is preserved. '
                f'Sharing={allowed_shares}; proposals={allowed_proposals}. '
                + ('Prediction requirement gates all provider calls, including greetings. ' if requires else 'No record gate. ')
                + ('Disabled/observer authorities are cleared and cannot call a provider, including greetings.' if mode != 'available' else 'Capability grants remain bounded by course policy.'))
            for si, surface in enumerate(phase['surfaces']):
                pointer = f'{base}/surfaces/{si}'
                role = surface.pop('role')
                surface['purpose'] = {'primary': 'primary', 'reference': 'reference', 'exercise': 'supporting', 'evidence': 'supporting'}[role]
                generated_label = 'label' not in surface
                surface.setdefault('label', surface['id'])
                detail = f'Role {role} becomes purpose {surface["purpose"]}; IDs and content paths/URLs are preserved. ' + ('Label is derived from surface ID. ' if generated_label else 'Authored label is preserved. ')
                if surface['type'] == 'notebook':
                    notebook_exists = True
                    match = surface.pop('match', None)
                    if match is None:
                        surface['selector'] = {'type': 'whole_notebook'}
                        detail += 'Absent match becomes whole_notebook.'
                    elif match.get('cell_ids') is not None and match.get('cell_tags') is not None:
                        issue(pointer + '/match', 'mixed_notebook_selector', 'Choose an explicit cell_ids or cell_tags selector; mixed legacy matching is ambiguous.')
                    elif match.get('cell_ids') is not None:
                        surface['selector'] = {'type': 'cell_ids', 'values': match['cell_ids']}
                        detail += 'cell_ids become exact cell_ids selector.'
                    else:
                        surface['selector'] = {'type': 'cell_tags', 'values': match['cell_tags'], 'match': 'any'}
                        detail += 'cell_tags become case-sensitive any-tag selector, preserving legacy matching.'
                elif surface['type'] == 'video':
                    surface['src'] = surface.pop('path') or surface['url']
                    surface.pop('url')
                    start, end = surface.get('start_seconds'), surface.get('end_seconds')
                    if (start is None) != (end is None) or any(v is not None and (not v.is_integer() or v > 2147483647) for v in (start, end)):
                        issue(pointer, 'unsupported_video_range', 'Video bounds require paired whole seconds within 0..2147483647; choose explicit bounds without truncation.')
                    else:
                        for name in ('start_seconds', 'end_seconds'):
                            if surface[name] is not None:
                                surface[name] = int(surface[name])
                    detail += 'path/url becomes src; paired integral segment bounds preserve exact values.'
                elif surface['type'] == 'terminal':
                    surface['command'] = surface.pop('argv')
                    detail += 'argv becomes command; cwd is preserved and execution remains learner-only.'
                mapping(pointer, 'surface', detail)
    candidate['policies']['allowed_share_kinds'] = sorted(shares)
    candidate['policies']['allowed_proposal_types'] = sorted(proposals)
    mapping('/policies', 'policies', 'Existing global policy fields are preserved. Explicit allowed sharing/proposal bounds are the union of converted phase grants; no additional phase grant is introduced.')
    if notebook_exists:
        candidate['runtime'] = {'type': 'jupyter', 'kernel': {'type': 'python_uv_project'}}
        mapping('/runtime', 'runtime', 'Notebook content requires an explicit Jupyter/python_uv_project runtime. Course environment readiness must be checked separately before launch.')
    else:
        mapping('/runtime', 'runtime', 'No notebook surfaces; no runtime is inferred.')
    if issues:
        return MigrationResult(manifest=None, mappings=tuple(mappings), issues=tuple(issues))
    try:
        manifest = CourseManifest.model_validate(candidate)
    except ValidationError as exc:
        for error in exc.errors():
            pointer = '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in error['loc'])
            issue(pointer, 'target_invalid', 'Converted field exceeds the v2 contract; edit a copy explicitly before applying migration.')
        manifest = None
    return MigrationResult(manifest=manifest, mappings=tuple(mappings), issues=tuple(issues))


def preview_legacy(path: Path) -> MigrationResult:
    """Read only the specified legacy manifest; return a copy-producing preview."""
    try:
        data = json.loads(Path(path).read_bytes())
    except (OSError, UnicodeDecodeError, ValueError):
        return MigrationResult(manifest=None, mappings=(), issues=(MigrationIssue(path='', code='legacy_invalid', explanation='Legacy manifest could not be read as JSON.'),))
    return convert_legacy(data)
