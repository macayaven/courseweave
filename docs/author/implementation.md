# Author Edition implementation notes

Target: application v0.3.0; approved bundle `author-edition-0.3.0-review-1`.
Implementation began on 2026-09-15 from the public v0.2.0 baseline
`409f5c01e93d98f118967138116b0dbafff80ed7`. Required release gates remain open.

## Task 1: contract foundation

Added closed author-only models for project/selection/context, reviewed changes,
source research, separate model findings and human dispositions, compatibility,
exports, and student previews. Model drafts cannot provide a target path,
revision, mutation operation ID, human disposition, or compatibility pass flag.
Filesystem authority, transport enforcement, orchestration and persistence are
implemented in the subsequent plan tasks; the types alone do not grant them.

The shared schema and student runtime remain authoritative. This slice changes
no manifest schema, permission, progress or student state behavior.

Run `uv run python scripts/check_specs.py --root .` for a mechanical audit of
bundle headers, required facts, requirement ownership/references, verification
coverage, generated traceability, local links/fragments and balanced fences.
It emits JSON to stdout and a short summary to stderr. Semantic review remains
separate and no checker result is implementation or release acceptance.

Validation: the 90 existing manifest/Author API/store baseline tests passed.
The 24 new focused spec/contract cases passed after observed failing runs,
including undefined gates, duplicate owners, stale traceability, invalid links,
and attempted model authority fields. The audit covers 68 requirements and
11 gates. These are local development checks, not installed or live-provider
results. Final acceptance still requires both Python versions and exact archives.

## Three-spec impact review

The lifecycle headings and Task 1 checkboxes changed; normative requirement
rows, shared JSON facts, schema version 2, and requirement-to-gate traceability
are unchanged from the approved handoff. Shared authority remains one manifest
or one authored file per explicit apply; author state and model findings remain
separate from student state, compatibility decisions and human review. Source
research does not grant student retrieval. Neither objective coverage nor test
records prove mastery or real-world protocol completion. This is an implementation
self-review; the bounded independent review remains required in Task 11.

## Remaining work

Tasks 6–11, installed Author/Student journeys, actual public discovery, all six
real-provider roles, failure/recovery, rendered UI and independent final review
remain required. Source declarations and fixtures do not satisfy those gates.

## Task 2: released Student compatibility profile

The preliminary compatibility report now invokes the canonical structural and
runnable validators, with field-addressable structure/asset/profile sections
and explicit checks not performed. Its inventory hash is null until a stable
package inventory is checked; this draft report is not an export receipt.
Student v0.2.0 and candidate v0.3.0 share the unchanged released schema hash
`28ffd9b10fdcf4089e003db686924349c5fd488757de6f424bf11a26482d8839`.
Profile construction rejects schema drift, including disagreement with generated
canonical models. Workspace proposal declarations remain labeled inactive.

The Author inspector now derives enumerated choices from that canonical schema.
The new compatibility panel retains errors, omissions, target version and
actionable field links; a changed draft invalidates an in-flight result.
`POST /api/author/compatibility` is authenticated, bounded and read-only. It
accepts a manifest and an optional named Student version; callers cannot supply
pass flags. Manual compatibility requires no provider and makes no network calls.

Validation: 67 focused manifest/API/compatibility tests passed, including the
metadata rejection using a separate installation of the exact released v0.2.0
wheel. Its hash was checked against the existing public receipt. That check
exercises the released validator, not a complete learner installation journey.
Author typecheck and 31 affected frontend cases passed; the Author bundle built.
Required rendered/installed acceptance remains open. No shared manifest, engine,
policy or progress rule changed, and the approved normative specs/traceability
remain unchanged. Linked-asset closure and full packaging are Task 8 work.

## Task 3: private projects and source inventory

`courseweave author --home /local/author-home` opens the project picker through
the existing launch supervisor and authenticated Jupyter bridge. Choose a new
project ID, or inspect an explicit local directory and select files to copy.
The existing `--course-root` single-course launch remains available. These
options are mutually exclusive; an Author home owns its own state locations.

Each project lives under `author-home/projects/<project-id>/` and contains
adjacent `course/` and `author-state/` directories, matching the approved spec. New
projects use the existing unsaved manifest draft; only a direct Save writes the
manifest. Import inventories are limited to 10,000 files, 1 GiB, 40,000 traversal
entries and 64 directory levels. The reviewed digest binds the source root,
file paths and content hashes. Symlinks, special files, hidden files, known
private state and runtime paths are omitted and cannot be selected. Cloud Drive,
home Desktop/Documents and symlink roots are unsupported. Copy failure leaves
an incomplete project, identified by its missing final marker; it never reports
a partial import as complete or overwrites an existing destination.

Source identity is separate from content identity. Distinct files with matching
hashes remain distinct sources and are labeled as duplicates. Source metadata
records origin, import date, optional publication date, hashes, extraction,
review status, intended use and redistribution. Small UTF-8 Markdown/plain text,
RST and CSV can be explicitly selected for later context. Other formats retain
their original bytes with extraction marked unsupported. Imported code is never
executed. Sources start as candidate author references with redistribution
undecided. Human decision updates preserve immutable prior artifacts and publish
one atomic registry revision under the existing CourseStore lock.

Authenticated `X-CourseWeave-Project` requests dispatch to separate instances of
the existing per-course application. There is no shared mutable active root:
an old tab still addresses its original project. Author-only project routes are
disabled in ordinary Student launches. Up to 32 project instances may be opened
per process; restarting Author releases their ephemeral session state. The UI
blocks project switching while manifest or source decisions have unsaved edits.

Validation includes focused project/API tests, existing launcher tests with live
Jupyter in both modes, Author/bridge tests and typechecks/builds. The rendered
development journey covers first launch, keyboard selection, private import,
direct Save, source decisions, empty project creation, reopening and a 390-pixel
window. Visual inspection found and fixed selection-control sizing and sidebar
layout; a project-switch regression exposed duplicate React keys and is covered
by a failing-then-passing test. This evidence is automated UI plus assistant
visual review. Owner visual review and exact archive acceptance remain release
gates. A successful text-only model access canary establishes access only; the
six-role Author workflow and live Brave discovery remain required later tasks.

Three-spec impact: schema-v2 rules, progress and Student consent are unchanged.
Project metadata and source decisions remain outside the student manifest and
student state. Normative requirements and traceability are unchanged. There is
no general production, compliance or learning-effectiveness claim.

## Task 4: reviewed content and interrupted-save recovery

The Lesson files panel edits private Markdown and selected stable notebook cells,
creates a small two-cell notebook scaffold, and adds new cells through explicit
author actions. Imported asset replacements retain a separate source snapshot
and origin, candidate status and undecided redistribution. They do not execute.
Only a new cell receives a new ID. Notebook assembly preserves existing IDs and
metadata; code outputs/counts are cleared in the reviewed source candidate.
Original imports and student copies receive no writes.

Each edit produces immutable before/after files plus closed candidate metadata
under adjacent author state. Applying requires review of that candidate revision,
an operation ID, matching context digest, project revision, source revisions,
manifest hash, target hash and target existence. An absent file differs from an
existing empty file. Diffs show exact text changes, including final newlines;
binary imports show byte counts and before/after hashes. Rejected and stale
candidates cannot apply. Editing a candidate creates a new saved candidate.
Unsaved edits in other cells remain in the tab.

Manifest fragments compose into selected course metadata or a module/phase/learning node,
then use the canonical schema-v2 validator and manifest writer. A selected
module/phase and the course retain their IDs. Missing future assets can be a
structurally valid draft; runnable/package checks remain separate. Content changes
do not introduce student manifest fields or a second course-rule engine.

The shared CourseStore lock now has a narrow recovery entry point that yields
the registered course identity without needing a parseable current manifest.
It uses the same lock file as normal store transactions and never initializes
or resets learner state. The canonical manifest writer also accepts that open
directory descriptor, checks the exact ETag, and fsyncs the directory after its
atomic publication. It rejects symlink targets and detects an intervening edit.

An apply journal is prepared before the single target write. After a crash, an
exact after-hash publishes an applied receipt, an exact before-hash leaves the
candidate pending with that interrupted operation failed, and a third hash or
symlink substitution exposes a conflict. Recovery never overwrites a third file.
Repeated successful operation IDs return the original receipt. Reported write
failures are terminal for that operation; if the target changed before a late
failure, the project revision also advances to invalidate other old candidates.
Apply is one file, not a multi-file transaction.

Content and backups are bounded to 8 MiB each; direct Markdown/cell text uses the
64,000-character draft contract and HTTP requests remain capped at 1 MiB. A project
supports 1,000 saved changes and 10,000 operation records, with review lists paged
20 at a time. Reaching a limit requires archiving the project rather than silent
history loss. Invalid/corrupt artifacts remain visible errors.

Validation includes selected manifest fragment composition, structural/readiness
separation, two-tab conflicts, same-operation replay, source revocation, ordinary
write failures, three crash positions, corrupt external manifest recovery, and
original/student notebook preservation. The real CLI/Jupyter development journey
checks keyboard rejection, an applied Markdown edit, an external editor conflict,
named notebook cell selection after apply, and a 390-pixel review layout. The
rendered UI and screenshots are automated/assistant evidence, not human visual
review or exact release installation. Stable snapshots, notebook export, actual
Student preview, six live Author roles and final release acceptance remain later
tasks.

Three-spec impact: TE-013 through TE-015 and the reviewed mutation portions of
TE-003/TE-010/TE-026 now have implementation evidence. Session role/context
revocation is completed with the Task 5 assistant. V03 development checks do not
satisfy the separate V07–V10 installed/export/preview gates. Normative rows, shared
facts and traceability remain unchanged.

## Task 5: one bounded Author assistant

Private projects use the existing professor/provider lifecycle and AG-UI parser
with six explicit role rubrics. The composer previews the server's saved course,
selected module/activity or file, named notebook cells, approved sources explicitly
permitted for this conversation, and omissions. Previewing reads local state;
only Send/Request draft/Request review calls the configured model. The model
receives no filesystem or search tools. Manual editing remains provider-free.

The context contains a bounded outline and one editable unit. Course selection
means course metadata, with modules retained on the server. Selecting a module
allows reviewable changes to that module's activity structure; selecting an
activity or its learning value permits a smaller replacement. A large unrelated
course therefore does not require a full-manifest prompt. The canonical Learning
schema supplies teaching-field definitions. Whole Markdown replacements require
the full selected document to fit; truncated documents remain available for
discussion/review. Notebook context includes only named cell sources and omits
outputs, execution counts and other cells. No imported code executes.

Context is limited to 24,000 characters (or a smaller provider allowance), source
excerpts to 4,000 characters each, selected sources to 32, replies to 16,000
characters and composer requests to 8,000 characters in the UI. The existing
provider's total input, output-token and run-time limits still apply. An Author
run permits one provider request and zero tool calls. Network research is a
separate Task 6 operation and never enabled by changing roles.

Explicit draft/review requests use the closed author-reply-v1 envelope. The
service waits for successful complete output, checks exact source revisions and
quote offsets, and validates proposed content through the ordinary content
service without saving it. Invalid fields, unknown citations, truncation, provider
failures, cancellation and stale context leave no draft or replayable turn. No
automatic repair call occurs. A rejected reply remains editable in the current
tab for manual recovery. A successful reply is also session-only until the
author explicitly saves its content draft; Task 7 adds explicit finding reports.

Role changes preserve otherwise valid replay and revoke old in-flight/unsaved
candidates. Changed content or permitted sources revoke dependent replay. Each
accepted context has a new opaque identity when its digest changes, so switching
away and back cannot revive an old in-flight result. Project tabs share the same
session cookie but retain separate context, histories and draft authority.
Deliberately saved pending changes are independent durable review artifacts:
they can be reopened after restart, with their stored source/project/file
dependencies checked by the existing reviewed apply service. Saving never saves
the conversation, and changing hats does not confer mutation authority.

Development verification includes 269 focused Python cases before a live-found
cancelled-preview error, followed by a focused 106-case run after adding its
regression and handling disconnects. The Author frontend suite, new stream
handoff cases, typecheck and build passed. Final consolidated counts are in the
local receipt. Tests reuse the existing shared transport and provider lifecycle.

The real configured text-only route completed the reviewed-edit journey: an
explicitly saved correction was rejected by keyboard with unchanged course bytes;
a new draft was inspected and applied through exact-diff review. The original
import remained unchanged. Each successful run made one provider request. An
earlier complete model response failed envelope validation and left no saved
change; no automatic repair was attempted. Desktop diff and narrow-role controls
were visually inspected by the assistant. The CLI/Jupyter/browser processes and
bootstrap credential artifacts were cleaned up. This is development evidence,
not all-six-role, research, fresh-archive, human visual or learning acceptance.

After this vertical slice, the remaining planning forecast is 25–40 active
engineering hours for Tasks 6–11 and export integration, excluding waits for
external prerequisites. It is a forecast, not a timebox. Brave credential custody
still requires the owner's location information; independent offline work can
continue. Final acceptance still requires every gate and bounded review.

## Task 6: explicit research and revisioned evidence

The Research and references panel now offers offline reference import, optional
Brave discovery, separate explicit public URL fetches, allow/deny policy review,
network-off defaults, cancellation, saved reports and source excerpts. The existing
text-only Author assistant performs synthesis only after reviewed sources are
explicitly permitted. Setup and operating bounds are in [research.md](research.md).

The narrow standard-library transport validates every resolved address, pins the
actual numeric connection and retains TLS hostname verification. DNS, response
headers, wire/decompressed bytes and elapsed time are bounded; no browser cookies,
proxy credentials, provider keys, retry, crawl or script execution are used.
The optional Brave adapter uses its single documented Web Search endpoint and
separate environment key. Unknown publication dates stay unknown. Discovery
snippets never become substantive source evidence without an allowed explicit
fetch and source review.

Static text/HTML/Markdown extraction produces retained UTF-8 bytes, an extractor
version and separate raw/text hashes. Login, access challenges, JavaScript-only
content, unsupported attachments and invalid encodings have explicit outcomes.
Excerpts show their exclusive-end character offsets and omissions. A same-origin
refetch with unchanged snapshots preserves decisions; changed bytes/extraction or
final URL creates a new candidate revision with redistribution undecided. Prior
snapshots remain immutable, and existing source-revision checks invalidate stale
assistant context and pending edits. Different origins keep separate identities.

Source publication uses the canonical course lock and one atomic registry update.
A verified regression showed research waiting beyond its deadline behind a held
course lock. The shared lock seam now accepts an optional bounded wait check;
ordinary Student/store transactions retain their existing behavior. Terminal
research reports are immutable, uniquely named files with no mutable index, so
atomic publication does not wait on the course lock. The API admits one active
run per Author home; reports are paged and capped rather than silently pruned.

Development validation: 230 focused Python checks cover policy normalization,
DNS/TLS pinning, redirects, compression/size/deadline limits, cancellation,
network-off routing, missing discovery, source versions, local extraction,
private snapshots, revision/hash-checked excerpts, report reopening and the
existing content/project/assistant/store boundaries. All 155 Author UI checks,
typecheck and the Author build pass. A local HTML-fragment regression exposed a
title included in body offsets; the extractor now omits title text from the body.
These checks are separate from installed release acceptance. Live public fetch,
source review and synthesis development observations are tracked in the local
receipt; actual Brave discovery remains pending authorized credential access.

Three-spec impact: TE-006/TE-007 research and TE-005/TE-008 source evidence now
have implementation coverage. Student schema-v2 rules, progress, consent and
provider scope remain unchanged. Author research grants no Student retrieval.
Generic export exclusion, saved model findings/human dispositions, full recovery,
exact installed gates and final independent review remain subsequent work.
