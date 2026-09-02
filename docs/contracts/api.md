# CourseWeave v1 API contract

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
- Body is the schema-v1 manifest.
- If Author Studio opens a root without a manifest, it receives a valid unsaved
  empty draft and `ETag: ""`; the file is not created until an explicit save.

`PUT /api/course`

- Headers: `If-Match`, `Idempotency-Key`, `X-CourseWeave-Origin:
  student_requested`
- Body: complete schema-v1 manifest.
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

`GET /api/state` returns `revision`, predictions, reflections, evidence
receipts, explicitly accepted profile fields, phase completion records, and
proposal audit summaries. It does not contain ephemeral navigation or chat
history.

`PATCH /api/state`

```json
{
  "expected_revision": 4,
  "origin": "student_requested",
  "operation": {
    "type": "record_prediction",
    "module_id": "s01",
    "phase_id": "predict",
    "record_id": "prediction-1",
    "text": "The learner's own prediction"
  }
}
```

Required header: `Idempotency-Key`. Direct operations are limited to
`record_prediction`, `record_reflection`, `record_evidence`,
`complete_phase`, and `set_time_budget`. Profile claims always use proposals.

## Proposals

Proposal types:

- `profile_patch`
- `manifest_replace`
- `workspace_file_replace`
- `phase_record`

Every proposal contains `id`, `revision`, `origin`, `status`, `summary`,
`created_at`, `target`, `payload`, `target_hash`, and `result`.

Workspace proposals:

- target one UTF-8 text file inside the course root;
- target must match one course `workspace_write_globs` entry;
- payload is the complete proposed replacement content plus a unified diff for
  display;
- target SHA-256 is checked while holding the course lock;
- Git LFS pointers, binary files, symlinks, directories, and files larger than
  1 MiB are rejected.

`POST /api/proposals` creates a pending proposal.  
`POST /api/proposals/{id}/edit` supersedes the pending revision and creates the
next pending revision.  
`POST /api/proposals/{id}/accept` applies the exact shown revision.  
`POST /api/proposals/{id}/reject` records rejection and changes no target.

Accept/Edit/Reject require `Idempotency-Key`. A second identical accept returns
the original result. Stale proposal revisions and changed target hashes return
`409` without mutation.

The store uses SQLite `BEGIN IMMEDIATE` for cross-process serialization. A
workspace accept writes a recoverable intent record before atomic file
replacement. Startup recovery compares the recorded before/after hashes:

- after hash present: finalize accepted without applying again;
- before hash present: mark failed and leave the target unchanged;
- any other hash: mark failed with `target_changed`.

## Professor

`POST /api/guide` is an AG-UI endpoint. The server ignores client-supplied
system messages, tools, capabilities, phase state, and proposal status. Trusted
dependencies are rebuilt from the manifest, ephemeral context, and store.

- Before a required prediction, the server returns a deterministic prompt to
  record one and does not call the provider for result-seeking questions.
- In observer audit mode, the server does not call the provider for substantive
  help.
- The only model-side mutation-related tool creates an inert pending proposal.
- Pre-stream failures use the common JSON error envelope.
- Post-stream failures emit an AG-UI `RUN_ERROR`.
- Disconnect marks the run interrupted; it is not silently resumed.

`POST /api/author/guide` uses the same transport and trust rules with a
curriculum-designer system policy. Suggested manifest changes are pending
`manifest_replace` proposals.

