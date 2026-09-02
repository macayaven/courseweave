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

## Fix round 1/5: predict-first allowlist and verified model-tool wiring

### Findings addressed

- Predict-first now blocks every request while its required record is absent,
  except greetings/thanks, narrow `how`/`where` record-or-submit questions, and
  clear learner-owned statements beginning `I predict`, `My prediction is`, or
  `My hypothesis is`. Validation/reveal vocabulary (`correct`, `pass`,
  `expected`, `answer`, `result`, `output`, `solution`, `observe`, `outcome`,
  and `reveal`) overrides those allow paths and remains blocked.
- Pydantic AI proposal callbacks are now registered as plain tools. Focused
  tests exercise the actual model-visible schemas: learner gets exactly profile,
  manifest, and workspace suggestion tools when enabled; Author gets only
  manifest suggestion. A local test model invokes the profile tool through the
  agent and the real store records only a pending `teacher_suggested` proposal.

### RED evidence

The first test edit used pytest's reserved `request` parameter name. This was a
test-collection mistake, corrected before evaluating the production behavior:

```text
$ uv run pytest tests/test_professor.py -q
ERROR tests/test_professor.py
'request' is a reserved name and cannot be used in @pytest.mark.parametrize
1 error in 1.11s
```

The corrected RED command then exposed the intended production defects:

```text
$ uv run pytest tests/test_professor.py -q
9 failed, 28 passed in 1.53s
```

Seven common result-seeking or near-miss prompts returned `ok` before a
prediction. The two model-tool tests failed with Pydantic AI's explicit schema
error that the proposal callback was registered as a context-taking tool even
though it has no `RunContext` parameter.

### GREEN and full-suite evidence

```text
$ uv run pytest tests/test_professor.py -q
.....................................                                    [100%]
37 passed in 1.09s
```

The subsequent complete-suite command and output are recorded below after the
staged diff review:

```text
$ git diff --check && uv run pytest -q
........................................................................ [ 38%]
........................................................................ [ 77%]
.........................................                                [100%]
185 passed in 16.49s
```

### Fix self-review

- The reveal-term check precedes every allow condition, so `I predict the
  correct answer ...` and process-question near misses remain deterministic
  denials.
- Model tool names are asserted at the Pydantic AI model boundary, rather than
  only in the local policy object.
- The executed tool test uses the real `CourseStore`; it checks pending status,
  teacher origin, and unchanged learner profile, so no automatic target mutation
  can satisfy the test.

## Fix round 2/5: substantive-only predict-first gate

### Findings addressed

The earlier natural-language prediction allowlist has been removed. While the
exact required prediction record is absent, every substantive request now
returns the fixed record-your-prediction response before `model_factory` or
Pydantic AI construction. Only normalized social-only messages remain
non-substantive; prediction recording remains the learner/card state path.

### RED evidence

The test table was first changed to turn process questions and learner-owned
prediction statements into denials, and to add the controller's appended-intent
examples plus ordinary substantive prompts:

```text
$ uv run pytest tests/test_professor.py -q
6 failed, 35 passed in 1.70s
```

The failures were the prior process-question and prediction-statement
allowlist paths: `Where do I record my prediction?`, `How do I submit a
prediction?`, `I predict ...`, `My prediction is ...`, `My hypothesis is ...`,
and the appended-intent record-plus-explain prompt all reached the local model.

### GREEN and full-suite evidence

```text
$ uv run pytest tests/test_professor.py -q
.........................................                                [100%]
41 passed in 1.05s
```

```text
$ git diff --check && uv run pytest -q
........................................................................ [ 38%]
........................................................................ [ 76%]
.............................................                            [100%]
189 passed in 14.32s
```

### Fix self-review

- No prediction-specific regex or intent classifier remains in production code.
- The gate calls the shared substantive-message predicate directly, ensuring
  arbitrary appended intent cannot create a policy exception.
- Existing exact-record opening and model-tool tests remain in the focused
  suite, so this stricter before-record rule cannot close the post-record path
  or alter tool exposure.
