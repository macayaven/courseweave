# Task 3B report: deterministic professor policy and inert proposal tool

## Implementation summary

- Added `courseweave.professor` as a service-only trust boundary. It derives a
  `ProfessorPolicy` from server-loaded `CourseManifest`, `ResolvedContext`,
  `LearnerState`, and an explicit learner/author role; it does not accept client
  capabilities, phase state, tools, system prompts, proposal state, or shared
  content.
- Added deterministic capability, predict-first, and observer-audit gates that
  return fixed responses before model construction or a model request.
- Added all nine phase postures, metadata-only/explicit-Share instructions,
  learner-ownership lab guidance, and an empty-course general policy.
- Added lazy Pydantic AI agent construction from the reviewed provider model
  seam. Missing provider configuration returns a structured `not_configured`
  outcome; unexpected provider exceptions return a fixed safe error.
- Added only inert proposal creation. The role/phase policy exposes exactly the
  allowed profile, manifest, and workspace proposal types, and creation is
  delegated to `CourseStore.create_proposal` with `teacher_suggested` origin.
  No tool edits, accepts, rejects, applies, writes files, runs commands, or
  changes learner state.

## Files changed

- `src/courseweave/professor.py`
- `tests/test_professor.py`
- `.superpowers/sdd/2026-09-01-courseweave-platform/task-3b-report.md`

## RED evidence

The test module was added before any production professor code. Its initial
focused command failed because the target implementation was absent:

```text
$ uv run pytest tests/test_professor.py -q
FFFFFFFFFFFFFFFFFFFF                                                     [100%]
ModuleNotFoundError: No module named 'courseweave.professor'
20 failed in 1.68s
```

This was the expected missing-feature failure: the tests imported the new
policy/service boundary but no module existed yet.

## GREEN evidence

After the smallest policy, deterministic-gate, lazy-agent, and
store-backed-suggestion implementation:

```text
$ uv run pytest tests/test_professor.py -q
....................                                                     [100%]
20 passed in 1.58s
```

The focused tests are table-driven across all nine phase kinds. They also use a
local counting Pydantic AI `TestModel` to show disabled chat, missing required
prediction, and observer audit requests never reach the model, while the exact
recorded prediction opens the gate. They verify lab ownership wording, Author
curriculum policy, empty/general behavior, exact learner proposal exposure, and
pending `teacher_suggested` proposal creation through the real `CourseStore`.

## Full-suite evidence

```text
$ git diff --check && uv run pytest -q
........................................................................ [ 42%]
........................................................................ [ 85%]
........................                                                 [100%]
168 passed in 14.14s

$ uv run python -m py_compile src/courseweave/professor.py
```

The full suite includes Task 3A's loopback provider canaries; Task 3B itself
uses only Pydantic AI's local `TestModel` and makes no network calls.

## Self-review

- Gates run before `model_factory`, so fixed denials cannot be overridden by a
  provider response or create a provider request.
- Resolution checks module and phase IDs against the supplied manifest and
  falls back to an explicit general policy for an empty or unmatched context.
- Learner policy preserves the resolved phase's teacher mode and capabilities;
  Author policy deliberately replaces that teaching role with
  `curriculum_designer` and permits only `manifest_replace` suggestions.
- The only mutation path in this module is `CourseStore.create_proposal`; its
  result is pending, and the test confirms learner profile state remains empty.
- No credentials are logged, returned, formatted into instructions, or stored.
- No HTTP routes were changed.

## Concerns

No blocking concerns. Deterministic request classifiers intentionally use a
small fixed vocabulary for result-seeking and a fixed set of social-only
messages; Task 3C can pass the same raw user prompt to this service without
granting the model authority to reinterpret a denied request.
