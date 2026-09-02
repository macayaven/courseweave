# Critical findings

1. **The manifest and mutation contracts are not concrete enough to implement test-first.**  
   The specification names `CoursePolicies`, `capabilities`, `completion`, `match`, learner state, proposal payloads, audit records, and error envelopes without defining their fields or JSON shapes. Surface validation is also ambiguous: which types require `path`, which require `url`, whether video permits either or both, how command completion identifies a command, and how source globs interact with exact-path resolution. The plan’s first RED cycle would therefore test an implementation-specific contract invented by the implementer, not the agreed product.
   - Publish a complete schema-v1 JSON Schema plus valid and invalid examples before Task 1.
   - Use discriminated unions for surface types and completion rules.
   - Define request and response models for every public route, including proposal revisions and mutation provenance.
   - Resolve the manifest concurrency token: `save_manifest(... expected_revision)` is public, but `revision` is not part of the manifest contract. Prefer an HTTP `ETag` based on the exact saved bytes unless revision is deliberately added to schema v1.

2. **Consent currently has two competing control planes and no authoritative enforcement boundary.**  
   The design defines a durable REST proposal lifecycle, while Pydantic AI/AG-UI has its own interrupt/resume approval mechanism. If both are used, Accept can re-enter a tool while the REST layer separately applies the proposal, creating duplicate-execution and audit ambiguity. More importantly, AG-UI message history, state, context, and frontend tools arrive from the client; Pydantic AI explicitly treats submitted history as unauthenticated client input. ([ai.pydantic.dev](https://ai.pydantic.dev/ag-ui/))
   - Choose one consent mechanism. The smallest safe choice is: **AG-UI streams conversation only; a model tool may create an inert, typed proposal; only the REST proposal service may mutate durable state.**
   - Do not register any model tool that directly writes files, state, or the manifest.
   - Ignore client-supplied AG-UI tools for authority decisions. Build trusted dependencies—resolved phase, policy, allowed proposal types, course identity—on the server.
   - Direct `PUT /api/course` and `PATCH /api/state` need explicit `student_requested` provenance, expected revision/hash, and an idempotency key. Otherwise the proposal gate is trivially bypassed.
   - If AG-UI interrupts are retained, lock `ag-ui-protocol >=0.1.19`; older versions silently omit interrupt outcomes and ignore resume entries. ([ai.pydantic.dev](https://ai.pydantic.dev/ag-ui/))

3. **The “automatic context, consented mutation” invariant contradicts the proposed state model.**  
   Automatic context updates appear to update “last active module/phase,” and completion modes such as `command-success` and `artifact-exists` imply automatic durable writes. Both conflict with the rule that durable learner-state changes require a direct request or accepted proposal.
   - Separate **ephemeral navigation/session state** from **durable semantic learner state**.
   - Either keep last-active phase session-only, or narrow the invariant to permit explicitly enumerated non-semantic UI continuity fields.
   - Define whether opening a phase, submitting a prediction, running verification, and detecting an artifact each count as direct learner actions.
   - No profile, reflection, goal, strength/weakness claim, or evidence interpretation may be inferred from navigation or chat and persisted automatically.
   - Add a mutation matrix listing every writable field, allowed initiators, required preview, concurrency token, audit behavior, and whether rejection must preserve bytes and metadata.

4. **The Agent Harness Path cannot be phase-resolved as specified without changing the canonical notebooks.**  
   The resolver ignores `active_cell_id` even though `WorkspaceContext` carries it, and prefers the first manifest phase referencing a repeated path. The authoritative notebooks have stable cell IDs but no cell tags. Therefore separate predict and experiment phases referencing one notebook will repeatedly resolve to the first phase, while adding tags would violate the protected-content requirement.
   - Add `match.cell_ids` or another stable cell-ID selector to schema v1 and resolver precedence.
   - Among phases sharing a path, prefer an exact cell-ID match; then a tag match; then the last-active phase among matching candidates; use manifest order only as a final deterministic tie-breaker.
   - Scope context sequence numbers by `bridge_session_id`. A persisted global sequence will reject every update after browser reload resets the counter, while independent Jupyter windows will race each other.
   - Define equal-sequence behavior: same payload is idempotent; different payload is a conflict.
   - Add adapter fixtures from actual S01, a solution-bearing notebook, S13, and S14 before implementing the generic resolver.

5. **The teaching behavior cannot be delivered with the specified context payload.**  
   The professor is expected to explain selected text, interpret notebook outputs, diagnose source, clarify terminal failures, and enforce predict-first withholding. Yet the bridge sends no file contents or outputs automatically, and the plan defines no explicit content-sharing path. Reading an entire notebook server-side would expose later `# SOLUTION` cells and defeat predict-first behavior.
   - Specify that automatic context contains metadata only.
   - Add explicit, bounded actions such as **Share current cell**, **Share selected text**, and **Share copied output**. Shared content must be transient by default, size-limited, and excluded from learner/profile persistence.
   - Never send the complete notebook merely because it is active.
   - The deterministic policy layer—not the prompt—must prevent solution-cell content from being supplied before a prediction is recorded.
   - Clarify the contradiction where the bridge both “reports selection” and promises selection is sent only explicitly. Selection text should be omitted from normal context updates and transmitted only after a learner action.
   - Add a visible disclosure that provider-backed chat sends shared excerpts to the selected endpoint.

6. **Exactly-once proposal application is not supported by per-process locks and atomic replacement alone.**  
   `launch` and `author` are separately runnable, so two CourseWeave processes can target the same course. Per-process serialization cannot prevent cross-process lost updates. Accepting a source-file proposal also changes at least two durable objects—the target and the proposal/audit store—which cannot be made atomic by a single file replacement. A crash between them can leave the mutation applied but the proposal pending.
   - Enforce one active CourseWeave service per course with an interprocess lock; `author` should reuse it when available.
   - Re-read and validate expected revisions/hashes while holding that lock.
   - For workspace writes, either add a recoverable write-ahead journal with before/after hashes and crash recovery, or explicitly defer automatic source/notebook mutation from v0.
   - Define idempotency-key semantics: replaying the same key and payload returns the original result; reusing the key with a different payload is a conflict.
   - Test concurrent Accept, Accept-versus-Edit, process crash at each persistence boundary, and restart recovery.

7. **Terminal and verification behavior crosses a security boundary that the path jail does not address.**  
   A jailed `command` string can still read or modify anything available to the process, access the network, print environment secrets, hang, or spawn children. “Allowlisted command from the iframe” is not equivalent to a safe command runner.
   - The smallest v0 correction is to display/copy a manifest command into a learner-controlled Jupyter terminal and make completion manual or receipt-based.
   - Do not let the iframe, model, or service execute terminal commands automatically in v0.
   - If `command-success` remains, it needs a separate execution specification: exact argv versus shell, fixed cwd, sanitized environment, timeout, output limits, cancellation, process-group cleanup, exit-code receipt, concurrency, and redaction. That is a substantial additional subsystem.

8. **The planned Jupyter bridge does not yet provide the promised learner surface.**  
   Task 5 mentions a reader, but only implements a guide rail and dashboard; Task 7 opens paths through JupyterLab’s document manager. There is no defined main-area reader, jailed artifact-serving route, or video/external-surface behavior. JupyterLab documents an MP4 renderer as an extension example rather than a guaranteed core viewer, so “open path” is not sufficient proof that every installation can play the course videos. ([jupyterlab.readthedocs.io](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html))
   - Define one main-area CourseWeave reader for lesson HTML and video, while notebooks, Markdown, Python source, and terminals remain native JupyterLab widgets.
   - Keep the teacher thread only in the persistent rail; do not mount competing conversation instances in reader tabs.
   - Specify offline video behavior, blocked embedding, invalid URL, and public-GCS fallback.
   - Add an executable browser test for each required surface type, not merely a final manual inspection.

# Important findings

1. **The stack boundary is coherent after the preceding corrections.**  
   FastAPI is appropriate for typed local REST and streaming routes; Pydantic AI supplies provider adapters and test models; AG-UI supplies the chat event protocol; and a prebuilt JupyterLab extension can remain thin. Pydantic AI’s FastAPI integration is a direct supported path. ([ai.pydantic.dev](https://ai.pydantic.dev/ag-ui/)) The problem is not the selected stack but assigning persistence, authorization, phase ownership, or mutation execution to the AG-UI boundary.

2. **The provider factory must choose explicit model classes.**  
   Current Pydantic AI resolves the bare `openai:` prefix to the Responses API, while many “OpenAI-compatible” endpoints implement Chat Completions only. The factory should explicitly construct `OpenAIChatModel` for generic compatible endpoints and maintain a compatibility test for structured tools. ([ai.pydantic.dev](https://ai.pydantic.dev/models/openai/)) Anthropic-compatible custom base URLs require construction through a custom Anthropic client/provider path rather than assuming identical handling to OpenAI. ([ai.pydantic.dev](https://ai.pydantic.dev/models/anthropic/))

3. **Dependency and build reproducibility are missing from the plan.**
   - As of September 1, 2026, `pydantic-ai-slim` is at 2.37.0 and supports Python 3.11, but OpenAI, Anthropic, and AG-UI are separate extras. Use `pydantic-ai-slim[ag-ui,openai,anthropic]`, lock the resolution, and set `ALLOW_MODEL_REQUESTS=False` globally in tests. ([pydantic.dev](https://pydantic.dev/docs/ai/install/))
   - “Node 20” is insufficient for the current Vite toolchain, which requires Node 20.19 or later on the Node 20 line. ([vite.dev](https://vite.dev/guide/))
   - Add `uv.lock`, `pnpm-lock.yaml`, a pinned `packageManager`, Python classifiers, and `engines.node`.
   - Test frozen installs rather than only development checkouts.

4. **The JupyterLab extension should use the official prebuilt-extension structure rather than an ad hoc Vite bundle.**  
   The learner and author apps may use Vite, but the Lab package should use the Jupyter extension builder/template and correct `jupyterlab` package metadata. JupyterLab recommends Python-packaged prebuilt extensions and warns that extensions may break on newer Lab releases, recommending an upper compatibility bound. ([jupyterlab.readthedocs.io](https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html)) Target `jupyterlab >=4.6,<4.7` initially, with matching `^4.6.0` frontend packages, and verify installation without Node present.

5. **Runtime discovery needs course identity and stale-file protection.**  
   A generated runtime settings file containing only a port can connect a reopened workspace to a different service after port reuse. Include a per-launch nonce, course ID, canonical-root fingerprint, process start identity, and protocol version. The extension must verify the health handshake before sending context. Check both exact origin and `event.source === iframe.contentWindow`.

6. **Local-only does not mean authority-free.**
   - Bind to loopback by default.
   - Validate Host and Origin on mutating requests.
   - Never expose absolute course paths in health responses or errors.
   - Treat UI-selected base URLs as an egress/security decision; reject embedded credentials and unsupported schemes.
   - Do not log request bodies for guide, proposal, shared-content, or provider-error routes.

7. **AG-UI streaming errors do not fit the universal JSON error-envelope claim.**  
   Errors before streaming can use the REST envelope; failures after stream headers are sent must be represented as AG-UI error events. Cancellation also has distinct protocol semantics. Define this exception explicitly and test disconnect, timeout, cancellation, malformed input, and mid-stream provider failure. Pydantic AI exposes a cancellation persistence hook because resumable history otherwise needs deliberate handling. ([ai.pydantic.dev](https://ai.pydantic.dev/ag-ui/))

8. **Conversation continuity is underspecified.**  
   Define whether the thread survives only document changes, also browser reloads, or backend restarts. Define conversation IDs, model-selection scope, cancellation, compaction, maximum history, and whether chat is stored. If stored, chat content requires its own consent, retention, corruption, migration, and secret-redaction rules; omitting chat from durable state is the simpler v0 choice.

9. **Capabilities are not enforced merely by testing prompt text.**  
   Task 3 tests phase instructions and “forbidden mutation capabilities,” but the plan must test the actual server-side tool set and mutation service. Audit mode should result in zero registered mutation/proposal tools unless help is explicitly enabled. Predict mode should prevent solution material from entering model input, not simply instruct the model to withhold it.

10. **Author Studio reusability needs proof from a second, structurally different course.**  
    A CRUD application that only works with S01–S14 conventions is an adapter editor, not a reusable authoring tool. Test a second fixture with arbitrary IDs, no notebooks, no videos, different phase ordering, local and remote artifacts, an initially empty course, and no Agent Harness terminology. Do not hard-code phase-card behavior around `SNN`, predict-first, or the trivia lab.

11. **The video adapter must not assume Git LFS media is locally playable.**  
    The course intentionally skips LFS media on normal clone and streams public GCS replicas. A local MP4 path may be a pointer or unavailable. The manifest should use the canonical public URL with a clear offline-unavailable state and must not make remote video availability part of manifest validation.

12. **The protected dirty checkout needs stronger evidence than a final status command.**  
    Capture its initial canonical path, HEAD, porcelain-v2 status, staged/unstaged patch hashes, and untracked-path inventory before adapter work. Recompute afterward. The adapter tests and launchers should not reference the protected checkout at all.

# Simplifications

1. **Keep one process and one API.**  
   `courseweave launch` starts or acquires the per-course service and JupyterLab. `courseweave author` reuses that service and opens `/author/`; it should not start a competing writer.

2. **Use AG-UI only for chat streaming.**  
   Keep phase context, learner state, Author CRUD, proposals, and acceptance on ordinary typed REST endpoints. This removes duplicated state synchronization and approval semantics.

3. **Restrict v0 mutation targets.**  
   Safely support learner-state and manifest mutations first. Show source/notebook diffs as review-only proposals that the learner applies in JupyterLab unless a recoverable transaction design is added and tested.

4. **Remove automatic shell execution from v0.**  
   Open a terminal and present the exact verification command. Record completion only after an explicit learner action or imported receipt.

5. **Use metadata-only automatic context plus explicit content sharing.**  
   This is easier to explain, test, redact, and keep compatible across notebook, source, terminal, lesson, and video surfaces.

6. **Use one generated schema as the cross-language contract.**  
   Generate JSON Schema from the Python models and derive or validate the TypeScript types against it. Do not manually maintain independent Python, frontend, and Author definitions.

7. **Use ETags for `courseweave.json`.**  
   A hash of the exact saved bytes avoids inventing a manifest revision field and directly supports byte-preservation tests, stale-save detection, deterministic export, and import.

8. **Implement one narrow main-area reader.**  
   It needs only jailed lesson HTML and HTML5 video. Let JupyterLab continue to own notebooks, Markdown editors/viewers, Python source, and terminals.

# Missing tests

## Contracts and manifest

- Published schema validates every committed example and rejects every invalid fixture.
- Invalid JSON, unsupported/future schema version, whitespace-only IDs, duplicate IDs at each scope, malformed UTF-8, and unexpected fields.
- Per-surface required/forbidden field combinations.
- Video range ordering, negative values, one-ended ranges, and boundary inclusivity.
- URL scheme allowlist, URL credentials, fragments, and offline remote resources.
- Cell-ID, tag, source-glob, and repeated-path matching.
- Manifest ETag conflict and deterministic byte-for-byte export.
- Read-only course root, missing parent, permission failure, interrupted replacement, and temp-file cleanup.
- Course root or target replaced with a symlink after validation.

## Context and phase policy

- Two bridge sessions with overlapping sequence numbers.
- Browser reload with a new session ID and sequence reset.
- Equal sequence with equal versus different payloads.
- Unsaved notebook tag/cell changes and deleted active cells.
- Explicit phase with wrong module, missing phase, or removed phase.
- Last-active phase no longer present after Author edits.
- Multiple phases sharing one notebook with real Agent Harness cell IDs.
- Unknown files and generic terminals do not hijack the current module.
- Predict-first gate cannot receive or disclose a later solution cell.
- Selection and shared content are absent from state, audit, logs, and subsequent runs unless deliberately attached.

## Consent and persistence

- Forged AG-UI message history, state, context, frontend tools, and resume entries cannot cause mutation.
- Every mutation route validates provenance, expected revision/hash, and idempotency key.
- Same idempotency key with a different payload returns conflict.
- Concurrent double Accept applies once.
- Accept races with Edit, Reject, Author save, and external file modification.
- Crash injection before journal write, after journal write, after target replacement, and before audit finalization.
- Restart recovery returns a deterministic accepted or failed result.
- Rejection and stale acceptance preserve target bytes; where required, also preserve mtime.
- Accepted profile changes contain only fields shown in the confirmation UI.
- Navigation and provider/model selection do not silently create profile claims.
- Corrupt state is preserved for diagnosis rather than overwritten by an empty store.

## Provider and AG-UI

- Explicit `OpenAIChatModel` against a fake Chat-Completions-only endpoint.
- Anthropic-compatible custom base URL through the proper client.
- Unsupported tool calling, malformed structured output, authentication failure, timeout, rate limit, disconnect, cancellation, and retry exhaustion.
- Provider errors cannot include key values, authorization headers, URL userinfo, or shared source content.
- All tests globally block accidental real model requests.
- AG-UI protocol compatibility and event snapshots are tested against locked Python and TypeScript versions.
- Pre-stream errors use the REST envelope; post-stream failures emit the expected AG-UI error event.
- Client history cannot replace server instructions or trusted phase policy.

## Learner and Author UI

- Browser flows for HTML lesson, remote video, notebook, lab Markdown, Python source, terminal, and external/unavailable surface.
- The teacher thread remains mounted with the same conversation ID across every surface change.
- No-provider, provider unavailable, provider lost mid-stream, and backend restart states.
- Explicit share-current-cell and share-output flows, including cancellation and size limits.
- Focus transfer across the iframe, main area, proposal drawer, and terminal.
- Keyboard-only Accept/Edit/Reject, visible focus, screen-reader labels, narrow rail, reduced motion, and Jupyter dark/light theme changes.
- Author stale save retains the complete draft and supports reload/merge/discard.
- Deep duplication regenerates every module, phase, and surface ID without changing content.
- Import failure leaves the prior manifest byte-identical.
- A second non-Agent-Harness course passes the complete Author CRUD suite.

## Packaging, launch, and adapter

- Frozen Python 3.11 installation and frozen Node 20.19+ installation.
- Wheel installation and JupyterLab 4.6 browser smoke test in an environment with no Node executable.
- Package-data assertions for both static applications and extension metadata.
- Frontend assets work from `/learn/` and `/author/` with correct Vite base paths and reload behavior.
- Static SPA fallback never masks `/api/*` 404 or method errors.
- Occupied-port race between discovery and bind, stale runtime file, wrong course identity, and unclean prior shutdown.
- SIGINT/SIGTERM stops only owned child processes and removes or invalidates runtime discovery safely.
- Launcher works with spaces in paths, missing sibling platform, installed-only platform, and existing service.
- LFS pointer videos are not treated as playable local media.
- S13/S14 remain notebook-less and optional.
- CourseWeave never modifies canonical notebook cells, metadata, or committed outputs.
- Protected source checkout evidence is identical before and after all gates.
- Each original course gate runs from the adapter checkout, not the protected source checkout.

# Recommended plan edits

1. **Insert Task 0: freeze contracts and invariants.**
   - Commit schema-v1 JSON Schema and complete examples.
   - Define REST bodies/responses, ETags, error codes, proposal types, postMessage messages, runtime handshake, session IDs, and the mutation matrix.
   - Record an ADR selecting REST proposals as the sole mutation authority.
   - Define metadata-only automatic context and explicit content sharing.
   - Decide whether source mutation and command execution are deferred.

2. **Replace the layer-first opening with a tested walking skeleton.**
   - Create locked Python and pnpm projects.
   - Serve `/api/health`, an immutable minimal course, and a placeholder `/learn/`.
   - Package a template-derived prebuilt extension that opens the guide iframe.
   - Build a wheel, install it into Python 3.11 with JupyterLab 4.6, and run one browser smoke test.
   - Only then expand the core. This exposes packaging, origin, static-routing, and runtime-discovery failures before seven tasks depend on them.

3. **Revise Task 1 around the published schema.**
   - Use discriminated models.
   - Replace manifest revision with exact-byte ETags unless schema v1 explicitly includes revision.
   - Add surface field-combination and URL validation.
   - Generate the frontend schema/type artifact as part of verification.

4. **Split Task 2 into context/session resolution and durable consent storage.**
   - Implement `bridge_session_id` plus per-session sequence.
   - Add cell-ID matching before adapting the real notebooks.
   - Define ephemeral versus durable state.
   - Add a per-course interprocess lock and crash-recovery strategy before claiming idempotent mutation.

5. **Make Task 3 read-only first.**
   - Install and lock `pydantic-ai-slim[ag-ui,openai,anthropic]`.
   - Build trusted server dependencies for each run.
   - Register no mutation tools.
   - Test both provider families and ensure all real model requests are disabled in the test process.
   - Add inert proposal creation only after the consent service is proven.

6. **Revise Task 4’s API boundaries.**
   - Add explicit student-requested mutation endpoints or fields.
   - Enforce ETags/revisions and idempotency uniformly.
   - Bind loopback, validate origin/host, cap request sizes, and redact errors.
   - Document REST errors separately from AG-UI stream errors.
   - Add cancellation and client-disconnect handling.

7. **Revise Task 5 to include the real learning surface.**
   - Add the main-area lesson/video reader.
   - Add explicit content-sharing actions.
   - Keep one teacher thread in the rail.
   - Introduce one browser test per new vertical behavior rather than postponing all E2E work to Task 9.

8. **Keep Task 6 schema-driven and course-neutral.**
   - Test Author against both the minimal fixture and a second structurally different technical course.
   - Exercise the same backend mutation and conflict code as direct manifest saves; do not create an Author-only persistence path.

9. **Build Task 7 from the official JupyterLab extension template.**
   - Use Jupyter’s builder for the extension and Vite only for Learn/Author.
   - Pin the initial compatibility range to JupyterLab 4.6.
   - Verify wheel installation without Node and browser behavior against the packaged wheel, not a development link.

10. **Make Task 8 incremental.**
    - First map one complete S01 slice: lesson, public video, notebook cell IDs, lab Markdown, Python source, and terminal instruction.
    - Pass its resolver and browser tests.
    - Expand to S02–S12, then separately add S13 audit and S14 ship.
    - Capture protected-checkout evidence before any adapter command.

11. **Move most of Task 9’s E2E tests into their owning tasks.**  
    Task 9 should rerun the complete locked matrix and record receipts, not discover whether the fundamental integration works for the first time.

12. **Add explicit dependency success criteria.**
    - `uv sync --frozen` on Python 3.11.
    - `pnpm install --frozen-lockfile` on Node 20.19 or newer.
    - Locked AG-UI Python/TypeScript protocol compatibility.
    - JupyterLab 4.6 wheel install and browser smoke test.
    - No network or credential required for the default automated suite.

# Go/no-go verdict

**No-go for implementation from the current plan. Conditional go for the architecture direction.**

Pydantic AI + AG-UI + FastAPI + a small prebuilt JupyterLab bridge is a coherent stack, but the present documents leave implementers to invent core schema, consent, transaction, context-sharing, execution, and reader behavior. The existing layer-first plan would produce large amounts of code before proving that the packaged Jupyter boundary or the real Agent Harness phase mapping works, and several claimed invariants cannot be enforced by the described components.

Implementation should begin only after these entry conditions are satisfied:

1. schema-v1 and public API payloads are executable contracts;
2. REST proposals are established as the sole mutation authority;
3. ephemeral context is separated from consented durable state;
4. cell-ID resolution and explicit content-sharing behavior are defined;
5. cross-process and crash semantics are specified;
6. automatic shell execution is removed or fully designed;
7. a packaged Python 3.11/JupyterLab 4.6 walking skeleton passes;
8. one real S01 vertical slice passes browser tests without modifying canonical course material.