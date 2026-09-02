# Critical findings

1. **The learner surface integration is not implemented by the plan.** Task 7 opens paths through JupyterLab’s document manager, but that does not guarantee the required experience:

   - Markdown needs the rendered viewer, not the default editor.
   - Course HTML contains Mermaid JavaScript. Automatically trusting it in JupyterLab would grant course HTML a dangerous same-origin relationship with the Jupyter server; JupyterLab’s HTML viewer explicitly treats executable HTML as a security boundary.
   - The checked-out MP4 files are Git LFS pointer text, while generated lessons link to public GCS videos. An existence check would therefore accept an unplayable “local video.”
   - Terminal widgets have no path, so the current context contract cannot identify their course phase.
   - No implementation maps lesson links to notebook, lab, source, video, or terminal tabs while retaining the guide rail.

   Add an explicit surface-opening matrix. Use JupyterLab’s rendered Markdown, notebook, editor, and terminal factories, plus one sandboxed CourseWeave main-area iframe for executable lesson HTML and video. Track active widgets using the notebook, MIME-document, file-editor, and terminal trackers; these are public JupyterLab extension points. [JupyterLab file formats](https://jupyterlab.readthedocs.io/en/4.6.x/user/file_formats.html), [JupyterLab extension points](https://jupyterlab.readthedocs.io/en/stable/extension/extension_points.html).

2. **The separate FastAPI origin has no security contract.** A service on another localhost port needs more than `postMessage` origin checking. As written, another webpage or local process could attempt context, proposal, state, or provider requests.

   Require:

   - loopback-only binding;
   - a random per-launch capability token, never a provider credential;
   - exact Origin/Host checks and no permissive CORS;
   - authentication on every API and AG-UI request;
   - validation of `event.origin`, `event.source`, message schema, command name, and arguments;
   - restrictive iframe sandbox, CSP, and referrer policy;
   - HTTPS-only external URLs unless an explicit local-development policy permits loopback HTTP;
   - runtime settings loaded through the authenticated Jupyter contents API and removed or invalidated at shutdown.

   Also reserve the selected port atomically; “find next free port, then start” has a race.

3. **Persistence is not crash-safe or concurrency-safe enough for consented mutation.** “Serialized per process” does not protect two CourseWeave processes, Author plus Learn, or a CLI operation racing a server. The manifest does not define where its revision lives. Accepting a proposal may need to update a target file and an audit/state file, which atomic replacement of each file does not make transactional.

   Define:

   - manifest revision representation;
   - an inter-process lock;
   - compare-and-swap under that lock;
   - temp-file write, flush, replace, and directory flush;
   - a write-ahead proposal intent/result record so a crash after target mutation cannot leave a pending proposal that is applied again;
   - recovery behavior that never silently resets corrupt state;
   - byte/hash algorithm and canonicalization rules;
   - behavior for external file changes and symlink swaps.

4. **Several “server-enforced” teaching policies cannot be enforced by prompts.** A model can reveal a solution during predict-first or provide help during S13 even when it has no mutation tools. If those are true product invariants, the server must deterministically gate the run:

   - before prediction, either lock chat to a fixed clarification response or do not call the model;
   - in observer-only audit mode, disable model help and use fixed observer/status actions;
   - expose only a proposal-creation tool to the model; never expose apply/write/execute tools;
   - apply mutations only through authenticated REST acceptance with revision/hash checks.

   Otherwise, revise the specification to call these instructional policies rather than enforced guarantees.

5. **The schema is not sufficiently defined to implement or test.** `CoursePolicies`, capabilities, completion rules, proposal targets, and store methods are named but not specified. Convert the loose fields into discriminated unions:

   - local surface: required jailed `path`;
   - external surface: required validated `url`, no path;
   - video: exactly one of playable local asset or permitted URL;
   - terminal: structured `argv`, jailed `cwd`, timeout, and display label;
   - notebook match: cell tags/IDs;
   - source match: validated glob;
   - `command-success`: command reference, acceptable exit codes, timeout, and receipt policy;
   - `artifact-exists`: jailed output path that is allowed not to exist initially;
   - capabilities: explicit booleans/allowlists;
   - proposal target: manifest field, learner state, or workspace patch with typed payload.

   The present “all required files must exist” rule conflicts with `artifact-exists`, and non-empty modules/phases/surfaces make incremental Author CRUD impossible without a valid-creation wizard or a separate unsaved draft model.

6. **Conversation ownership, trust, and reconnect semantics are missing.** AG-UI messages are client-controlled; Pydantic AI explicitly warns that submitted history is not authentic. Server instructions, capabilities, resolved context, tool authority, and accepted proposal state must therefore come from server dependencies, not `RunAgentInput.messages` or client AG-UI state. [Pydantic AI AG-UI trust model](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/).

   Define “continuous teacher” precisely. The smallest v0 contract is session-only history retained while the Jupyter sidebar stays mounted, with reload clearly starting a new thread. Do not promise transparent recovery of an interrupted run: Pydantic AI documents that a client disconnect appears as external cancellation and does not invoke its normal cancellation callback. Mark the turn interrupted and let the learner retry. Also distinguish pre-stream JSON errors from in-stream AG-UI `RUN_ERROR` events.

7. **Dependency and build reproducibility is absent.** Current releases have already moved beyond assumptions implicit in the plan:

   - Pydantic AI is currently 2.36.0 and AG-UI is an extra; use `pydantic-ai-slim[ag-ui,openai,anthropic]`, lock it, and code against the current `AGUIAdapter.dispatch_request()` API. [Pydantic AI package](https://pypi.org/project/pydantic-ai-slim/), [AG-UI integration](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/).
   - `@ag-ui/client` is still a fast-moving `0.0.x` package; pin the exact tested client/protocol set. [AG-UI client](https://www.npmjs.com/package/%40ag-ui/client).
   - JupyterLab 4.6 moved extension builds to `jupyter-builder` and `@jupyter/builder`, using Rspack. The plan does not include this build backend or wheel data-file mapping. [JupyterLab 4.6 migration](https://jupyterlab.readthedocs.io/en/stable/extension/extension_migration.html).
   - Current Vite requires Node 20.19 or newer, so “Node 20” is insufficient. [Vite compatibility](https://www.npmjs.com/org/vitejs?activeTab=packages).
   - Add `uv.lock`, `pnpm-lock.yaml`, `packageManager`, `engines`, and exact CI versions. Do not assume all `@jupyterlab/*` packages share the Python package’s `4.6.x` version; JupyterLab npm packages are independently versioned.

# Important findings

- The architecture boundary is coherent if AG-UI is limited to chat/events and REST remains authoritative for manifest, state, context, and proposals. FastAPI can return Pydantic AI’s streaming Starlette response directly. This does not require a custom agent protocol.
- OpenAI-compatible support should use `OpenAIChatModel` with `OpenAIProvider(base_url=..., api_key=...)`. Anthropic-compatible means an endpoint implementing Anthropic Messages semantics and requires a configured `AsyncAnthropic` client passed to `AnthropicProvider`; a Claude model behind an OpenAI-compatible proxy belongs in OpenAI mode. [OpenAI-compatible configuration](https://pydantic.dev/docs/ai/models/openai/), [Anthropic custom endpoint](https://pydantic.dev/docs/ai/models/anthropic/).
- Provider/model selection is promised but has no API. Either remove runtime base-URL selection from v0 or define an authenticated, session-only configuration endpoint. Never accept or return provider keys through the browser.
- Provider construction must be lazy. Missing credentials or a broken provider must not prevent application startup, REST CRUD, JupyterLab, or static assets.
- Context sequence numbers require a `source_id`/epoch plus sequence. A single global counter rejects valid updates after reload and cannot order two browser tabs. Define which active learner client owns the current context.
- Automatic active-document observation must not persist `last_active_phase` unless that persistence is classified as a direct learner navigation action. Otherwise it contradicts the durable-mutation invariant.
- The specification contradicts itself on selection: `WorkspaceContext` and the bridge imply reporting it, while §12 says selection is sent only explicitly. Make selection opt-in through a “Share selection” action and never observe file contents or notebook output.
- A path jail does not constrain commands. Named verification must use direct argument vectors, jailed working directories, timeouts, output limits, and explicit learner invocation. Do not execute imported manifest command strings through a shell.
- Author Studio needs a second unrelated fixture course as a portability test. Reusing the same schema against one course does not prove reusability.
- Author must handle a course root with no manifest. `load_manifest()` currently assumes a file, while “empty course” is not the same as “new course.”
- The adapter must explicitly choose generated lesson HTML as the primary reading surface while preserving Markdown source as canonical authoring material. Video surfaces should use the published URL when the local file is an LFS pointer.
- The launcher needs one environment owner. The simplest rule is that the CourseWeave environment owns both the service and `python -m jupyterlab`; the course’s `uv` environment remains available in terminals for its existing gates.
- The current adaptive fork is clean, while the protected source checkout has five modified files. Verification must snapshot both repositories before and after and fail on any new protected-checkout change.

# Simplifications

- Keep Pydantic AI + AG-UI + FastAPI + the iframe-based JupyterLab bridge. React 19 remains isolated inside the iframe, avoiding React/Lumino dependency conflicts in the prebuilt extension.
- Use AG-UI only for streamed teacher interaction. Do not duplicate durable learner state in AG-UI shared state.
- Use one `PUT /api/course` compare-and-swap operation for Author CRUD; create, duplicate, reorder, and delete can remain client-side draft operations until a valid atomic save.
- Keep chat session-only in v0. Persistent chat introduces retention consent, credential scrubbing, migration, and conflict semantics that are not necessary for phase continuity within one JupyterLab session.
- Use one generic sandboxed main-area surface widget for lesson HTML and video instead of building a full custom course reader.
- Restrict execution to manifest-declared named verification commands. Do not build a generic shell or terminal-output capture system.
- Have all destructive workspace changes, including learner-initiated ones, pass through the same preview/hash/confirm/apply pipeline.
- Support and test one release tuple first: Python 3.11, Node 20.19+, JupyterLab 4.6.3, and exact locked Python/npm packages. Broaden ranges only after compatibility tests exist.

# Missing tests

| Area | Required executable coverage |
|---|---|
| Manifest | Every discriminated variant; exact-one-of path/URL; slug/title boundaries; malformed JSON/UTF-8; video ranges; overlapping matches; glob validation; LFS-pointer video rejection; missing future artifact allowed; deterministic serialization; revision representation. |
| Path safety | Absolute paths, `..`, encoded separators, symlinked root/ancestor/final target, nonexistent target under symlinked parent, symlink swap during acceptance, URL scheme rejection, command `cwd` escape. |
| Context | Every precedence rule; invalid partial explicit IDs; overlapping path/tag/video matches; manifest-order tie; normalized Jupyter paths; unknown widgets; per-source sequence/reload; two tabs; terminal and MIME-document focus; selection opt-in. |
| Phase policy | Deterministic pre-prediction chat lock; prediction transition; all phase postures; S13 no-help behavior; S14 named verification; capability denial independent of model output. |
| Store | Multi-process conflicts; crash before/after target replace; corrupt/truncated state; failed/superseded proposals; duplicate idempotency keys; second acceptance after restart; external target modification; stable audit ordering. |
| Providers | Real stub HTTP servers for OpenAI Chat Completions and Anthropic Messages, including streaming/tool calls; missing key; malformed response; timeout; authentication failure; unsupported tools; no secret in logs, errors, state, browser payloads, or receipts. |
| AG-UI/API | Exact SSE content type and event ordering; malformed run input; protocol-version compatibility; client-controlled system/tool history ignored; pre-stream versus in-stream errors; disconnect/cancel behavior; duplicate run IDs; every route, method, status, and error envelope. |
| Local security | Loopback binding; token required; invalid Host/Origin; CORS preflight denial; forged cross-origin POST; expired runtime token; iframe sandbox/CSP; forged `postMessage`; command/path allowlists. |
| JupyterLab | Wheel installed into a clean Python 3.11/JupyterLab 4.6.3 environment; extension listed; sidebar survives document changes; real lesson HTML with Mermaid; remote video and LFS-pointer behavior; rendered Markdown; notebook cell/tag context; source selection; terminal context; backend failure/reload. |
| UI/accessibility | Keyboard-only flow; focus retention; labels; contrast; reduced motion; narrow sidebar; stale draft recovery; prediction and audit locks; interrupted stream; provider-disabled non-chat operation. |
| Author | New root without manifest; valid create wizard; incomplete unsaved draft; second unrelated technical course; exact import/export; stale save preserving draft; rejected proposal byte identity; accepted edit increments once. |
| CLI/processes | Atomic port allocation; service readiness before Jupyter; startup failure; SIGINT/SIGTERM; orphan prevention; runtime-file cleanup; same-environment Jupyter invocation; browser-open failure. |
| Adapter | Exact S01–S14 surface matrix; published-video URL choice; S01–S12 predict-first; S13 observer lock; S14 verification; no notebook mutation; adaptive fork and protected checkout before/after status and hashes; every existing course gate. |
| End to end | Playwright against an actual installed JupyterLab, not only `/learn/`; phase changes driven by real widgets; reject/no mutation; edited accept/exactly once; Author CRUD; provider absent; fake-provider chat; backend interruption; reload persisted state. |

# Recommended plan edits

1. Add **Task 0: contract and compatibility spike** before schema work:

   - lock current Python/npm versions;
   - prove Python 3.11 imports and runs `AGUIAdapter.dispatch_request()`;
   - prove both provider constructors against local stub servers;
   - build a minimal JupyterLab 4.6.3 prebuilt extension using `jupyter-builder`;
   - install its wheel into a disposable environment;
   - open one sandboxed surface iframe and exchange a validated message.

2. Expand Task 1 with complete JSON/Pydantic models for revision, policies, capabilities, matchers, completion rules, commands, proposal targets, and structural versus runnable validation. Publish deterministic JSON Schema.

3. Expand Task 2 with inter-process locking, crash recovery, write-ahead proposal records, canonical hashes, explicit `CourseStore` method signatures, and a `source_id`/epoch context-ordering contract.

4. Change Task 3 so server dependencies own context and capability policy. Add deterministic predict/audit gates and actual OpenAI/Anthropic stub-wire tests. Define or remove runtime model/base-URL selection.

5. Change Task 4 to add loopback authentication, Origin/Host enforcement, request limits, lazy provider creation, AG-UI streaming error semantics, cancellation behavior, and atomic port binding.

6. Change Task 5 to define the exact `@ag-ui/client` package/version and session-only thread lifecycle. Add the explicit surface-opening message schema rather than a generic command contract.

7. Change Task 7 to:

   - use `jupyter-builder` and `@jupyter/builder`;
   - package the extension under `share/jupyter/labextensions/<package>` with `package.json` and `install.json`;
   - keep React out of the bridge bundle;
   - implement the surface factory matrix and all relevant widget trackers;
   - load authenticated runtime settings dynamically;
   - verify the built wheel in Python 3.11 with JupyterLab 4.6.3.

8. Change Task 8 to specify the complete S01–S14 mapping in the plan. Treat LFS pointers as unavailable local video and map the public video URL. Capture protected-checkout status and hashes before work and assert exact preservation afterward.

9. Change Task 9 from partly manual checks to an executable installed-wheel E2E suite. Record exact lockfile hashes, package versions, browser version, commands, test counts, repository SHAs, pre/post statuses, known network-dependent video behavior, and any unsupported platform combinations.

# Go/no-go verdict

**No-go for implementation from the current plan.** The selected architectural boundary is sound and should be retained, but the plan is missing the safe content-rendering path, localhost security boundary, enforceable phase gates, transactional persistence contract, complete public schema/API, and reproducible JupyterLab 4.6 build configuration.

Proceed after the critical contracts are incorporated and Task 0 proves the exact locked stack end to end. At that point this becomes a focused vertical product rather than a speculative framework.