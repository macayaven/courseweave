# CourseWeave Platform Design

**Status:** implementation specification  
**Date:** 2026-09-01  
**Repositories:**

- Platform: `/Volumes/mac-studio-ssd/education/courseweave`
- First course adapter: `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor`
- Protected source checkout: `/Volumes/mac-studio-ssd/education/agentic-harnessing-companion`

## 1. Purpose

CourseWeave is a reusable local learning environment for technical courses whose
work moves between explanation, video, notebooks, labs, source files, commands,
and evidence. It keeps the learner inside one JupyterLab workspace and presents
one continuous teacher in a persistent guide rail. The teacher changes posture
with the course phase; the learner does not change applications to accommodate
the teacher.

The platform also includes **CourseWeave Author**, a separately runnable twin
application for creating and maintaining course manifests. It uses the same
schema and server as the learner application and adds a curriculum-design
teacher posture.

This release is a complete local-first vertical product, not a hosted
multi-tenant service. Authentication, billing, remote execution, and cohort
administration are outside v0.

The normative machine and protocol contracts are:

- `docs/contracts/courseweave.schema.json`
- `docs/contracts/api.md`
- `docs/contracts/mutation-matrix.md`
- `docs/adr/0001-trust-and-mutation.md`

If prose here conflicts with those contracts, the contracts win.

## 2. Product invariants

1. **One learner application.** Lesson reading, video, notebook work, lab
   protocols, source editing, commands, and teacher interaction happen within
   JupyterLab.
2. **One continuous teacher.** A fixed guide rail retains the conversation and
   learner-selected model while its phase card and allowed actions adapt to the
   active course surface.
3. **Deterministic phase ownership.** The manifest and ephemeral workspace metadata
   determine the phase. The model may explain the phase but may not silently
   change it.
4. **Automatic context, consented mutation.** Reading active metadata is automatic.
   Durable learner, course, notebook, or workspace state changes occur only
   after a direct learner request or acceptance of a teacher proposal.
5. **No silent profiling.** The teacher may adapt within a conversation, but a
   claim about strengths, weaknesses, goals, preferences, or availability is not
   persisted unless the learner requests or accepts it.
6. **Course remains usable without AI.** Missing credentials, provider failure,
   or an unavailable model disables teacher chat, not the course reader,
   notebooks, labs, progress display, or authoring CRUD.
7. **Credentials never enter course files.** API keys are read from environment
   variables or provided to the running process. They are not written to the
   manifest, progress store, logs, chat files, or generated documentation.
8. **Course content stays canonical.** CourseWeave adds an interface and learner
   state. It does not rewrite source lessons or notebook content by default.
9. **Local-first and provider-neutral.** v0 supports OpenAI-compatible and
   Anthropic-compatible chat endpoints through Pydantic AI model adapters.
10. **Small replaceable seams.** Course schema, context resolver, persistence,
    agent adapter, web UI, and JupyterLab bridge have explicit interfaces and can
    be replaced independently.

## 3. Architecture

```text
technical course repository
├── courseweave.json                 course manifest
├── lessons / videos / notebooks / labs / source
└── .courseweave/                    gitignored learner state
           │
           ▼
CourseWeave Python service
├── manifest + path validation
├── deterministic context/phase resolver
├── versioned learner/proposal store
├── provider/model factory
├── Pydantic AI professor + AG-UI endpoint
└── REST authoring API + static application host
           │
           ├─────────────────────────────┐
           ▼                             ▼
CourseWeave Learn                  CourseWeave Author
React guide rail + reader          React CRUD + preview
           │
           ▼
thin JupyterLab prebuilt extension
active-document bridge, guide iframe,
course dashboard command
```

### 3.1 Why this boundary

- JupyterLab already supplies notebooks, text editing, terminals, file browsing,
  kernels, document tabs, and workspace layouts.
- Pydantic AI supplies typed model adapters, tool/result contracts, and AG-UI
  streaming without requiring a general autonomous-agent framework.
- AG-UI is the sole event protocol between teacher and clients.
- CourseWeave owns only course-specific behavior: phase resolution, teaching
  policy, learner consent, and the cohesive course surfaces.
- Learner and author clients share UI primitives and API types, while remaining
  independently runnable entry points.

## 4. Repository layout

```text
courseweave/
├── pyproject.toml
├── src/courseweave/
│   ├── models.py          manifest, context, progress, proposal models
│   ├── manifest.py        load, validate, save, and path jail
│   ├── context.py         active-surface to deterministic phase resolution
│   ├── store.py           SQLite state, proposals, idempotency, and recovery
│   ├── providers.py       environment-only provider/model configuration
│   ├── professor.py       phase policy, prompts, Pydantic AI agent
│   ├── api.py             FastAPI and AG-UI routes
│   ├── cli.py             `courseweave launch`, `serve`, `author`, `doctor`
│   └── static/            built learner and author assets
├── frontend/
│   ├── packages/ui/       shared tokens and components
│   ├── apps/learn/        learner guide rail and course reader
│   ├── apps/author/       course CRUD and curriculum teacher
│   └── packages/lab/      minimal JupyterLab iframe/context bridge
├── tests/
└── examples/minimal-course/
```

The first course adapter contains only `courseweave.json`, a launcher, ignored
learner-state paths, and documentation. Platform code is not copied into the
course.

## 5. Course manifest contract

`courseweave.json` is UTF-8 JSON with `schema_version: 1` and validates against
`docs/contracts/courseweave.schema.json`.

### 5.1 Course

Required:

- `id`: non-empty slug, unique within the manifest
- `title`: non-empty display name
- `description`: string, may be empty
- `entry_module_id`: ID of an existing module, or `null` only when modules is
  empty
- `modules`: ordered list
- `policies`: course-wide teaching and mutation policy

### 5.2 Module

Required:

- `id`: non-empty slug, unique across modules
- `title`: non-empty
- `description`: string
- `phases`: ordered, non-empty list

An empty course is valid in Author Studio. A non-empty course must have a valid
`entry_module_id`. Deleting the final module sets `entry_module_id` to `null`.

### 5.3 Phase

Required:

- `id`: non-empty slug, unique inside its module
- `title`
- `kind`: one of `orient`, `read`, `watch`, `predict`, `experiment`, `lab`,
  `review`, `audit`, `ship`
- `teacher_mode`: one of `orienter`, `reading_companion`, `socratic_guide`,
  `debugging_coach`, `reviewer`, `observer`, `curriculum_designer`
- `surfaces`: ordered, non-empty list
- `completion`: the discriminated manual, prediction-recorded, receipt-recorded,
  or artifact-exists rule from the schema
- `capabilities`: the explicit chat, hint, sharing, and proposal policy from the
  schema

### 5.4 Surface

Required:

- `id`: unique inside the phase
- `type`: `html`, `markdown`, `video`, `notebook`, `source`, `terminal`, or
  `external`
- `path`: course-root-relative path for local surfaces; absent for terminal and
  external surfaces
- `role`: `primary`, `reference`, `exercise`, or `evidence`

Optional:

- `url` for HTTPS external/video sources
- structured `argv`, `cwd`, and `label` for terminal surfaces; CourseWeave
  displays or copies these but does not execute them in v0
- `match` with notebook cell IDs or tags
- `start_seconds` and `end_seconds` for a video segment

Local paths must resolve inside the course root after symlink resolution.
Absolute paths, `..` escapes, missing required files, duplicate surface IDs,
duplicate module IDs, duplicate phase IDs, and unsupported enum values are
validation errors. Multiple phases may intentionally reference the same path. Cell ID, cell tag,
video segment, and the session's last matching phase disambiguate it before
manifest order is used as the final tie-breaker. A local video that is only a
Git LFS pointer is not playable and fails runnable validation.

## 6. Context and phase resolution

`WorkspaceContext` contains metadata only:

- `source_id`
- `sequence`
- `active_path`
- `active_cell_id`
- `active_cell_tags`
- `video_seconds`
- `explicit_module_id`
- `explicit_phase_id`
- `surface_kind`
- `terminal_surface_id`

Resolution order:

1. A valid explicit module and phase pair.
2. Exact active path plus notebook-cell ID match.
3. Exact active path plus notebook-cell tag match.
4. Exact active path plus video segment match.
5. Exact active path, preferring the session's last phase among matching candidates.
6. Explicit terminal-surface or surface-kind match inside the current module.
7. The session's last ephemeral active phase.
8. The course entry module's first phase.
9. No phase for an empty course.

The resolver is pure and deterministic. Ordering is per `source_id`: a higher
sequence replaces the ephemeral context; an equal equivalent payload is
idempotent; an equal different payload conflicts; and a lower sequence is stale.
A new source may restart at sequence zero. An unknown path produces general course
context and never crashes the guide.

Selection, cell content, output, terminal output, and source excerpts are never
automatic context. The learner may explicitly share one bounded excerpt for one
chat run. Shared content is transient and is never written to learner state,
audit logs, or future conversations.

## 7. Phase behavior

| Phase kind | Teacher posture | Primary UI |
|---|---|---|
| orient | Establish goal, prior experience, and available time without persisting assumptions | Start card and optional learner-profile proposal |
| read | Explain selected text, connect concepts, cite local section | Reading companion actions |
| watch | Clarify current timestamp and connect it to canonical text | Video controls and “ask at timestamp” |
| predict | Withhold the result and solution until a prediction is recorded | Prediction card |
| experiment | Interpret outputs and offer a graduated hint ladder | Notebook context and hints |
| lab | Protect learner ownership; diagnose and review before proposing edits | Protocol checklist, tests, diff proposal |
| review | Ask for restatement, compare evidence to claims | Reflection/evidence card |
| audit | Deterministic observer-only mode; do not call the provider for substantive help | Audit timer and locked-help notice |
| ship | Present named verification, summarize learner-recorded receipts, never inflate claims | Release checklist |

The server enforces capability policy before calling a model. Before a required
prediction, result-seeking questions receive a fixed record-your-prediction
response. In observer audit mode, substantive help receives a fixed observer
response. These are deterministic gates, not prompt requests.

## 8. Learner state and consent

Learner state lives in `.courseweave/courseweave.db` and contains:

- schema version
- monotonically increasing revision
- phase completion records
- predictions
- reflections
- evidence references
- explicitly accepted learner profile
- proposal audit records

Active module/phase and conversation history are session-only ephemeral state.

### 8.1 Mutation sources

- `student_requested`: the student initiated the exact change. Direct semantic
  records use revision and idempotency checks. Destructive workspace changes
  still use the proposal preview/apply path.
- `teacher_suggested`: the teacher generated a proposal. It remains pending until
  the student chooses Accept.

Transient response adaptation is not learner state and is never written.

### 8.2 Proposal lifecycle

States: `pending`, `accepted`, `rejected`, `superseded`, `failed`.

Actions:

- **Accept:** apply exactly the proposal revision shown.
- **Edit:** create a new pending revision and supersede the previous revision.
- **Reject:** record rejection; apply no target mutation.

Rules:

- Proposal IDs and idempotency keys are unique.
- Repeating Accept on an accepted proposal returns the original result and does
  not duplicate the mutation.
- Accepting a stale proposal or stale target hash returns HTTP 409 and changes
  nothing.
- Rejecting or editing a non-pending proposal returns HTTP 409.
- Missing proposal IDs return HTTP 404.
- Invalid/empty payloads return HTTP 422.
- File changes are journaled, atomic, jailed to the course root, and may target
  only one allowed UTF-8 text file.
- Progress changes use optimistic state revision checks. Profile claims always
  use a proposal.
- Audit entries preserve ordering with a monotonic sequence.
- SQLite `BEGIN IMMEDIATE` serializes multiple CourseWeave processes. Startup
  recovery finalizes an already-applied journal entry once or marks it failed
  without applying it again.

## 9. Provider behavior

Supported provider modes:

- `openai`: `OPENAI_MODEL`, optional `OPENAI_BASE_URL`, and
  `OPENAI_API_KEY`
- `anthropic`: `ANTHROPIC_MODEL`, optional `ANTHROPIC_BASE_URL`, and
  `ANTHROPIC_API_KEY`

`COURSEWEAVE_PROVIDER` chooses the mode. The UI may select a model/base URL for
the running session, but it must not persist a credential value.

`doctor` reports only provider, model, base-URL presence, and credential
`SET`/`MISSING`. Missing configuration returns a structured `not_configured`
status. Provider timeout, authentication failure, unsupported tool calling, and
malformed model output become visible chat errors without changing learner or
course state.

Tests use Pydantic AI test models or injected fake gateways; no test requires a
network call or credential.

## 10. HTTP and event API

Public entry points:

- `courseweave.cli:app`
- `courseweave.api:create_app(course_root: Path) -> FastAPI`
- `courseweave.manifest:load_manifest(course_root: Path) -> CourseManifest`
- `courseweave.context:resolve_context(manifest, state, context) -> ResolvedContext`
- `courseweave.store:CourseStore`
- `courseweave.providers:create_model(config)`

REST:

- `GET /api/health`
- `GET /api/course`
- `PUT /api/course` with exact-byte `If-Match` ETag and idempotency key
- `GET /api/context`
- `POST /api/context`
- `POST /api/share` for one explicit, transient excerpt
- `GET /api/state`
- `PATCH /api/state` with expected revision
- `GET /api/proposals`
- `POST /api/proposals`
- `POST /api/proposals/{id}/edit`
- `POST /api/proposals/{id}/accept`
- `POST /api/proposals/{id}/reject`
- `POST /api/guide` using AG-UI
- `POST /api/author/guide` using AG-UI with curriculum-designer instructions

Static:

- `/learn/`
- `/author/`

All errors use `{"code": "...", "message": "...", "details": {...}}`.
Every API route requires the per-launch capability token. Manifest writes use
exact-byte ETags. State and proposal writes use SQLite transactions; file
proposals use an intent journal and hash-based startup recovery. AG-UI carries
conversation only and never becomes a mutation authority.

## 11. Learner UI

The persistent guide rail has:

1. Header: course/module/phase, time budget, provider status.
2. Phase card: phase-specific interaction.
3. Teacher thread: one continuous AG-UI conversation.
4. Proposal drawer: Accept/Edit/Reject and concrete diff or field change.
5. Footer composer.

The course dashboard provides ordered modules and phases and opens their surfaces
inside JupyterLab. The same teacher thread remains mounted while active documents
change.

Empty states exist for:

- empty course
- no active document
- no provider credentials
- provider unavailable
- no pending proposals
- phase complete

Keyboard focus, labels, color contrast, reduced-motion behavior, and narrow
sidebar layouts are required.

## 12. JupyterLab bridge

The prebuilt extension:

- adds a persistent right-side CourseWeave guide iframe;
- adds “Open CourseWeave” and “Open Course Dashboard” commands;
- reports active path, notebook cell ID/tags, surface kind, terminal surface ID,
  source ID, and increasing per-source sequence;
- ignores messages from unexpected iframe origins;
- handles only allowlisted commands from the iframe;
- opens Markdown, notebooks, source, and terminals through native JupyterLab
  factories;
- opens lesson HTML and video in one sandboxed CourseWeave main-area reader;
- never sends selection, notebook outputs, terminal output, or file contents
  automatically;
- supplies explicit Share selection/cell/output actions with a provider disclosure
  and size limit;
- reconnects after backend reload without requiring a JupyterLab restart.

If the CourseWeave service is unavailable, the panel shows recovery guidance and
JupyterLab otherwise works normally.

## 13. Author Studio

CourseWeave Author is a separate build and route with four areas:

1. Course outline: create, delete, duplicate, and reorder modules/phases.
2. Inspector: edit metadata, capabilities, completion rule, surfaces, paths,
   commands, and video ranges.
3. Preview: render the learner phase card and validate referenced artifacts.
4. Curriculum teacher: ask for critique or a proposed change.

CRUD rules:

- create generates a unique slug, but the author may edit it before save;
- duplicate copies content and generates new IDs;
- reordering is stable and persisted exactly;
- deleting a referenced entry module chooses the first remaining module;
- an empty course remains editable;
- validation errors identify the exact field and do not overwrite the prior
  valid manifest;
- import accepts schema version 1 only;
- export is deterministic formatted JSON;
- concurrent stale saves return 409 and retain the unsaved client draft;
- curriculum-teacher changes use the same proposal lifecycle and are never
  applied automatically.

## 14. CLI and setup

Commands:

- `courseweave doctor --course-root PATH`
- `courseweave serve --course-root PATH [--port 8765]`
- `courseweave launch --course-root PATH [--port 8765]`
- `courseweave author --course-root PATH [--port 8765]`
- `courseweave validate --course-root PATH`

`launch` acquires the single-course process lock, atomically binds a loopback
port, starts the CourseWeave service, then starts JupyterLab rooted at the course.
It does not install credentials, modify shell startup files, or change global
Jupyter settings. It communicates the selected URL and random capability token
to the extension through a generated, gitignored runtime settings file.

SIGINT/SIGTERM stops owned child processes gracefully and invalidates runtime
settings. A failed service start prevents JupyterLab launch and prints a concrete
recovery message.

## 15. Agent Harness Path adapter

The adapter must:

- preserve the existing zero-network, zero-key core route;
- add `courseweave.json` mapping all S01–S14 lesson, video, notebook, lab, and
  relevant Python surfaces;
- make S01–S12 predict-first and learner-owned;
- configure S13 audit as observer-only;
- configure S14 as verification/ship;
- add a recommended but optional CourseWeave quickstart;
- add a launcher that locates a sibling checkout or an installed `courseweave`;
- ignore `.courseweave/` and runtime settings;
- make no edits to the original dirty checkout;
- keep existing build, link, notebook, SOTA, and lab-replay gates passing.

## 16. Verification

Platform:

- Frozen install on Python 3.11 and Node 20.19 or newer, with committed Python
  and pnpm lockfiles.
- Python formatting/static import check.
- Unit tests for manifest boundaries, resolver precedence, stale sequence,
  state revisions, proposal transitions, idempotency, jail enforcement, provider
  redaction, and empty course behavior.
- FastAPI integration tests for every public route and error code.
- Frontend typecheck, component tests, and production builds for Learn, Author,
  and Lab bridge.
- Installed-wheel JupyterLab browser end-to-end: open dashboard, exercise HTML,
  remote video, rendered Markdown, notebook, source, and terminal surfaces; change
  active phase; record prediction,
  reject a proposal with no mutation, accept an edited proposal once, CRUD and
  reorder an author course, reload persisted state.

Course fork:

- manifest validates;
- platform resolves at least one phase for every mapped artifact;
- all 12 notebooks execute top to bottom without committed outputs;
- lesson build is idempotent;
- relative links and SOTA URLs pass;
- lab contract tests and `--all --replay` pass;
- original checkout status remains unchanged.

## 17. Explicit non-goals for v0

- Hosted accounts, cohorts, payments, or cloud storage.
- Arbitrary shell autonomy for the teacher.
- Automatic curriculum rewrites.
- Secret persistence.
- A replacement notebook implementation.
- Generic production coding-agent tools.
- Automatic SOTA refresh; the teacher may propose a sourced update, which an
  author must accept.

