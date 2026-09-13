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
