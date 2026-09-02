# Architecture review synthesis

## Accepted improvements

- Keep FastAPI, Pydantic AI, AG-UI, React, and a thin prebuilt JupyterLab bridge.
- Limit AG-UI to conversation and inert proposal creation; REST is the sole
  mutation authority.
- Publish schema-v1 and route payload contracts before production code.
- Separate ephemeral metadata-only context from durable learner state.
- Match notebooks by stable cell IDs as well as tags.
- Require explicit sharing for selection, cell, output, and source content.
- Add loopback capability-token authentication and strict
  origin/host/message validation.
- Use exact-byte manifest ETags and SQLite-backed cross-process proposal
  journaling.
- Do not execute manifest terminal commands in v0; display/copy them into a
  learner-controlled Jupyter terminal.
- Add a sandboxed main-area reader for lesson HTML and video; leave Markdown,
  notebooks, source, and terminals to native Jupyter widgets.
- Treat Git LFS pointer files as unavailable media and use declared HTTPS video
  URLs.
- Start with an installed-wheel walking skeleton and one complete S01 slice.
- Pin Python, AG-UI, Node, package-manager, Vite, and JupyterLab compatibility.
- Prove portability with a second fixture course unrelated to the Agent Harness
  Path.

## Rejected suggestions

- Deferring every workspace mutation: CourseWeave retains one-file UTF-8
  replacement proposals because explicit Accept/Edit/Reject is a stated product
  behavior. It uses a SQLite intent journal and hash-based recovery.
- Removing all verification commands: commands remain structured display/copy
  surfaces; CourseWeave simply does not become the shell executor.
- Making Author a separate schema/server repository: it remains a separately
  runnable twin application in the platform repository so there is one schema
  and one persistence implementation.
- Using AG-UI approval interrupts as the durable consent authority: the REST
  proposal store remains authoritative, so a streamed model event cannot apply a
  change twice or bypass target-hash and idempotency checks.
- Executing manifest commands inside the service: v0 keeps commands visible and
  copyable but learner-controlled in a Jupyter terminal.
- Persisting chat by default: v0 continuity lasts for the mounted JupyterLab
  session; durable chat retention can be added later with its own privacy and
  deletion contract.

## Resulting rulings

1. Saved manifests are always structurally complete. Author Studio may hold an
   incomplete unsaved draft locally.
2. Chat history is session-only in v0.
3. Predict and audit restrictions are deterministic server gates, not prompt
   requests.
4. Automatic context never includes content.
5. All destructive changes, including learner-requested file changes, use the
   proposal preview/apply path.
6. The CourseWeave environment owns the service and JupyterLab process. Course
   commands still run through the course's existing `uv run` workflow inside
   the learner-controlled terminal.
