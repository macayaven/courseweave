# CourseWeave v2 mutation matrix

| Target | Trigger | Preview | Concurrency and authority |
|---|---|---|---|
| Ephemeral navigation | Learner focus/navigation | Metadata only | Source ID and sequence; never durable |
| Learner record | Direct put/clear action | Closed text, evidence, or attestation value | State revision, curriculum digest, idempotency; server binds origin/kind/requirement digest |
| Progress | Pure evaluation | Requirement results and stale/orphan status | Derived from valid records and current ordinary-file presence; no completion setter |
| Formative attempt | Learner selects an authored option | Question and choices; deterministic feedback after attempt | State revision and curriculum digest; bound check/objective revisions; never completion or mastery |
| Adaptation preferences | Explicit learner opt-in/edit/revoke | Enabled flag, explanation detail, practice amount | Closed direct action; no inferred personality/profile fields |
| Time budget | Direct learner edit | Selected minutes or no budget | State revision and idempotency |
| Preference proposal | Learner reviews teacher/user draft | Declared explanation/practice preference changes | Proposal revision; explicit adaptation opt-in required to accept |
| Course manifest | Author saves or accepts a reviewed draft | Validated full JSON and diff | Exact-byte ETag, target hash, root lock, idempotency; v2 only |
| State reset/delete | Explicit learner action | Clears records/imports/attempts/preferences and old proposal/retry snapshots | State revision and a retained reset receipt; no course source changes |
| Legacy state import | Explicit copy-only CLI command | Exact coordinate mappings and unbound/orphan report | Source DB is never opened or changed; imported answers never count until resubmitted |
| Excerpt sharing | Explicit Share | Exact selected excerpt | Server session/role/source/run binding, current effective policy; session only |
| Terminal command | Learner runs/copies authored command | Exact command token array and cwd | Learner-controlled execution; no model execution authority |
| Workspace files | Learner edits in their own tools | Learner-controlled | No active API/professor workspace proposal mutation route |

Display experience, navigation, model interpretation, time spent, and formative
correctness never grant authority or write completion facts. Author curriculum
drafting remains independent of learner gates. The existing low-level workspace
journal is retained for recovery invariants and regression tests, not exposed
as an active learner mutation tool. No raw chat, provider settings, credentials,
or shared excerpts are written to durable state.
