# CourseWeave v2 API contract

All `/api/*` requests require:

```http
Authorization: Bearer <per-launch-capability-token>
```

The service binds only to loopback. It does not enable wildcard CORS. JSON
request bodies are limited to 1 MiB; explicitly shared text is also limited by
`policies.max_shared_chars`.

## Common errors

```json
{
  "code": "stable_machine_code",
  "message": "Human-readable summary without credentials or shared content.",
  "details": {}
}
```

Expected codes include `not_found`, `validation_error`, `etag_mismatch`,
`revision_mismatch`, `idempotency_conflict`, `proposal_conflict`,
`target_changed`, `not_configured`, `provider_error`, `forbidden`,
`stale_context`, and `context_conflict`.

## Manifest

`GET /api/course`

- `200`
- `ETag: "<sha256-of-exact-manifest-bytes>"`
- Body is the schema-v2 manifest.
- If Author Studio opens a root without a manifest, it receives a valid unsaved
  empty draft and `ETag: ""`; the file is not created until an explicit save.

`PUT /api/course`

- Headers: `If-Match`, `Idempotency-Key`, `X-CourseWeave-Origin:
  student_requested`
- Body: complete schema-v2 manifest.
- `200` returns the saved manifest and new ETag.
- Reusing an idempotency key with byte-equivalent content returns the original
  response; using it with different content returns `409`.
- Invalid or stale writes leave the previous manifest byte-identical.

Author create, edit, duplicate, delete, and reorder operations are local draft
operations. One complete `PUT` persists the validated draft.

## Context

`POST /api/context`

```json
{
  "source_id": "jupyter-window-uuid",
  "sequence": 12,
  "active_path": "notebooks/example.ipynb",
  "active_cell_id": "cell-uuid",
  "active_cell_tags": [],
  "surface_kind": "notebook",
  "explicit_module_id": null,
  "explicit_phase_id": null,
  "video_seconds": null,
  "terminal_surface_id": null
}
```

Automatic context never contains selection text, file contents, cell contents,
outputs, terminal output, credentials, or environment values.

Ordering is per `source_id`.

- Higher sequence replaces the ephemeral context.
- Equal sequence and byte-equivalent payload is idempotent.
- Equal sequence and different payload returns `409 context_conflict`.
- Lower sequence returns `409 stale_context`.
- A new source ID may start at zero.

`POST /api/share`

```json
{
  "run_id": "chat-run-uuid",
  "kind": "selection",
  "label": "Optional non-secret label",
  "content": "Explicitly shared text"
}
```

`kind` is `selection`, `cell`, `output`, or `text`. Shared content is attached
to one chat run, is never written to learner state or audit logs, and is
discarded when the run finishes or is cancelled.

## Learner state

`GET /api/state` returns the separately versioned durable state (schema 2),
`revision`, bound `course_id`/`root_fingerprint`, `records`, reviewable legacy
`imports`, structured formative `attempts`, explicit adaptation `preferences`,
`time_budget_minutes`, and proposal audit summaries. Raw chat, navigation,
shared excerpts, provider settings, and credentials are never durable fields.

Responses add the current `curriculum_digest`, derived `progress`,
`teacher_availability` keyed by `module_id/phase_id`, and `attempt_statuses`
(index plus coordinates and valid/stale/orphan status). Bootstrap at
`GET /api/bootstrap` adds the canonical `manifest` from the same locked read.
Progress reports required totals, all phase/requirement results, and record
valid/stale/orphan/invalid statuses. Artifacts are inspected on each request;
removing a file makes its requirement incomplete. No result asserts mastery.

`PATCH /api/state` requires `Idempotency-Key` and this closed request body.
The canonical generated request schema is `state-request.schema.json`, also
packaged with the Python runtime for frontend type generation:

```json
{
  "expected_revision": 4,
  "origin": "student_requested",
  "operation": {
    "type": "put_record",
    "coordinate": {"module_id": "s01", "phase_id": "predict", "requirement_id": "prediction-1"},
    "curriculum_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "value": {"text": "The learner's own prediction"}
  }
}
```

Use the digest returned by bootstrap/state, not the illustrative zero digest.
The operation has no client kind/origin/requirement-digest authority. The server
checks the manifest coordinate and closed value under the course lock, then
assigns `kind`, `origin: direct_learner`, and `requirement_digest`. A coordinate
has one current record. Other closed values are `{attested: boolean}` and
`{references: [{label, path} | {label, url}], note?: string}`. False attestation
is a valid submission that does not satisfy its requirement.

Other operation shapes:

- `clear_record`: coordinate + curriculum_digest, no value. Only a declared
  learner-record requirement can be cleared; reset/delete removes orphan data.
- `set_time_budget`: `minutes` (integer 1–1440, or null).
- `set_preferences`: `preferences: {enabled: boolean, explanation?: concise | balanced | detailed, practice?: standard | extra}`.
  Adaptation defaults off; disabling it revokes use of persistent evidence.
- `check_attempt`: module_id, phase_id, check_id, option_id, curriculum_digest.
  Only authored options are accepted. Stored deterministic correctness and
  feedback bind both the full check and referenced objective revision. These
  attempts do not satisfy completion requirements.
- `reset_state` or `delete_state`: no further fields. Clears learner records,
  imports, attempts, preferences, proposal/audit content and old idempotency
  snapshots. A new revision and the reset's retry receipt remain.

All state requests require a nonnegative integer expected revision. Exact
retries are recognized before stale revision/curriculum checks, and return the
original committed state revision; dynamic progress/availability are recomputed
against the current manifest. A later GET obtains the latest complete state.
Reusing a key for another request conflicts. Reset/delete deliberately purge
old receipts to remove their learner payloads; only the reset receipt survives.

`GET /api/state/export` exports durable data only. Course and requirement IDs
are preserved; stale/orphan submissions and unbound imports remain inspectable.

Personal state defaults to `~/Library/Application Support/CourseWeave` on
macOS, `$XDG_DATA_HOME/courseweave` (or `~/.local/share/courseweave`) on Linux,
and `%LOCALAPPDATA%/CourseWeave` on Windows. The suffix is
`courses/<course-id>/<sha256-of-canonical-course-root>/courseweave.db`.
`COURSEWEAVE_STATE_HOME` overrides the personal base; explicit `--state-dir`
(or Python `state_dir=`) chooses a complete external directory. State inside
course source is rejected. In-course `.courseweave/courseweave.db` is never
implicitly read or upgraded.

An unsaved empty Author session may choose its first course ID on Save: the
API rebinds only an empty revision-zero draft with no durable proposals. Saved
course identities never silently reuse another course's learner state.

CLI paths:

```text
courseweave migrate --source courseweave.json
courseweave migrate --source courseweave.json --apply --output courseweave.v2.json
courseweave state inspect --course-root COURSE [--state-dir EXTERNAL]
courseweave state export --course-root COURSE --output NEW.json
courseweave state reset --course-root COURSE
courseweave state delete --course-root COURSE
courseweave state import-legacy --course-root COURSE --source OLD.db --mappings mapping.json
```

Migration preview includes canonical target data, semantic mappings, and issues;
apply always writes a separate new file and never overwrites an existing file.
Normal v1 load/save/launch errors point to this command. Legacy import copies a
stable SQLite DB/WAL snapshot and opens only the copy. Mapping keys are exactly
`predictions:module/phase/record`, `reflections:...`, `evidence:...`, or
`completed_phases:...`; values are v2 coordinate objects. Mapped records are
`unbound`, unmapped records are `orphan`, and neither counts. Explicit learner
resubmission is required even when IDs and record kinds match. Import retains
only the old durable record collections, not profile guesses, chat, settings,
proposal payloads, or credentials.

## Proposals

The active API accepts inert `manifest_replace` and `profile_patch` drafts.
Profile patches contain only declared `explanation`/`practice` preferences and
require visible adaptation opt-in before acceptance. Author manifest proposals
remain independent of learner phase gates and use exact target hashes/CAS.
Workspace proposals and model-authored phase records have no active creation or
acceptance route. The low-level journal remains solely for existing recovery
invariants and focused recovery tests.

`POST /api/proposals` creates a pending proposal. Teacher candidates must be
issued by a successful authenticated guide run, bound to its session/role/
source/context, and rechecked against current server policy before persistence.
`POST /api/proposals/{id}/edit` creates a superseding revision.
`POST /api/proposals/{id}/accept` applies the shown revision; `/reject` records
rejection. All mutations require `Idempotency-Key`; decisions require the
expected proposal revision. Retries return the original result, stale revisions
or changed targets conflict without mutation.

SQLite `BEGIN IMMEDIATE`, a root-specific external lock, exact-byte ETags,
atomic replacement, and the prior recoverable workspace journal are preserved.

## Professor

## Author validation

`POST /api/author/validate` is authenticated with the launch capability token
and is a read-only Author boundary. Its JSON object body is exactly
`{"manifest": <object>, "mode": "structural" | "runnable"}` and is limited to
1 MiB. `structural` validates schema, model invariants, and jailed local paths;
`runnable` additionally checks ordinary local surface files, terminal working
directories, and local-video LFS pointers. It never fetches remote URLs.

On success it returns the normalized schema-v2 `manifest` and canonical UTF-8
`formatted_json`. On failure it returns the normal `validation_error` envelope
with `details.issues`, each containing a stable JSON Pointer `path`, a stable
`code` (including `contract_invalid`, `path_symlink_rejected`, `source_missing`,
`source_type_invalid`, `lfs_pointer`, or notebook selector diagnostics), and a redacted
message. Malformed request objects, modes, and bodies use the ordinary top-level
`validation_error` envelope. It never writes the manifest, store, proposal
database, or filesystem.

`POST /api/guide` is an AG-UI endpoint. The server ignores client-supplied
system messages, tools, capabilities, phase state, and proposal status. Trusted
dependencies are rebuilt from the manifest, ephemeral context, and store.

- Unmet explicit learner-record gates, disabled access, and observer-only
  access block every provider call, including greetings. Display experience
  never grants authority.
- Share admission and guide candidate persistence use current server-bound
  records; unbound, stale and orphan records cannot open gates.
- The only model-side mutation-related tool creates an inert pending proposal.
- Pre-stream failures use the common JSON error envelope.
- Post-stream failures emit an AG-UI `RUN_ERROR`.
- Disconnect marks the run interrupted; it is not silently resumed.

`POST /api/author/guide` uses the same transport and trust rules with a
curriculum-designer system policy. Suggested manifest changes are pending
`manifest_replace` proposals.

## HTML section targets

Only HTML surfaces may optionally include `fragment`, a 1–160 character anchor
identifier matching `[A-Za-z][A-Za-z0-9_.:-]*` exactly. Supply no `#`, path,
query, percent encoding, whitespace, or controls. The surface `path` remains
the sole filesystem source; the fragment is presentation metadata and never
changes progress or teacher authority. Frontends append it as the section
target when opening the authored HTML.

## Author Edition v0.3.0 contract foundation

The approved [three-spec bundle](../specs/README.md) adds author-only Python
contracts in `courseweave.author.contracts`. They are separate from schema-v2
student manifests and from this API's existing runtime authority. Draft reply
types cannot carry target paths/revisions, human dispositions or deterministic
compatibility flags. Implemented compatibility, project and content routes are
described below. Source research, model review and delivery remain subsequent
implementation tasks.
See [implementation status](../author/implementation.md) for verified scope.

`POST /api/author/compatibility` accepts `{ "manifest": ...,
"student_version": "0.2.0" }` (the version defaults to `0.2.0`; candidate
`0.3.0` is also supported). The read-only report contains the named profile,
manifest digest, structural/asset/link/profile issues, unperformed checks and
a server-derived `passed` flag. Draft reports have no stable inventory hash.
A passing preliminary report does not certify a course export or installed
execution. Unknown request fields, oversized bodies and unsupported profiles
are rejected. No code execution, source fetch or state write occurs.


## Author private projects (v0.3.0 candidate)

A launch with `author --home` enables the authenticated project hub:

- `GET /api/author/projects`: list completed projects and unavailable/incomplete IDs.
- `POST /api/author/projects/inventory`: inspect an explicit `source_root`, returning bounded ordinary files, omissions and a root/content digest.
- `POST /api/author/projects`: create a new `project_id` with `selected_paths`; imports additionally require `source_root` and the reviewed `expected_inventory`. Existing destinations are rejected.
- `GET /api/author/sources`: read the selected project's source decisions.
- `PUT /api/author/sources/{source_id}`: save a human decision with its reviewed `revision`, title, optional publication date, review status, intended use, redistribution and review note. Extra authority fields are rejected; stale decisions return a conflict.

The browser sends `X-CourseWeave-Project: <project_id>` on project requests.
Authentication runs before project resolution. Each selected project uses the
existing application, manifest validator, store and context registry with its
own immutable root; selecting another project cannot retarget old tabs. Hub
routes remain global to that Author home. Other unselected mutations fail closed.
Ordinary Student or single-course launches report `{"enabled": false}` for the
hub and reject private project creation/source curation. Project requests and
source decisions accept at most 1 MiB of JSON. No model chooses a local root,
approves a source, sets redistribution or obtains filesystem write authority.

## Reviewed author content (v0.3.0 candidate)

These routes require an authenticated private Author project. Ordinary Student
and legacy single-course launches cannot use them.

- `GET /api/author/content/files`: bounded course-file inventory.
- `GET /api/author/content?path=...`: a selected Markdown/notebook/asset snapshot,
  its exact SHA-256, existence, project revision and manifest hash. Initial
  manifest Save is required before lesson editing.
- `POST /api/author/changes`: stage a direct human edit. The closed request has
  `path`, `before_sha256`, `before_exists`, `project_revision`, `manifest_sha256`
  and a discriminated `action`. Supported actions are `markdown_replace` (`text`),
  `notebook_cells` (`replace_sources` keyed by existing IDs), `notebook_scaffold`
  (`title`), `notebook_add_cell` (`cell_type`, `source`), or `import_replace`
  (`source_path`, an explicit absolute local file). Returns a saved pending
  change without writing the course file.
- `GET /api/author/changes?offset=0`: up to 20 change summaries plus `total`;
  candidate bytes are not loaded for the list.
- `GET /api/author/changes/{change_id}`: the saved status/revision, before/after
  hashes, exact diff, and editable Markdown/notebook candidate when applicable.
- `POST /api/author/changes/{change_id}/apply`: accepts `reviewed_revision`,
  `context_digest` and `operation_id`. A successful retry with the same operation
  returns the immutable original receipt. A changed request under that ID, stale
  target/context/revision, rejected candidate or failed prior operation conflicts.
- `POST /api/author/changes/{change_id}/reject`: accepts `reviewed_revision`;
  records rejection without a course-file write.

Only the service constructs assistant targets from AuthorContext and validates
closed ChangeDraft data. The manual route is a direct authenticated author action,
not a tool granted to a model. Manifest fragment candidates use the existing
canonical manifest composition/validation/save path.

Candidate snapshots/backups are at most 8 MiB per file, individual draft texts
at most 64,000 characters, and request JSON at most 1 MiB. Notebook validation
does not execute cells. Imported replacements remain separate candidate sources
with undecided redistribution. Private paths, symlinks and special files are
rejected. A file's absence is part of its reviewed identity.

The existing course lock protects the adjacent prepare/apply journal. Restart
reconciles prepared operations by exact target hashes without overwriting a
conflict. Reported failed operations do not become successful receipts on retry.
Draft structural validity does not imply runnable assets or export readiness.

## Private Author conversation (v0.3.0 candidate)

- `POST /api/author/assistant/context`: closed `thread_id`, `selection`, `role`
  and `source_ids`. The server resolves saved bytes and current approved source
  revisions. Returns `context_id`, the bounded context and omissions, and whether
  earlier conversation remains permitted for replay. This endpoint is local;
  it makes no provider or search call.
- `POST /api/author/guide`: the existing AG-UI POST stream. In a private project,
  `forwardedProps` contains only `context_id` and `action` (`chat`, `draft`, or
  `review`). Client history/tools remain inert. A current server preview in the
  same session/project/thread is required. The accepted turn-context event adds
  role, selection, permitted source count, context identity/digest and omissions.
- A successful complete draft/review may emit `courseweave.author_reply` after
  text completion, with `draft_id`, `context_digest` and a validated closed reply.
  It is an ephemeral candidate, not an applied or saved change. RUN_ERROR,
  cancellation, missing terminal events and mismatched contexts grant no save
  authority. The shared parser accepts Author metadata only for the expected
  Author context.
- `POST /api/author/assistant/drafts/{draft_id}/save`: empty closed object.
  Saves that session's current validated content draft once and returns the
  ordinary pending change. Repeat saves return the same change ID. The exact diff
  and explicit reviewed apply endpoints above own all course-file changes.

Course metadata fragments exclude `modules`; the service preserves all modules
while composing that selected unit. Module/activity fragments retain their
selected identity. Reply findings remain model judgments; neither their prose
nor their citations can set human dispositions or compatibility status.
Conversation, previews and unsaved drafts follow existing session lifetime and
bounded history cleanup. Up to 128 unsaved reply drafts are retained per project
process. Saved changes retain their independent durable lifecycle.

## Private Author review reports and coverage (v0.3.0 candidate)

These authenticated, project-selected routes require a private Author project;
ordinary Student launches return 403. The report is distinct from a pending
content change and from session-only conversation.

- `POST /api/author/assistant/drafts/{draft_id}/save-review`: empty closed object.
  Saves a complete validated reply using its still-current server context. Human
  dispositions start `unreviewed`; this does not save or apply a content change.
  Repeated saves in the same session return the existing report. A deleted report
  is not recreated by replaying that save.
- `GET /api/author/reviews?offset=0`: at most twenty summaries and `next_offset`.
  `GET /api/author/reviews/{report_id}` returns one closed `ReviewReport` with
  current derived staleness and provenance checks, original model judgments,
  human decisions, scope/budget/omissions and supplied canonical diagnostics.
- `PUT /api/author/reviews/{report_id}/findings/{claim_id}`: closed `revision`,
  `human_disposition`, `reason` and `objective_ids`. Dismissed/revised decisions
  require a nonblank reason. Objective IDs must belong to the report's explicitly
  selected activity. Stale accepted/revised decisions and revision conflicts fail;
  model judgment and evidence are immutable through this route.
- `DELETE /api/author/reviews/{report_id}`: closed `reviewed_revision`, returns 204.
- `GET /api/author/reviews/{report_id}/export?revision=0`: revision-checked JSON
  attachment with `Cache-Control: no-store`. The application requests a private
  download only on the explicit user action. Local source origins use filenames.
- `GET /api/author/coverage?offset=0`: at most twenty canonical activity rows with
  authored objectives/practice, declared sources, explicit reviewed support and
  gaps, plus report IDs not associated with a current activity. No progress state
  is read or changed, and model claim IDs are not inferred as objective links.

Reports are bounded to 200 per project and 512 KiB each. All mutations use the
existing course lock and atomic private writes. Dependency changes mark reports
stale without rewriting judgments or decisions. Located quotation provenance is
independent of model entailment and human acceptance. See [review workflow and
limits](../author/reviews.md).

## Private Author sources and research (v0.3.0 candidate)

All routes below require an authenticated private project. Ordinary Student
launches cannot use them. Model tools cannot call these mutation routes.

- `POST /api/author/sources/import`: closed `{ "path": "/local/reference.md" }`.
  Snapshots one nonsynced ordinary file, up to 8 MiB, as a private reference.
  It does not copy into the working course, approve the source or execute code.
- `GET /api/author/sources/{source_id}/text?revision=0&start=0&limit=8000`:
  verifies the source revision and both snapshot hashes, then returns a bounded
  text excerpt with start/end offsets, total characters, metadata and omissions.
- `GET /api/author/research`: local configuration and active-run state, explicit
  network-off default, fixed limits and author account responsibility. No key
  values, search or fetch calls are returned or performed.
- `POST /api/author/research`: a closed `ResearchRequest` requires
  `network_enabled: true`, `policy`, up to two `queries` and up to five `urls`.
  At least one query or URL is required. Policy is `allow_only` with at least one
  allowed rule, or `public_web`, plus optional deny rules. Each rule has an exact
  HTTPS `origin` and optional absolute `path_prefix`. Deny takes precedence.
  The browser presents separate discovery/fetch actions to avoid reissuing a
  query when the author chooses a result. No discovered result is auto-fetched.
- The research POST returns the actual saved `ResearchReport` with its ID, UTC
  start/finish times, original request, at most ten discovery results, at most
  five fetch outcomes, source revision references and notices. Result policy
  decisions and retrieval/publication dates are separate. Raw bodies are absent;
  supported or unsupported retrieved source bytes stay in private snapshots.
  A rejected, unavailable or cancelled result is never replaced with a summary.
- `POST /api/author/research/cancel`: empty closed object. Cancels the active run
  for this project; another project's run cannot be cancelled through its header.
  HTTP 202 means cancellation requested, not completed. Read the terminal report
  for the observed outcome. Browser disconnection also signals cancellation.
- `GET /api/author/research/reports?offset=0`: up to twenty saved summaries and
  `next_offset`; `GET /api/author/research/reports/{report_id}` reads one report.
  Unknown-response recovery uses this read path, never an automatic retry.

One active run is allowed per Author home. Network work is bounded to sixty
seconds per run, ten seconds/three redirects/two MiB decompressed content per
fetch. Research checks cancellation/deadline while waiting for the shared course
lock. Immutable terminal reports require only atomic publication and cannot be
held behind an unrelated course edit. Up to 500 reports and 10,000 current source
identities are supported per project; reaching a limit never prunes old evidence.

Brave uses only `BRAVE_SEARCH_API_KEY`, supplied to the Author backend. The
fetcher never uses browser cookies, student credentials or model keys. Invalid
URLs and denied origins cause no source transport calls; redirects repeat policy
and destination checks. See [Author research setup and limits](../author/research.md).
