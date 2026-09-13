"""Bounded, versioned teaching data; never grants authority or persists chat."""
from dataclasses import dataclass
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
from courseweave.engine.paths import read_jailed
from courseweave.engine.progress import inspect_records

CONTEXT_VERSION = 'teaching-context-v1'
PROMPT_VERSION = 'course-assistant-v1'
EXTRACTOR_VERSION = 'lesson-visible-v1'


class LessonError(ValueError):
    pass


class _VisibleLesson(HTMLParser):
    """Suppress entire nested disclosures and executable/hidden content before clipping."""
    blocked = {'details', 'script', 'style', 'template', 'nav', 'noscript', 'head'}
    void = {'br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'embed', 'param', 'track', 'col'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.suppression = []
        self.parts = []
        self.omitted = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        hidden = tag in self.blocked or 'hidden' in values or values.get('aria-hidden') == 'true' or any(x in values.get('style', '').replace(' ', '').lower() for x in ('display:none', 'visibility:hidden'))
        if self.suppression or hidden:
            self.omitted = True
            if tag not in self.void:
                self.suppression.append(tag)
        elif tag in {'p', 'div', 'br', 'pre', 'li', 'h1', 'h2', 'h3', 'h4'}:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.suppression:
            if self.suppression[-1] == tag:
                self.suppression.pop()
            # Malformed nesting fails closed until the exact suppressed chain ends.
        else:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.suppression:
            self.parts.append(data)


@dataclass(frozen=True)
class LessonScope:
    id: str
    course_id: str
    curriculum_digest: str
    module_id: str
    phase_id: str
    surface_id: str
    path: str
    label: str
    digest: str
    excerpt: str
    truncated: bool
    omitted_sections: bool

    def public(self):
        return {k: getattr(self, k) for k in ('id', 'module_id', 'phase_id', 'surface_id', 'label', 'digest', 'truncated', 'omitted_sections')} | {'extractor_version': EXTRACTOR_VERSION, 'reset_action': 'reset_lesson'}


def lesson_scope(root, manifest, resolved, curriculum_digest, scope_id):
    phase = next((p for m in manifest.modules if m.id == resolved.module_id for p in m.phases if p.id == resolved.phase_id), None)
    surface = next((s for s in phase.surfaces if s.id == resolved.surface_id), None) if phase else None
    if surface is None or surface.type not in {'html', 'markdown'}:
        raise LessonError('unsupported_surface')
    data = read_jailed(Path(root), str(surface.path), max_bytes=262144)
    parser = _VisibleLesson()
    parser.feed(data.decode('utf-8'))
    parser.close()
    text = ''.join(parser.parts).strip()
    return LessonScope(scope_id, manifest.id, curriculum_digest, resolved.module_id, resolved.phase_id, surface.id,
                       str(surface.path), surface.label, sha256(data).hexdigest(), text[:16000], len(text) > 16000, parser.omitted)


def lesson_unchanged(scope, root, manifest, curriculum_digest):
    if scope.course_id != manifest.id or scope.curriculum_digest != curriculum_digest:
        return False
    try:
        return sha256(read_jailed(Path(root), scope.path, max_bytes=262144)).hexdigest() == scope.digest
    except ValueError:
        return False


def teaching_context(manifest, resolved, state, view, actions=(), *, hint_index=0, objective_id=None, declined=False):
    """Project valid selected evidence; opt-out permits only observed session actions."""
    phase = next((p for m in manifest.modules if m.id == resolved.module_id for p in m.phases if p.id == resolved.phase_id), None)
    context = {'version': CONTEXT_VERSION, 'course': {'id': manifest.id, 'title': manifest.title},
               'activity': {'module_id': resolved.module_id, 'phase_id': resolved.phase_id},
               'observations': [], 'check_facts': [], 'adaptation_enabled': state.preferences.enabled, 'revisit_declined': declined}
    learning = phase.learning if phase else None
    if learning:
        authored = learning.model_dump(mode='json', exclude={'hints'})
        for check in authored['checks']:
            check.pop('correct_option_id', None)
            for option in check['options']:
                option.pop('feedback', None)
        hints = [h for h in learning.hints if objective_id is None or objective_id in h.objective_ids] if phase.teacher.guidance.hint_level != 'none' else []
        authored['hint'] = hints[min(hint_index, len(hints))-1].model_dump(mode='json') if hints and hint_index else None
        context['authored'] = authored
    allowed = set(actions)
    _, valid = inspect_records(manifest, state.records)
    for coordinate, records in valid.items():
        if (coordinate.module_id, coordinate.phase_id) != (resolved.module_id, resolved.phase_id):
            continue
        record = records[-1]
        marker = 'record:' + sha256(record.model_dump_json().encode()).hexdigest()
        if state.preferences.enabled or marker in allowed:
            context['observations'].append(record.model_dump(mode='json'))
    statuses = {row['index']: row['status'] for row in view.get('attempt_statuses', [])}
    for i, attempt in enumerate(state.attempts):
        marker = 'attempt:' + sha256(attempt.model_dump_json().encode()).hexdigest()
        if statuses.get(i) != 'valid' or (attempt.module_id, attempt.phase_id) != (resolved.module_id, resolved.phase_id):
            continue
        if state.preferences.enabled or marker in allowed:
            context['check_facts'].append(attempt.model_dump(mode='json'))
    context['observations'] = context['observations'][-4:]
    context['check_facts'] = context['check_facts'][-4:]
    if state.preferences.enabled:
        context['preferences'] = state.preferences.model_dump(mode='json')
        context['time_budget_minutes'] = state.time_budget_minutes
    wrong = next((fact for fact in reversed(context['check_facts']) if not fact['correct']), None)
    if wrong and not declined:
        context['optional_revisit'] = {'reason': 'The selected answer did not match this authored check; this is a check observation, not a mastery assessment.',
            'check_id': wrong['check_id'], 'objective_ids': wrong['objective_ids'],
            'targets': [{'module_id': resolved.module_id, 'phase_id': resolved.phase_id}],
            'decline_action': 'decline_revisit', 'voluntary': True}
    # Values are bounded as a serialized data block; never replay raw durable state/profile.
    if len(json.dumps(context)) > 32000:
        context['observations'] = []
        context['check_facts'] = []
    return context


@dataclass(frozen=True)
class TurnContext:
    """Canonical immutable accepted-turn snapshot, with fresh copies for display."""
    serialized: str

    @classmethod
    def capture(cls, **values):
        return cls(json.dumps({'version': 'turn-context-v1', **values}, sort_keys=True))

    def public(self):
        return json.loads(self.serialized)

    def __getitem__(self, key):
        return self.public()[key]


@dataclass(frozen=True)
class ReplayDependency:
    """A revocation baseline; adding evidence does not revoke earlier context."""
    authority: str
    evidence: frozenset[str]

    def revokes(self, previous: 'ReplayDependency') -> bool:
        # Replacing a record removes its old value hash. Removing an attempt,
        # changing curriculum/consent, or resetting evidence similarly revokes
        # the old echo chain. Append-only evidence leaves the prior set intact.
        return self.authority != previous.authority or not previous.evidence <= self.evidence

    @property
    def fingerprint(self) -> str:
        return sha256(json.dumps({'authority': self.authority, 'evidence': sorted(self.evidence)}, sort_keys=True).encode()).hexdigest()


def replay_dependency(manifest, state, data):
    # Compare the current durable evidence set independently of navigation or
    # the selected context window. This baseline grants no evidence permission:
    # teaching_context still filters each turn by validity and session consent.
    # Removal may conservatively revoke unrelated prior replay; additions never
    # erase it, including additions that opt-out excludes from model context.
    authority = sha256(json.dumps({'manifest': manifest.model_dump(mode='json'),
        'consent': state.preferences.enabled,
        'preferences': state.preferences.model_dump(mode='json') if state.preferences.enabled else None,
        'budget': state.time_budget_minutes if state.preferences.enabled else None}, sort_keys=True).encode()).hexdigest()
    evidence = frozenset(
        prefix + sha256(item.model_dump_json().encode()).hexdigest()
        for prefix, items in (('record:', state.records), ('attempt:', state.attempts))
        for item in items
    )
    return ReplayDependency(authority, evidence)
