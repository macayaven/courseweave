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

Task 6 actual Brave discovery remains open. Task 11's local candidate, installed
checks and independent review follow-up are recorded; final acceptance remains
dependent on that actual search check. Both full-course
Student runs, the paired new-course journey, all six real-provider roles and
failure/recovery have observations with the limitations recorded below.

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

Three-spec impact: TE-006/TE-007 research and TE-004/TE-008 source curation now
have implementation coverage. Student schema-v2 rules, progress, consent and
provider scope remain unchanged. Author research grants no Student retrieval.
Generic export exclusion, saved model findings/human dispositions, full recovery,
exact installed gates and final independent review remain subsequent work.

## Task 7: saved evidence reviews and explicit objective links

The shared assistant context now includes bounded canonical compatibility
diagnostics and source attribution/dates/extraction policy alongside exact raw
and text identities. Visible omissions remain part of the saved report. Context
budgeting accounts for JSON escaping and reserves space for selected evidence;
truncated targets cannot authorize whole-file edits. The shared stream recognizes
`author-assistant-v2` while retaining the existing Student and Author v1 metadata.

An explicit Save review report stores a validated completed reply, separate from
Save draft and session chat. Its sources come from the exact supplied context;
reading or saving checks current source metadata as well as revisions and bytes.
Model findings cannot set human dispositions, objective links or compatibility
authority. Reports are private atomic JSON artifacts with revision-checked human
decisions, deletion and export, bounded to 200 reports of 512 KiB per project.
See [reviews.md](reviews.md) for the operating workflow and limits.

Coverage consumes canonical activity/objective/hint/check metadata and explicit
human objective links. Current supported, located and accepted/revised findings
can appear as author-accepted evidence links. Unreviewed or stale findings remain
gaps; missing objectives remain guidance. Activity-wide prompts and declared
references are labeled separately. Neither coverage nor native checks grant
mastery or change required progress.

The deterministic corpus declares expected behavior for nine cases before live
execution. Focused service/API tests cover quoted spans, source identity and
metadata changes, disposition authority, stale targets, concurrent decisions,
deleted-report replay, export privacy and objective mappings. UI checks cover
explicit save/disposition/delete actions, revision conflicts, manual report
selection and independent panel reads. Actual Jupyter development checks exposed
a mutual loading/disabled loop and a blocked review download; focused regressions
cover both. Only the Author app iframe gains deliberate download permission;
Student guide and content-reader sandboxes retain their existing capabilities.

Live results and remaining validation are recorded in the local implementation
receipt. An initial real response used Markdown fences and an inexact quotation;
the strict envelope rejected it without saving or automatically retrying. A
manually revised author request produced a valid supported finding. Across the
nine-case corpus, an earlier rejected attempt and a manual current-source
follow-up, eleven explicit requests
produced eight validated replies and three rejections. The rejected attempts
remain in the local evidence. No automatic provider repair was made. One failed
current-source run lacks its displayed wording in the capture; a separate
current-source request was inspected and saved, with that capture gap disclosed.

The inspected proofreader diff corrected prediction/observation timing through
the ordinary explicit apply. Factual review declined invented citations and
unsupported retention claims. Compatibility review retained actual issue codes
and locations and rejected an unsupported mastery request. Model explanations
still need review: one draft assumed unspecified code cells, one response only
partly explained recorded requirements, and one overgeneralized revision/hash
identity. Those statements acquired no deterministic or mutation authority.

Development checks: 236 focused Python cases passed with one separately gated
installed-profile skip; 163 Author and 79 Lab cases passed, as did frontend
typecheck, rebuilt Author/bridge assets and twelve specification regression cases.
Actual UI checks include private download, accepted objective links, source/target
staleness, two-tab decision conflict with preserved notes, dismissal with a reason,
keyboard deletion, restart and a bounded scrolling coverage table at 390 pixels.
These are automated UI and Codex visual/evidence observations, not fresh archive,
independent human or learning evidence. Full installed V06/V09 acceptance remains
required.

Three-spec impact: TE-009/TE-010/TE-011 reviews, TE-016 report decisions and
TE-017 coverage consume the existing source and content authorities. Normative
facts, schema-v2 bytes, progress, Student
consent and the requirement-to-gate mapping are unchanged. Implemented service
names/signatures in the plan now match the research and review services; there
are no duplicate compatibility wrappers. Final independent review remains open.

## Task 8: stable course exports and generic Student bundles

Author delivery now inspects an explicit file selection and its source decisions,
copies the reviewed bytes under the canonical course lock, clears notebook outputs
only in that copy, checks local assets/fragments and the frozen Student profile,
and publishes a new archive without replacing an existing destination. Required
linked assets cannot bypass private-file or source-distribution decisions. Raw
source snapshots retain an immutable course-file association when their title or
review decision changes. Draft archives retain errors and cannot launch Student.
See [delivery.md](delivery.md) for the workflow and supported static checks.

The generic Student assembler uses verified wheel and dependency inputs. Course
ID, author-selected version and archive hash select separate study homes. Both
released Student 0.2.0 and the candidate 0.3.0 can use the same schema-v2 course.
Markdown-only courses need no project runtime; notebooks use the course's frozen
UV project in a separate kernel. One standalone launcher implementation is copied
into new bundles; previously delivered launchers remain untouched. Shared archive
checks reject private paths, collisions, special files and unsupported sizes
before extraction. Export and extraction support the same directory-depth limit.

The pinned Agent Harness Path has one existing Markdown fragment mismatch in
`labs/s01_loop.md`. A faithful selected-course export preserves every included
byte as a labeled draft with that diagnostic. A separate reviewed correction in
the private copy uses the actual Jupyter heading ID; its standard export preserves
all other included bytes, manifest identities/policies and twelve notebooks.
Unused optional video LFS pointers are excluded from the default learner closure;
explicitly including a pointer is rejected. This is not a claim that the corrected
package is byte-identical to the baseline. Exact installed acceptance must retain
both the faithful control and the disclosed one-link repair.

Development evidence includes external-editor and destination races, source
revocation/import lineage, output-free export, missing assets, generic bundle
inputs, and installed Markdown/notebook setup with each Student version. Actual
installed Author UI exercised keyboard selection, explicit export, bundle creation,
reopening saved exports after restart and a stale-inventory conflict with retained
inputs. Desktop and 390-pixel captures were visually inspected by Codex. Test
selectors needed two corrections; their failed records remain available. The final
preview, notebook execution, full recovery and complete release gates remain open.

Three-spec impact: TE-020/TE-021 delivery consumes existing source/content authority;
Student schema, engine, consent and progress are unchanged. Application metadata
now names the 0.3.0 candidate. Task 4's two export assertions are covered here.
Task 10 still owns interrupted export/bundle reconciliation and backup/restore;
Task 11 owns the exact archive and bounded independent review. No publication or
production-readiness claim is made.

## Task 9: actual installed Student practice

A private preview manager consumes a saved standard export and the configured
Student input descriptor. It builds a new bundle and study home outside the
Author project, then starts the selected installed Student LaunchSupervisor.
The existing schema, course engine, consent and native notebook path stay
responsible for learner behavior. One preview may run per Author home.

Start/Open/Stop and explicit observation/Keep/Discard controls distinguish
process readiness from what an author reports checking. A private inherited
socket carries readiness and controls child lifetime. Tokens are never written
to preview receipts or returned by the preview API. Provider use is unchecked
by default; explicit opt-in transfers only the configured model fields to the
Student supervisor. Search and application credentials stay out of its kernel.
A valid 8,000-character Unicode note can be saved and reopened.

Installed development evidence covers both released Student0.2.0 and candidate
Student0.3.0: seven surface types, a prediction, an authored hint, a native check,
manual notebook Run All and Save, a permitted synthetic response, unaided Send
restrictions with unchanged provider counters, explicit Keep, and reopening the
saved observations/notebook after Author restart. A separate default-off run
made zero model requests despite planted parent credentials. The real notebook
kernel reported none of the tested model/search/application credentials.

Rendered desktop/390-pixel inspection found that the native Jupyter panes need
its existing sidebar toggles at narrow widths. With the file browser closed,
the guide fits; hide the guide to read/edit the notebook. Jupyter's own news
notification can overlap lower controls until dismissed. Author controls, long
receipt paths and notes wrap without horizontal overflow. This is automated UI
and assistant visual evidence, not human learning or final archive acceptance.

The installed local-video check exposed an old reader defect: Jupyter's /files
media document loses authentication under its opaque sandbox. Candidate0.3.0
now embeds a browser video element in the same scripts-disabled reader, allowing
authenticated media/range requests without treating course bytes as a document.
Actual metadata and playback pass. Released0.2.0 remains unchanged; Author
reports its observed limitation and blocks local-video surfaces in a paired
standard handoff even with candidate diagnostics selected. The paired fixture's
HTTPS video response is explicitly synthetic and establishes no public-media
availability. Failed attempts and their causes remain in the private evidence.

Validation: 169 Author cases, 80 Lab cases and frontend typechecks pass. The
Python3.12 affected preview/compatibility/export/kernel/Jupyter group passed86
cases and18 subtests with one explicit full-course integration skip; focused
Python3.11 checks passed46 with two explicit external-fixture skips. The current
installed wheel is bound to its source/assets in the private Task9 receipt.

Three-spec impact: V08 gains installed development evidence. Normative rows,
shared facts, traceability and frozen schema-v2 bytes are unchanged. SE-003's
unsupported-rendering reporting is strengthened by the observed released-video
limit. Preview observations acquire no progress or compatibility authority.
Task10 recovery, Task6 actual Brave discovery, exact final candidate acceptance
and the bounded independent review remain open.

## Task 10: backup, restore and interrupted work

Private backup inspection selects optional drafts and saved research/review
reports, alongside the saved course, current source snapshots and applied
provenance. A closed inventory and file hashes are checked again before
publication. Restore validates a complete supported archive before creating a
new project, then publishes its completion marker last. Pending changes and
reports become stale; rejected changes and human dispositions retain their
states. No apply journal, preview home, conversation or credential custody is
restored. See [recovery](recovery.md) for the 2 GiB/40,000-file scope and exclusions.

Export journals close the gap between publishing the final tar and saving its
private receipt. Exact archives reconcile once; incomplete attempts stay
interrupted and offer explicit removal of only their marked staging directory.
Content recovery now rejects mismatched operation/change pairs and cannot
resurrect a terminal rejected change. Preview records persist their process
identity and deletion intent; receipt-write failure cannot bypass child cleanup.

A real SIGKILL test reproduced an inherited Jupyter course lock after Author
death. Candidate Jupyter now monitors its OS parent relationship and uses its
existing shutdown path on parent loss. The real process regression passed,
including a separate surviving witness. The installed browser journey exercised
backup/restore, real notebook Run All/Save, forced Author death, owned Jupyter and
kernel exit, immediate Author restart, preview reconciliation and Keep in both
Student versions. A further two-tab run proved stale apply/backup rejection while
preserving a newer explicitly reviewed file and the separate saved notebook.

Task10 development verification includes 50 required Python3.11 checks with an
actual generated Student launcher, 249 affected Python3.12 cases (one explicit
full-course fixture skip), and 88 launch/Jupyter checks with18 subtests. These
groups overlap; their counts are not a combined acceptance score. Fault workers
actually exit inside apply, export and a synthetic source-fetch pipeline. Public
discovery and live model use are separate gates. Exact artifacts, failures and
representative rendered screenshots are recorded privately with the task receipt.

Three-spec impact: V10 gains development recovery evidence. The shared schema,
engine, recorded progress and Student consent rules are unchanged. Source
approval retained in an explicitly restored new project is not a new editorial
judgment. The exact release archive, full-course acceptance, live Brave discovery
and final bounded independent review remain required in Task11.

## Task 11: portable Author candidate packaging

The standalone Author launcher reuses the existing Student setup/environment helpers, adds explicit Brave opt-in and binds a separate Author home to the chosen wheel. Hash checks precede setup; the application includes pinned JupyterLab and a separate kernel without CourseWeave. A complete release marker binds both Student wheels, constraints, source distribution, launcher and user documentation. The archive uses an explicit flat inventory and deterministic tar/gzip metadata. A corrupted runtime can be prepared again without replacing project files. Final installed acceptance and independent review remain open.

Candidate 1 passed actual launcher setup, corrupted-readiness recovery, private
project import, reviewed spelling correction, paired generic bundle creation,
backup/new-project restore and Author restart in fresh test homes. The complete
Python suites passed on 3.11 and 3.12; frontend typecheck, unit and build checks
passed. The exact private receipts distinguish these observations from open
live-role, full-course and final review gates.

The first six-role installed live run accepted the proofreader's exact spelling
change and the compatibility explanation. Four other replies were correctly
rejected for quotation provenance mismatches. A separate curator diagnostic
confirmed a real quotation with incorrect character offsets. The prompt now
instructs the provider to copy an entire supplied excerpt and its supplied offsets,
or leave evidence empty when it cannot establish a shorter span. Validation stays
strict; the server neither repairs a quotation nor treats a model claim as truth.
Eighty-one affected assistant/review/quality tests passed. Candidate 2 subsequently
produced accepted responses for all six roles across a full run and one explicit
curator/proofreader retry. The first curator response incorrectly transferred a
redistribution decision between sources; the retry was useful but omitted some
requested metadata. A proofreader response with the wrong role was rejected; the
retry supplied and explicitly applied only the intended spelling correction.
Quotation provenance does not establish factual accuracy. The fact-checker prompt
supplied the intended judgment, so that observation demonstrates structured
grounding and provenance, not blind factual accuracy.

The versioned acceptance scripts exercise the actual Author launcher and reuse
the existing process and credential checks. They also prepare the pinned full
course using installed Author services, retain the faithful draft, disclose the
single fragment correction and check both generated Student versions. Verifier
fixes account for generic course-specific homes and the added absent Brave-key
field in kernel isolation evidence; neither changes Student behavior.

Three-spec impact: normative requirements, traceability, schema-v2 bytes and
Student rules remain unchanged. The native Jupyter Markdown link opens its local
target in the text editor; rendered heading scrolling is not established there.
Actual Brave discovery and bounded independent review remain required.

Both installed Agent Harness Path runs now cover all fourteen lessons, twelve
executed notebooks, 108 local HTML link clicks each, optional S13/S14 boundaries,
sharing consent, restart and export/reset with notebook preservation. The new
two-module course also passes both actual Student previews and Author backup,
restore and restart. Test records are synthetic; no learning gains are inferred.

Independent review reproduced two UI defects. A revoked approved source remained
hidden in the conversation's selected IDs, preventing context recovery. Catalogue
refresh now removes only IDs that are no longer approved; remaining permissions
and the unsent message survive, and reapproval does not restore permission. A
second defect allowed editing while restore was pending, then lost that new draft
when the restored project opened. Recovery now disables and inerts the editor and
related panels until completion. Focused failing-then-passing regressions cover
revocation/reapproval and restore success/failure; all 176 Author tests, typecheck
and build pass. Candidate 5's actual installed verification passes these fixes,
with a separate independent frozen-source and artifact review.

Installed verification passed both recovery interactions. Rendered inspection
then exposed the new fieldset collapsing the desktop grid and removing panel
styling. The recovery wrapper now participates without a layout box; its children
retain the existing grid/card styles. The installed verifier checks column
positions, full-width assistant content and card backgrounds before the journey.
Those installed checks pass. The final run also preserves both Student previews,
notebooks/observations, restored course and restarted Author state, with no owned
process remaining and no selected credential in the scanned test files. Exact
candidate identity and remaining limits are in the acceptance record. Actual
Brave discovery is still required; the existing credential-location request is
unanswered. No further independent implementation work is known to block this
local candidate.
