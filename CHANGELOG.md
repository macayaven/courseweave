# Changelog

This file records user-visible CourseWeave changes. Version headings identify
frozen contents; publication dates and status are recorded on the linked GitHub
releases.

## Unreleased

### Author Edition v0.3.0 work in progress

- Added the approved three-spec bundle and executable consistency audit with
  traceability and regression coverage.
- Added closed author-only contract types that separate untrusted drafts from
  server-selected targets, deterministic compatibility, and human decisions.
- Added a preliminary Student compatibility report using the existing validators,
  explicit unchecked scope, and canonical-schema inspector choices.
- Added private Author homes with new/imported projects, bounded file inventory,
  source snapshots and explicit approval, intended-use and redistribution decisions.
  Project requests retain their selected root across tabs. Source changes use the
  shared course lock and reviewed revisions. Import leaves original files intact.
- Added project switching and source review controls, with unsaved-work protection,
  readable selection controls and a collapsed sidebar on Author launch.
- Added reviewed Markdown, named notebook-cell edits, new notebook scaffolds and
  cells, and explicit imported asset replacements. Pending diffs survive restart;
  original imports and student notebooks retain their bytes.
- Added hash/revision-checked one-file apply, immutable replay receipts and crash
  reconciliation under the existing course lock. External edits, source revocation,
  missing-versus-empty files and late write failures have explicit outcomes.
- Added file review controls with keyboard rejection, preserved cell selection,
  editable candidate copies, conflict reload and narrow-window layout checks.
- Added one Author conversation with six roles, explicit approved-source
  permissions, bounded saved-content previews and visible omissions. Role
  changes retain valid conversation; changed content or permissions revoke replay.
- Added text-only JSON drafts and evidence validation on the existing provider
  and AG-UI transport. Complete replies remain session-only until an explicit
  Save draft; exact diff review still owns application. Invalid, interrupted and
  stale replies have no durable effect and make no automatic repair request.
- Added explicit, bounded Author source research with an optional separate Brave
  Search credential, public HTTPS connection pinning, verified TLS, allow/deny
  rules, cancellation and durable discovery/fetch outcomes. Network stays off
  until each reviewed run; discovered URLs require a separate fetch action.
- Added private local-reference import, static HTML/text/Markdown extraction,
  original/extracted hashes and character offsets. Login, blocked, JavaScript-only
  and unsupported content have explicit outcomes. Changed source bytes require
  a new review; source approval never grants redistribution automatically.
- Added paged research reports, source excerpts, offline/manual workflows and
  bounded waiting for the shared course lock during research. Imported material
  is never executed, and the Student assistant gains no network retrieval.
- Added explicitly saved factual/editorial reviews with separate model judgments,
  checked quotation provenance and human dispositions. Review revisions, stale
  source/target detection, dismissal reasons, deletion and private JSON downloads
  preserve author control independently of saved content changes and session chat.
- Added course coverage with explicit author objective links, authored practice,
  references and review gaps. Missing metadata remains guidance, and coverage
  never changes progress or certifies mastery. The compatibility role receives
  bounded canonical diagnostics with their unperformed checks.
- Fixed review-panel loading that repeatedly disabled sibling panels in a real
  Jupyter launch, recognized Author prompt metadata on the shared stream, and
  enabled deliberate artifact downloads in the Author window's sandbox.
- The complete Author Edition and its installed/live-provider acceptance are
  still in development; see [implementation notes](docs/author/implementation.md).

## [0.2.0](https://github.com/macayaven/courseweave/releases/tag/v0.2.0)

The changes below are relative to public v0.1.0. A release marked Pre-release
remains a verification candidate until the public-download gates in the
[release runbook](docs/RELEASING.md) pass and the unchanged assets are promoted.

### Added

- Added the canonical schema-v2 course contract, generated JSON Schema, closed
  record operations, digest-bound progress requirements, and a pure deterministic
  learning engine. Completion derives from authored requirements and saved
  records rather than assistant output or UI labels.
- Added explicit v1 manifest migration. `courseweave migrate` previews conversion
  and `--apply` writes a separate v2 file without overwriting the source. Legacy
  learner-state import requires explicit old-to-new coordinate mappings.
- Added external per-course learner state with revision checks, idempotent actions,
  transactional writes, recovery, inspect/export/reset/delete commands, and
  protection against silently attaching one course's state to another course.
- Added a persistent learner guide across native JupyterLab course surfaces. One
  conversation can continue while the learner moves among declared lesson,
  notebook, video, source, and terminal activities, with each answer attributed
  to the confirmed activity that started it.
- Added explicit lesson-scope and workspace-sharing controls. Selected course
  material stays visibly labeled until replaced or cleared; notebook or source
  content is shared only for the current request and is excluded from later
  replay and durable proposals.
- Added privacy and recovery behavior for learning memory, pending proposals, and
  disconnected native context. Reset or deletion retires dependent replay and
  proposal authority while preserving the visible session transcript and unsent
  local draft.
- Added guided predictions, checks with authored feedback, hints, requirements,
  optional activities, protocol attestations, and reviewed learning-memory
  proposals. Assistant responses cannot mark activities complete or apply a
  proposal.
- Added provider capability profiles, bounded input/output and run deadlines,
  safe failure categories, continuous grounded teaching, replay filtering, and
  synthetic conformance fixtures. Provider configuration remains optional.
- Added canonical schema-v2 Author editing for course, module, phase, surface,
  learning, completion, and policy fields, plus runnable diagnostics and
  exact-byte conflict handling. Its automated and installed evidence predates the
  full S01–S14 student trial; the latter did not test teacher/Author workflows.
- Added generic installed-wheel checks, exact-course adapter checks, credential
  and owned-process cleanup sentinels, actual course-kernel isolation checks,
  build-determinism checks, and retained recovery/privacy cases.
- Added a portable eight-file macOS student bundle with the CourseWeave license,
  checksum-bound application wheel, separately licensed course archive and runtime
  constraints; first start creates isolated
  application/course interpreters and a fresh study home named for the course
  version. Restart, redacted diagnostics, state inspection/export/reset and
  repeat setup preserve existing work.
- Added local full-course support for Agent Harness Path S01–S14: fourteen
  readers, twelve guided notebooks, twelve prediction gates, thirty-five guided
  checks, and two optional S13/S14 practical protocols. The accepted local
  package opened all declared student surfaces and executed and saved all twelve
  notebooks through installed JupyterLab.
- Added a read-only GitHub Actions source gate for pull requests, pushes to
  `main`, and manual runs. It tests Python 3.11/3.12 and runs frontend typecheck,
  unit tests, and build on Node 22; installed artifacts and live providers remain
  separate gates.
- Added a portable full-course acceptance command with explicit release,
  evidence and nonsynced test-root paths. Its default is synthetic-only;
  separately authorized live text checks require one environment-configured
  provider and never discover a credential file.
- Added public contributor, security, release, pull-request, and safe bug-report
  guidance.
- Licensed CourseWeave under the unmodified PolyForm Shield License 1.0.0 with
  the project notice and CourseWeave line of business. Package metadata uses
  `LicenseRef-PolyForm-Shield-1.0.0`; wheel, sdist, and student-bundle checks
  preserve the exact license alongside third-party notices. Added a licensing
  guide covering permitted evaluation and noncompeting use, the competition and
  New Products boundaries, independent course and learner-work ownership,
  contribution terms, and the route for separate commercial terms.
- Added the existing MIT notice for bundled React 19.2.8, ReactDOM 19.2.8 and
  scheduler 0.27.0 to wheel and source-distribution metadata. It covers only
  those third-party components and does not grant a CourseWeave license.

### Changed

- Made schema version 2 the runnable format. Public v0.1.0 and its schema-v1
  course data are not drop-in compatible with this candidate.
- Moved learner state outside the course source tree and bound it to course
  identity. Updating or opening a different course no longer silently replaces
  or reuses unrelated learner work.
- Reworked Learn around one authoritative saved state, explicit activity context,
  reviewable proposals, and deterministic progress rather than phase-local
  assistant sessions.
- Reworked Author around canonical v2 drafts, explicit Save/Accept actions, exact
  ETags, revision-aware proposals, and recovery that preserves unsaved browser
  work while authoritative state is refreshed.
- Hardened native HTML reading with authenticated, declared paths; script-disabled
  content; bounded linked images; and explicit interception of approved local
  lesson links.
- Changed the local student default from the original S01/S02 edition to a
  separate S01–S14 study home while preserving the earlier release and records as
  a rollback route.
- Expanded source distributions to include the locked frontend sources, tests,
  runnable examples, release scripts, source CI, and top-level README, changelog,
  contributor, security and agent guidance needed for reproducible builds, while
  excluding dependency trees and transient test/build output. Package metadata
  now exposes the README plus repository, documentation and issue URLs.
- Made student provider use an explicit launch choice. Default and
  `--no-provider` launches ignore inherited provider credentials; interactive
  OpenAI/Anthropic setup uses hidden input, while `--provider-env` accepts only a
  deliberately selected provider configuration.
- Forced the Lab TypeScript library rebuild before packaging so stale incremental
  build state cannot preserve obsolete emitted JavaScript.

### Fixed

- Discarded unused Jupyter output directly at the process boundary so inherited
  pipe writers cannot keep shutdown waiting or trigger a false cleanup failure.
  Credential-bearing child output remains suppressed.
- Prevented stale Author reads, draft identity handoffs, proposal actions, and
  concurrent state updates from overwriting newer authoritative data.
- Preserved unsaved Author drafts and learner conversation/drafts through
  reconnect and controlled native-context failures.
- Preserved authored hints and bounded teaching context while preventing retired
  evidence or completed actions from re-entering provider replay.
- Corrected privacy reset/delete behavior so held old actions and late responses
  cannot restore retired state or proposal authority.
- Serialized rapid native terminal/navigation requests so earlier asynchronous
  opens cannot regain focus after a later lesson selection; repeated A → B → A
  navigation is retained.
- Kept native lesson links inert while a reader is loading, then bound them before
  interaction. This prevents the visible reader and assistant activity context
  from diverging during an early click or superseded load.
- Added unique lesson labels so retained excerpts disclose their original module
  instead of appearing to belong to the newly selected activity.
- Corrected full-course S13/S14 protocol commands to select the student
  implementation and kept optional real-world work distinct from synthetic
  workflow records.
- Rejected cloud-synced bundle, study, export and acceptance locations and
  redirected runtime containers before writes, while retaining the interpreter
  symlinks created by uv.
- Corrected S11 guidance to distinguish estimated cost, actual accounting, and a
  verified or conservative hard limit.

### Evidence boundary

- The complete local student acceptance is bound to platform source
  `f1134590cced78a6bd5202062178eba1f1edc0ae`, course source
  `585b45eb3186404b8445cae64126ab9929c22b87`, wheel SHA-256
  `1bd186b07af5d3a89b6c77dbce1cccfb3cef1fe76f91aa40dec8e2c4f361e923`,
  and course archive SHA-256
  `0bc19b9452187372314a1337c46e64a04c7152aeddc09f6859c5ed8b2b93e562`.
- That run established a macOS single-user student route, three bounded live
  text responses, and synthetic sharing/recovery behavior. It did not establish
  learning gains, real S13/S14 participation, live tool calling, screen-reader
  operation, teacher workflows, or general production readiness.
- The compatible local wheel still reports version `0.1.0` but is not the public
  v0.1.0 artifact. No release should reuse that version or present its local hash
  as a public download.

## 0.1.0 - 2026-09-04

- Published the first local-first CourseWeave platform with the schema-v1 course
  format, learner and Author surfaces, JupyterLab bridge, deterministic state and
  proposal transactions, and installed Agent Harness Path adapter verification.
- The immutable verification record is retained in
  [docs/verification/v0.md](docs/verification/v0.md). It is historical evidence,
  not setup or compatibility evidence for schema v2.
