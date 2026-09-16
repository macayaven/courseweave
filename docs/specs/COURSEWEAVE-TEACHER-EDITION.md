# CourseWeave Teacher Edition specification

**Product name:** CourseWeave Author Edition · **Bundle:** `author-edition-0.3.0-review-1` · **Date:** 2026-09-14 · **Status:** Approved; implementation in progress. Required release gates remain open.

This specification extends [CourseWeave](COURSEWEAVE.md) and produces courses for the [Student Edition](COURSEWEAVE-STUDENT-EDITION.md). Shared definitions and the machine-readable fact block live in CourseWeave. “Teacher” here is the human course creator; the software's collaborator is the Author assistant.

## Outcome

An expert with source material can create or import a course, organize its learning route, curate references, draft and improve activities with an assistant, inspect claims and editorial issues, run compatibility checks, try the actual student experience, and export a usable course package. Manual work remains available without providers.

The differentiator is sustained assistance across this workflow. Six selected roles share one conversation and the same visible scope, source inventory, and review mechanism. There is no autonomous agent swarm, hidden role escalation, or assertion that one model independently verified another model's answer.

## Main author journey

1. Open **Start Author.command**. Choose a new project or import a course into a new local project. See the source and destination before import; the original remains unchanged.
2. Enter the audience, prerequisites, learning purpose, and intended study route. The assistant can draft a course outline and objectives; the human accepts or edits them.
3. Add selected files or references. Inspect the catalogue's source location, revision, intended use, permissions, and review status.
4. Select a course, module, activity, or document and an assistant role. The composer shows exactly what will be sent and whether a network research operation is enabled.
5. Review findings or a concrete proposed change. Accepting an edit changes one shown manifest or file. Work remains a draft until all necessary pieces exist and validation passes.
6. Run **Check student compatibility**. Follow actionable links to the relevant field, file, fragment, selector, or unsupported expectation.
7. Open **Student preview** using a snapshot and separate student state. Read, run notebook cells manually, answer checks, test gates, then return to Author with a package-bound preview receipt.
8. Review the export inventory and remaining evidence limitations. Create a new course bundle with notices, instructions, hashes, and the student launch path. Export an author backup separately if desired.

## Six assistant roles

| Role | Inputs and concrete outputs | Required limits |
| --- | --- | --- |
| Data curator | Selected files and source records → organized inventory, duplicate/version findings, topic tags, inclusion/exclusion suggestions, attribution gaps, proposed learner-facing extracts. | Does not crawl the disk or read student homes. A copied file is not automatically approved or licensed for redistribution. |
| Curriculum designer | Audience, goals, existing activities, approved material → objectives, sequence, reading/prediction/attempt/observation/reflection prompts, progressive hints, native checks with option-specific feedback, suggested prerequisite notes. | Must fit schema-v2 semantics. Must distinguish recording a response from evaluating learning. Must preserve optional protocols and cell identities. |
| Source researcher | An explicit public research request and source policy → ranked candidate sources, dated retrieval records, relevance explanations, fetched supporting passages, unresolved access failures. | Search results and snippets are discovery evidence, not verified claims. No paywall/login bypass, hidden crawling, or automatic approval of found sources. |
| Fact checker | A selected claim or bounded document plus source revisions → claim-by-claim evidence links and `supported`, `contradicted`, `insufficient`, or `not_checked` findings; suggested corrections where justified. | Findings are model judgments until reviewed. A URL or matching quote alone is not proof of entailment. Never certify an entire subject or simulate a real-world experiment. |
| Proofreader | Selected content and style preferences → precise edits for clarity, terminology, grammar, units/notation consistency, ambiguous questions, answer leakage, and accessibility of explanations. | Meaning-changing edits are labeled. Images without usable descriptions and mathematical content not understood are flagged, not guessed. |
| Compatibility reviewer | The canonical validator's report plus selected course → explanations, impact analysis, and repair proposals addressing exact issue locations. | The deterministic service decides compatibility. The assistant cannot mark failed checks passed, invent runtime support, or change student policy to hide a defect. |

A role can recommend using another role. The author can change roles without losing permitted conversation context. A role switch changes the current rubric, not source access or privileges. No model reasoning transcript is requested or stored; reports contain concise findings, evidence, and suggested actions.

## Requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| TE-001 | The supported edition MUST provide the complete new/import → curate → design/edit → review → validate → student preview → export journey using the existing application. | V02, V07, V08, V09 |
| TE-002 | One continuous author conversation MUST expose all six roles from CW's fact block, with visible role and exact course/module/activity/file scope for each accepted turn. | V04, V09 |
| TE-003 | Author assistant context MUST use the server's exact saved revision plus explicitly selected author material. Unsaved edits MUST require a clear save or discard decision before an assistant request against them. | V03, V04 |
| TE-004 | The curator MUST record source identity, content hash, title, origin, retrieval/import date, optional source publication date, review status, intended use, and redistribution decision. Duplicate content MUST be shown without silently merging source identity. | V02, V05 |
| TE-005 | The designer MUST propose complete, valid learning metadata and reviewable structure edits, including objectives, aligned prompts, ordered hints, and native option-specific feedback. It MUST report unsupported desired behavior. | V04, V06, V09 |
| TE-006 | Source research MUST support explicit URL ingestion and bounded public web discovery through the single optional configured search connector. Every result MUST retain its origin and actual retrieval status. | V05, V09 |
| TE-007 | Author research MUST enforce allow/deny rules, explicit network enablement, per-run request/size/time limits, and cancellation in code. It MUST never inherit browser cookies or student/provider credentials. | V05, V10 |
| TE-008 | Local curation and manual editing MUST work without a search provider. If discovery is unavailable, the UI MUST say so and retain user-supplied URL/file workflows; it MUST NOT substitute fabricated search results. | V02, V05, V09 |
| TE-009 | The fact checker MUST attach each finding to exact target/source revisions and distinguish model evidence assessment from a human decision. Unsupported citations and inaccessible sources MUST remain visible. | V06, V09 |
| TE-010 | The proofreader MUST offer a concrete diff, preserve source meaning unless a substantive change is explicitly identified, and allow rejection or editing before application. | V03, V06, V09 |
| TE-011 | The compatibility reviewer MUST consume deterministic issue codes and locations from shared validation. It MUST explain effects in student language and stage corrections through the ordinary review boundary. | V01, V06, V07 |
| TE-012 | The inspector MUST cover every supported schema-v2 field and preserve valid imported values. Capability metadata not operational in the target student runtime MUST be labeled; unsupported promised behavior blocks the standard handoff. | V01, V07 |
| TE-013 | Native content authoring MUST support Markdown lessons and existing notebook-cell edits through reviewed per-file changes. Imported HTML/source/static assets MUST be preserved, inspected, and replaceable through explicit import; rich HTML/SVG design is not required. | V02, V03, V08 |
| TE-014 | Notebook changes MUST preserve untouched cells/IDs/metadata, assign IDs only to new cells, and export output-free source notebooks. Running a notebook MUST remain a direct human action in an isolated preview. | V03, V07, V08 |
| TE-015 | Drafts and pending changes MUST survive ordinary application restart through explicit saves. Rejected changes, stale revisions, interrupted saves, and external editor races MUST have visible, tested outcomes. | V03, V10 |
| TE-016 | Review artifacts MUST support explicit save, resolve, dismiss-with-reason, export in an author backup, and deletion. Updated evidence MUST stale dependent findings rather than preserve a green review state. | V06, V10 |
| TE-017 | A required-activity coverage view MUST map objectives to authored activities, prompts, hints/checks, and source support where provided. Gaps MUST be visible; a covered objective MUST NOT be called mastered. | V06, V07 |
| TE-018 | Prerequisite and unaided-work restrictions MUST be inspectable in both author forms and student preview. Prerequisite mastery notes are advisory in this release; only existing student assistance gates are enforced. | V01, V06, V08 |
| TE-019 | Student preview MUST launch an actual installed student surface from a snapshot, with fresh isolated records/notebooks and provider sharing rules. The existing inert card preview MUST remain clearly labeled as such. | V08, V09 |
| TE-020 | Export MUST include declared and selected transitive learner assets, licenses/notices, runtime inputs, setup instructions, a hash inventory, and a compatibility receipt. It MUST reject unresolved required assets and escaping links. | V07, V09 |
| TE-021 | Author-private source snapshots, reports, excluded assets, draft solutions, author state, and search secrets MUST be absent from student export. Inclusion MUST be deliberate and reviewable. | V07, V09 |
| TE-022 | One real text-only model route MUST support every assistant role and the reviewed-edit journey without requiring unverified native model tool calls. Synthetic-only results MUST not satisfy this acceptance gate. | V04, V09 |
| TE-023 | The Author edition MUST provide a complete README, provider/search setup and cost disclosure, a separate project home, backup/restore instructions, restart recovery, and a preserved prior application release. | V09, V10 |
| TE-024 | The shipped UI MUST support keyboard navigation, visible focus, readable diffs/citations, a narrow layout without inaccessible controls, and actionable validation links. Human visual inspection MUST accompany automated checks. | V08, V09 |
| TE-025 | The assistant MUST disclose missing/truncated context, uncertainty, and which resources it actually used. It MUST not describe linked-only documents, images, videos, or unexecuted code as inspected. | V04, V05, V06 |
| TE-026 | Author project selection and snapshots MUST be revision-bound. Course/role changes, source revocation, reset, or changed context MUST invalidate affected in-flight candidates and future replay. | V03, V04, V10 |
| TE-027 | Release acceptance MUST cover an unchanged full-course import/export and a newly authored small practical course; it MUST exercise all six roles, both student versions, failure/recovery, and export privacy. | V07, V08, V09, V10 |
| TE-028 | The product MUST expose what each compatibility/review status means and checks not performed. A human reviewer may resolve editorial findings but MUST NOT override structural incompatibility. | V06, V07, V09 |

## Content and project structure

The author launcher owns a local author home containing `projects/<project-id>/course/` and `projects/<project-id>/author-state/`. The working course is the manifest's root. The adjacent state directory holds `project.json`, source snapshots, saved reports, pending per-file changes, backups, and export/preview receipts. Neither directory is a student's existing home. Filesystem permissions and explicit local ownership apply; this is not a multi-user security service.

Import proposes an inventory before copying. It excludes VCS data, virtual environments, cache/build output, keys, state databases, chats, and unrelated files. Traversal is bounded to the selected nonsynced source root and rejects links/special files. Relative lesson links, images, and notebook selectors are checked against the chosen inventory. Runtime files and optional labs may be selected explicitly. Referenced future student artifacts are not mistaken for missing distributed source files.

Author-created Markdown is editable directly. Existing HTML and diagrams use the current safe reader for inspection; replacement is a reviewed imported file, not a rich web-design system. Existing notebooks can be opened in the native local notebook interface. Assistant notebook proposals target named cells; the review service constructs a full candidate notebook and validates it before one-file apply. New notebooks start from a small explicit scaffold with stable IDs; this is an author action, not fabricated student work. Outputs/execution counts are cleared only in the reviewed source candidate or export copy, never in a student's notebook.

No arbitrary executable file type is writable by an assistant proposal. Markdown and notebook-cell edits are in scope; source scripts/runtime files can be added or replaced only by direct author import/edit. Imported code is never run by structural validation or source research.

## Research and evidence policy

The selected discovery connector is **Brave Search API**, configured separately with an author-owned key. It uses a normal server-side HTTP API, not a browser session or model-native tool. This is the sole new optional search integration; it does not require a managed CourseWeave service. Official [API documentation](https://api-dashboard.search.brave.com/app/documentation/web-search) was checked for planning on 2026-09-14. Account access and a live acceptance run remain implementation prerequisites, not established facts.

The default is network off. The author explicitly enables a research run with its query and policy visible. A run allows at most two queries, ten search results held in memory in total, five source fetches, three redirects per fetch, and sixty seconds elapsed. A single fetch allows ten seconds and two MiB of decompressed HTML/plain-text content; extracted text retained for model context is bounded by the model route's existing request budget. A cancellation stops subsequent work. No automatic retries or background refresh occur.

Discovery displays each result's origin and actual retrieval status in the current session. To respect the connector's [current retention terms](https://api-dashboard.search.brave.com/documentation/resources/terms-of-service) (checked 2026-09-16), saved reports and backups exclude all search result fields. They retain the author's request/policy and the application's outcome. A new explicit search is needed after reopening a report. Separately selected direct publisher fetches retain their own source provenance and review decisions; the search account grants no rights to publisher content. Search snippets never become substantive model evidence or student material.

Research policy supports `allow_only` with exact HTTPS origins and optional path prefixes, or explicitly selected `public_web`; deny rules take precedence. Matching occurs after URL normalization at every redirect. Only public HTTPS destinations on port 443 are allowed; userinfo, private/link-local/loopback/reserved addresses, unsafe DNS changes, local files, and non-HTTP schemes are denied. The transport must connect only to a validated destination while preserving TLS hostname verification; a DNS precheck followed by an unconstrained second resolution is insufficient. Search result content never changes these rules.

Search results outside policy are not fetched or passed as substantive source evidence. Unknown publication dates stay unknown; retrieval date is separate. Login pages, blocked fetches, JavaScript-only content, complex PDFs, and multimedia receive an explicit unsupported/unavailable result; the author can supply a reviewed text extract with its provenance. No OCR, browser automation, authenticated-site scraping, recursive crawling, or PDF-layout interpretation is promised.

Resource states are `candidate`, `approved`, `rejected`, and `stale`. Intended use is `author_reference` or `student_material`. A human chooses approval and distribution. The source registry includes an allow/deny decision, but that registry is not exported as student runtime policy. An approved URL can be added to existing `learning.sources`; approved passages can be deliberately incorporated into lessons with attribution. The current student engine still does not fetch those URLs.

## Review and mutation contracts

Requests snapshot the role, target revision, selected sources, permission state, prompt version, and provider fingerprint. General conversation works with the configured text route. Explicit **Draft change** or **Review** actions request a bounded structured response, parsed after completion and validated server-side. Malformed output remains visible as a failed draft with manual editing available; no automatic repair call or silent partial acceptance is allowed.

A change displays its target, exact before/after diff, source references, and validation outcome. The server checks the target hash again at acceptance. Manifest changes reuse the existing manifest/proposal transaction; authored-file changes use a narrow author-only per-file service under the same course lock. Changing several files means several independently reviewed changes. Missing intermediate references are allowed in a draft and block export until repaired. This avoids a second multi-file transaction engine.

Fact reports use `supported`, `contradicted`, `insufficient`, and `not_checked` for assistant judgments; human dispositions use `accepted`, `revised`, `dismissed`, or `unreviewed`. Quote-location checks are deterministic and separately reported. A matching quotation establishes provenance, not the truth of the claim. The author can save a report; chat is still ephemeral. The compatibility role explains validator output and cannot write its pass/fail fields.

## Acceptance boundary and later iterations

This release is a local authoring companion with six useful roles, not a full LMS or a domain-expert certification service. The supported end-to-end examples are the preserved Agent Harness Path and a newly authored small practical course covering reading, a Python notebook, formative checks, and an optional unaided protocol. The assistant must work with a real provider on those tasks; learning efficacy and performance across all STEM disciplines remain unmeasured.

Later iterations may add managed retrieval and source refresh, broader document extraction, teacher-reviewed assessment decisions and progression prerequisites, cohorts, hosted operation, and ChatGPT adapters. These are explicit future projects, not empty controls shipped in the first author edition.
