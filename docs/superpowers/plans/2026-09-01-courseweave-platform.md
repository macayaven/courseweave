# CourseWeave Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable local technical-course platform with a phase-aware JupyterLab learner guide, a separately runnable authoring CRUD app, and an Agent Harness Path adapter.

**Architecture:** One typed Python package owns the schema, deterministic phase resolver, consent store, provider adapter, and authenticated FastAPI/AG-UI service. Two React entry points share UI primitives; a non-React prebuilt JupyterLab bridge supplies active-surface metadata and a persistent guide rail. Each course adds only `courseweave.json` and a launcher.

**Tech Stack:** Python 3.11, Pydantic 2, `pydantic-ai-slim[ag-ui,openai,anthropic]==2.37.0`, FastAPI, Typer, SQLite, pytest, React 19, TypeScript, Vite 8, Vitest, Testing Library, Playwright, JupyterLab 4.6.3, `jupyter-builder`.

**Spec:** `docs/superpowers/specs/2026-09-01-courseweave-platform-design.md`

**Normative contracts:**

- `docs/contracts/courseweave.schema.json`
- `docs/contracts/api.md`
- `docs/contracts/mutation-matrix.md`
- `docs/adr/0001-trust-and-mutation.md`

## Global Constraints

- Keep `/Volumes/mac-studio-ssd/education/agentic-harnessing-companion` byte- and status-unchanged.
- Work only in `/Volumes/mac-studio-ssd/education/courseweave` and `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor`.
- Automatic context is metadata-only; selection, cells, output, and source excerpts require an explicit Share action.
- AG-UI carries conversation and inert proposal events only; authenticated REST is the sole durable mutation authority.
- Never persist, print, log, or return credential values.
- Preserve the Agent Harness Path zero-network core and stdlib-only notebook contract.
- The resolver and predict/audit gates are deterministic; the model does not own phase transitions or forbidden-help decisions.
- The course and Author CRUD remain usable when AI is unconfigured or unavailable.
- CourseWeave does not execute manifest commands in v0; it displays/copies structured argv into a learner-controlled terminal.
- Use test-first RED/GREEN cycles for every production behavior.
- Commit `uv.lock` and `pnpm-lock.yaml`; frozen installs are release gates.
- Keep platform code out of course adapters.

---

### Task 0: Locked walking skeleton and packaging proof

**Files:**
- Create: `pyproject.toml`
- Create: `src/courseweave/__init__.py`
- Create: `src/courseweave/api.py`
- Create: `src/courseweave/cli.py`
- Create: `src/courseweave/__main__.py`
- Create: `src/courseweave/static/learn/index.html`
- Create: `frontend/package.json`
- Create: `frontend/pnpm-workspace.yaml`
- Create: `frontend/packages/lab/package.json`
- Create: `frontend/packages/lab/src/index.ts`
- Create: `frontend/packages/lab/schema/plugin.json`
- Create: `tests/test_walking_skeleton.py`
- Create: `tests/test_packaging.py`

**Produces:** installable `courseweave`, authenticated `/api/health`, placeholder `/learn/`, prebuilt CourseWeave JupyterLab sidebar, `uv.lock`, and `pnpm-lock.yaml`.

- [ ] Write tests that require `create_app()` to expose authenticated health/static routes and require wheel metadata to contain the labextension and static learner asset.
- [ ] Run the focused tests and record the missing-package failures.
- [ ] Create the locked Python package with loopback capability-token middleware and a minimal CLI.
- [ ] Create the official prebuilt-extension package structure using `jupyter-builder`; the bridge opens one sandboxed iframe and contains no React.
- [ ] Build frontend artifacts and the wheel.
- [ ] Install the wheel into a disposable Python 3.11 environment with JupyterLab 4.6.3 and verify `courseweave --help`, `/api/health`, and `jupyter labextension list`.
- [ ] Run `uv sync --frozen`, `pnpm install --frozen-lockfile`, Python tests, TypeScript typecheck, and both builds.
- [ ] Commit as `feat: prove CourseWeave walking skeleton`.

### Task 1: Schema-driven manifest and deterministic context

**Files:**
- Create: `src/courseweave/models.py`
- Create: `src/courseweave/manifest.py`
- Create: `src/courseweave/context.py`
- Create: `tests/test_manifest.py`
- Create: `tests/test_context.py`
- Create: `examples/minimal-course/courseweave.json`
- Create: `examples/minimal-course/lesson.md`
- Create: `examples/cli-course/courseweave.json`
- Create: `examples/cli-course/lesson.md`
- Modify: `src/courseweave/api.py`

**Produces:** Pydantic models matching schema v1, exact-byte ETags, jailed paths, structural/runnable validation, and pure `resolve_context()`.

- [ ] Write literal valid/invalid fixtures for every surface/completion variant, duplicate IDs, missing entry module, empty course, malformed JSON, unexpected fields, video ranges, HTTPS URLs, LFS pointer video, missing future artifact, path/symlink escape, and deterministic export.
- [ ] Write context tests for every precedence level, real cell IDs, repeated notebook paths, video boundaries, unknown files, explicit terminal IDs, source IDs, reload sequence reset, stale/equal/conflicting sequences, and empty courses.
- [ ] Run focused tests and record RED failures.
- [ ] Implement discriminated Pydantic models, manifest load/save/draft, ETag compare-and-swap, path jail, LFS detection, and JSON Schema parity check.
- [ ] Implement pure phase resolution and an in-memory per-source ephemeral context registry.
- [ ] Add authenticated course/context routes using the normative error envelope.
- [ ] Run all Python tests and compile imports.
- [ ] Commit as `feat: add manifest and phase resolution`.

### Task 2: Durable learner state and exactly-once consent proposals

**Files:**
- Create: `src/courseweave/store.py`
- Create: `tests/test_store.py`
- Create: `tests/test_concurrency.py`
- Modify: `src/courseweave/api.py`

**Produces:** SQLite learner state, idempotency ledger, proposal lifecycle, one-file UTF-8 replacement journal, and recovery.

- [ ] Write tests for state revisions; every direct operation; profile-proposal-only enforcement; create/edit/accept/reject/failed/superseded transitions; same-key replay; different-payload key conflict; stale proposal revision; stale target hash; glob policy; binary/LFS/symlink/large-file refusal; and byte-identical rejection.
- [ ] Write multi-process tests for double Accept, Accept-versus-Edit, manifest save races, and external target modification.
- [ ] Write crash-injection tests before intent, after intent, after replacement, and before finalization; restart must finalize exactly once or mark failed without reapplying.
- [ ] Run focused tests and record RED failures.
- [ ] Implement SQLite migrations, `BEGIN IMMEDIATE` transactions, canonical SHA-256, idempotency, audit ordering, atomic fsync/replace, intent journal, and startup recovery.
- [ ] Add authenticated state/proposal REST routes with ETag/revision/idempotency checks.
- [ ] Run all Python tests.
- [ ] Commit as `feat: add consented durable state`.

### Task 3: Provider-neutral professor and AG-UI boundary

**Files:**
- Create: `src/courseweave/providers.py`
- Create: `src/courseweave/professor.py`
- Create: `tests/test_providers.py`
- Create: `tests/test_professor.py`
- Create: `tests/test_agui.py`
- Modify: `src/courseweave/api.py`
- Modify: `src/courseweave/cli.py`

**Produces:** explicit OpenAI Chat-Completions and Anthropic Messages adapters, redacted doctor state, deterministic phase gates, learner/author professors, transient sharing, and AG-UI endpoints.

- [ ] Globally disable real model requests in tests.
- [ ] Write provider tests using local stub HTTP servers for OpenAI Chat Completions and Anthropic Messages, including streaming, auth failure, timeout, malformed response, custom base URL, missing configuration, and secret redaction.
- [ ] Write table-driven policy tests for every phase, predict-first lock before/after prediction, audit observer lock, lab learner ownership, Author curriculum role, and capability denial independent of model output.
- [ ] Write AG-UI tests for trusted server dependencies, forged client history/tools/state, transient Share size/lifetime, SSE event order, pre-stream JSON error, in-stream `RUN_ERROR`, disconnect, and missing provider.
- [ ] Run focused tests and record RED failures.
- [ ] Implement lazy `OpenAIChatModel`/`OpenAIProvider` and Anthropic client/provider construction.
- [ ] Implement deterministic policy assembly, fixed gates, Pydantic AI professor construction, inert proposal creation, and AG-UI dispatch.
- [ ] Add `/api/share`, `/api/guide`, `/api/author/guide`, and redacted `doctor`.
- [ ] Run all Python tests and live stub canaries.
- [ ] Commit as `feat: add phase-aware professor`.

### Task 4: Shared design system and Learner Studio

**Files:**
- Create: `frontend/tsconfig.base.json`
- Create: `frontend/vitest.config.ts`
- Create: `frontend/packages/ui/**`
- Create: `frontend/apps/learn/**`
- Modify: `frontend/package.json`
- Modify: `src/courseweave/static/learn/**` through the build

**Produces:** persistent guide rail, adaptive phase cards, course dashboard, sandboxed lesson/video reader, explicit sharing, and proposal UI.

- [ ] Write component tests for phase header, no-document, empty-course, missing-provider, interrupted stream, prediction lock, audit lock, hint ladder, Share disclosure, proposal Accept/Edit/Reject, stale conflict recovery, keyboard labels, narrow rail, and reduced motion.
- [ ] Write browser tests for dashboard plus sandboxed HTML and HTTPS video readers.
- [ ] Run tests and record RED failures.
- [ ] Implement shared tokens/components and the Learner Studio header, adaptive phase card, one session-only teacher thread, proposal drawer, composer, dashboard, HTML/video reader, and reconnect UI.
- [ ] Implement the exact authenticated REST/AG-UI clients and validated postMessage contract; never place the capability token in URLs or logs.
- [ ] Run typecheck, component tests, browser tests, and production build.
- [ ] Commit as `feat: add adaptive Learner Studio`.

### Task 5: CourseWeave Author twin application

**Files:**
- Create: `frontend/apps/author/**`
- Modify: `frontend/packages/ui/**`
- Modify: `frontend/package.json`
- Modify: `src/courseweave/static/author/**` through the build
- Create: `tests/test_author_api.py`

**Produces:** separately runnable course CRUD, validation, preview, import/export, conflict recovery, and curriculum professor.

- [ ] Write API/component tests for a missing manifest, empty course, create, deep duplicate with fresh IDs, edit, delete, reorder, entry-module repair, incomplete unsaved draft, exact import/export, validation errors, stale save retaining draft, preview, no-provider operation, rejected teacher proposal byte identity, and accepted edited proposal once.
- [ ] Run focused tests and record RED failures.
- [ ] Implement outline, inspector, learner-card preview, deterministic import/export, save conflict handling, and curriculum professor panel using shared UI and the same backend paths.
- [ ] Run the complete Author suite against both `minimal-course` and structurally different `cli-course`.
- [ ] Run frontend typecheck/tests/build and all Python tests.
- [ ] Commit as `feat: add CourseWeave Author`.

### Task 6: Complete JupyterLab surface bridge and runtime

**Files:**
- Modify: `frontend/packages/lab/**`
- Modify: `src/courseweave/cli.py`
- Create: `tests/test_cli.py`
- Modify: `tests/test_packaging.py`
- Create: `frontend/packages/lab/test/**`

**Produces:** persistent right rail, dashboard/reader widgets, native Markdown/notebook/source/terminal opening, active widget/cell metadata, explicit sharing, authenticated runtime discovery, and graceful launch.

- [ ] Write TypeScript tests for active notebook/cell/tags, file editor, rendered Markdown, terminal surface IDs, MIME/reader widgets, source ID/sequence, deduplication, origin/source/schema rejection, command allowlist, capability-token handling, backend failure, and reconnect.
- [ ] Write CLI tests for single-course lock, atomic loopback bind, readiness, stale runtime file, paths with spaces, installed/sibling use, Jupyter startup failure, browser-open failure, and graceful SIGINT/SIGTERM ownership.
- [ ] Run focused tests and record RED failures.
- [ ] Implement the native surface factory matrix, sandboxed reader, guide iframe, CourseWeave commands, context trackers, explicit Share actions, and dynamic runtime settings.
- [ ] Implement process supervision without generic shell execution.
- [ ] Build wheel, install into a clean Python 3.11/JupyterLab 4.6.3 environment with no Node executable, and run browser smoke tests against the installed wheel.
- [ ] Run all platform tests and frozen builds.
- [ ] Commit as `feat: complete JupyterLab course workspace`.

### Task 7: Agent Harness Path adapter and installed end-to-end proof

**Files:**
- Create: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/courseweave.json`
- Create: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/scripts/courseweave`
- Modify: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/.gitignore`
- Modify: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/README.md`
- Create: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/tests/test_courseweave_manifest.py`
- Create: `frontend/e2e/agent-harness-path.spec.ts`
- Create: `docs/verification/v0.md`
- Modify: `README.md`

**Produces:** complete S01–S14 mapping, recommended optional launch, and release receipts proving the platform against a real course.

- [ ] Snapshot protected-checkout HEAD, status, and hashes of all modified/untracked paths.
- [ ] Write adapter tests for one complete S01 slice using actual notebook cell IDs; public video URL; lesson HTML; lab Markdown; learner Python; display-only terminal command; S01–S12 predict ownership; S13 observer-only; S14 ship; and all referenced paths.
- [ ] Run adapter tests and record RED before the manifest exists.
- [ ] Implement S01, validate and browser-test it, then expand S02–S12, S13, and S14 without modifying notebook cells or outputs.
- [ ] Add the launcher and optional recommended README path while preserving the original `uv run jupyter lab` route.
- [ ] Run installed-wheel Playwright flows across lesson/video, notebook, rendered lab Markdown, Python source, terminal, prediction, reject/no mutation, edited accept/exactly once, Author CRUD, provider absent, fake-provider chat, backend interruption, and state reload.
- [ ] Run all 12 notebooks, idempotent lesson build, relative links, SOTA URLs, lab contracts, and `labs/run.py --all --replay` in the adaptive fork.
- [ ] Run every platform test, typecheck, build, frozen install, wheel install, and package-data gate fresh.
- [ ] Verify the protected checkout's HEAD/status/hashes exactly match the snapshot.
- [ ] Record exact commands, counts, versions, lock hashes, repository SHAs, and known network-dependent video behavior in `docs/verification/v0.md`.
- [ ] Commit the adapter as `feat: add adaptive CourseWeave experience` and the platform as `test: verify CourseWeave v0 end to end`.
