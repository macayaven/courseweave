# ADR 0001: REST owns durable mutation

## Decision

AG-UI carries teacher conversation and inert proposal events only. It is not an
authority for course, learner, or workspace state.

The CourseWeave REST service is the sole durable mutation authority. A model can
request creation of a typed pending proposal, but it cannot apply one. The
learner client applies a change only through an authenticated REST request that
contains:

- the proposal or direct-action ID;
- an idempotency key;
- the expected state revision or target SHA-256;
- the exact proposal revision shown in the UI;
- explicit provenance: `student_requested` or `teacher_suggested`.

No model tool can write files, execute a command, update learner state, or
replace the manifest directly.

## Trust boundaries

- Course manifest, resolved phase, capabilities, accepted profile, and proposal
  status are loaded by the server.
- AG-UI history, client state, client tools, and shared excerpts are untrusted
  input.
- Automatic workspace context contains metadata only.
- Selection, cell content, output, and source excerpts are sent only after an
  explicit Share action. They are size-limited and transient.
- The API binds to loopback and requires a random per-launch bearer token on
  every REST and AG-UI request.

## Consequences

- There is one audit trail and one idempotency implementation.
- Rejecting a proposal cannot accidentally resume a model-side write.
- The teacher can remain provider-neutral.
- The UI renders proposal cards from REST state rather than model prose.
- Terminal commands are displayed or copied into a learner-controlled Jupyter
  terminal. CourseWeave does not execute them in v0.

