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

Tasks 5–11, installed Author/Student journeys, actual public research, all six
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

Manifest fragments compose into the selected course/module/phase/learning node,
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
