# Author Edition specification consistency review

**Bundle:** `author-edition-0.3.0-review-1` · **Date:** 2026-09-14 · **Scope:** Planning documents, inspected against current source and the pinned public student schema. **Reviewer:** the planning assistant; this is a self-review, not an independent review or implementation acceptance.

The [three specifications](README.md) and [implementation plan](../superpowers/plans/2026-09-14-courseweave-author-edition.md) were reviewed here as planning documents. Their owner approval and fresh-session execution boundary are now recorded in the specification index. No application implementation, new runtime test suite, model call, search-provider setup, installed acceptance, or publication was performed while planning or preparing the handoff.

## Mechanical checks

The ad hoc audit produced [consistency-check.json](consistency-check.json) and [traceability.csv](traceability.csv). It checks shared bundle identity, unique requirement ownership, complete verification mapping, plan gate/task definitions, local document links, fenced-block balance, and the pinned released schema hash. It also compares progress/access/hint/share/surface/check enumerations against the released schema.

There are **68 normative requirements**: 22 shared, 28 Teacher, and 18 Student. They map to **11 verification gates** and **11 implementation tasks**. The durable CI checker and its regression fixture are planned in Task 1; the ad hoc check does not claim that checker already exists.

## Semantic cross-check

| Question | Resolution recorded consistently across the set |
| --- | --- |
| Is this a new incompatible course format? | No. Application target v0.3.0; student baseline v0.2.0; manifest schema stays v2; author-project metadata is separate. |
| Does Teacher mean a separate classroom LMS? | No. Teacher specification describes the human author workflow, with product name Author Edition. Cohorts and gradebooks are deferred. |
| Are there six autonomous authorities? | No. Six useful roles share one assistant, permissions, and review boundary. |
| Can the model change a course directly? | No. Bounded validated candidates, exact human-reviewed revision, atomic per-manifest/per-file apply. |
| Can a large course exceed the model context? | Yes; context uses a bounded outline and selected editable unit. The server composes and validates the complete candidate, with omissions visible. |
| Does author research give the student tutor web access? | No. Source catalogue and fetch policy remain private author features; only explicit final lesson material/reference metadata reaches the student. |
| Is a source link proof that a claim was checked? | No. Search, retrieval, quote-location validation, model judgment, and human decision have separate statuses. |
| Can the model approve its own findings? | No. Human disposition starts unreviewed and has a separate human action boundary. |
| Does objective coverage or a correct self-check enforce mastery? | No. Progress keeps existing submission semantics; mastery gates are deferred. |
| Is Author preview already the actual student experience? | Existing preview is inert metadata. The proposed actual preview uses an isolated installed student runtime and distinct state. |
| Can source/private materials leak through automatic export closure? | Required assets must be both included and permitted. Private/excluded material cannot be silently added to satisfy a link; the export must report the conflict. |
| Are answer keys secure exam secrets? | No. Native formative check answers are deliberately packaged; withholding them from prompt context is not proctoring. Private author solution documents are separately excluded. |
| Are all files changed as one transaction? | No. One manifest or one authored file is the mutation unit. Drafts may be temporarily incomplete; package finalization uses a separately validated stable snapshot. |
| Does notebook editing imply execution or real-world completion? | No. Author cell edits are reviewed; running is a direct human action in preview. S13/S14 remain optional and unaided restrictions remain enforced in the native path. |
| Can the generic launcher overwrite the old study home? | No. New course/package identity selects a separate home. Existing delivered launchers and releases remain untouched. |
| Is the search researcher useful without native model tools? | Yes, by design: a fixed server workflow performs authorized search/fetch, and the existing text-only model route synthesizes the results. Live acceptance is still required. |
| Does provider-off operation meet assistant acceptance? | No. Manual workflows continue, but the shipped six-role claim requires separate real-provider and real-discovery evidence. |
| Does a custom GPT/plugin inherit the unaided guarantee? | No. Denying backend actions does not stop an independent chat model from answering. Future interfaces have a separate scope and evaluation. |

## Changes made during review

- Kept author-only provenance/research/rubrics outside the frozen student manifest.
- Made actual student preview and generic course launch packaging explicit rather than assuming the existing inert preview or course-specific launcher was sufficient.
- Kept manuscript/notebook mutations to one reviewed file at a time and specified crash reconciliation rather than claiming a new multi-file transaction engine.
- Added a bounded, functional source-discovery path that does not depend on currently unverified native model tool support.
- Required server ownership of human review status and separate raw/extracted source identities.
- Replaced an underspecified recovery-test sketch with concrete restart fault scenarios and observable file/state/process outcomes.
- Corrected the service-signature block's language label after the fenced-code syntax check identified it as declarations rather than executable Python.
- Recorded the custom GPT retirement notice and kept any future ChatGPT adapter out of this release.

## Approval update and remaining limits

The owner's 2026-09-14 “go on” authorizes the post-review handoff described in the index. Approval changes lifecycle wording only; normative requirements, shared facts, task checklists, and deferred scope remain unchanged. The refreshed document receipt checks that preservation and records current file hashes. The original planning receipt remains in the private handoff evidence. Search API/model credentials and account capabilities were not inspected or changed. Future live testing remains a prerequisite of its respective release claims.

The document audit reports no detected mechanical inconsistency after the final check. The semantic review found no remaining material contradiction within the planned supported scope. These are bounded review results, not proof that all possible prose inconsistencies are absent. The exact implementation/release must receive the independent review specified in Task 11.

## Implementation update, 2026-09-15

Task 1 now supplies the executable checker and closed author contracts. Its
24 focused regression cases passed after failing-first runs, including two
additional defects found during implementation: a quoted old bundle ID hiding
a changed header, and a dangling verification reference in prose. The refreshed
`consistency-check.json` is a mechanical audit of this implementation's document
revision, with source hashes. The prior planning record remains part of the
approved private handoff. No runtime acceptance is inferred from either record.

A cross-edition self-review confirmed that lifecycle wording and completed Task 1
checkboxes change no normative requirement, shared fact, or traceability mapping.
See the implementation notes for authority/evidence limits and open release gates.

## Review and alignment implementation update

Task 7 implements private saved review reports, explicit human dispositions and
objective links, derived source/target staleness, and bounded canonical diagnostics
for the shared assistant. TE-009/TE-010/TE-011 retain separate factual, editorial
and deterministic authority; TE-016 review lifecycle and TE-017 coverage do not
grant mastery or change student requirements. Source metadata in a report comes
from the actual supplied context, with current provenance checked before saving.

The plan's implemented research/review service names now match their consumers.
Human decisions remain separate from model fields; selected-file association with
an activity is explicit and validated. The Author app's iframe uses the existing
shared constructor and permits deliberate artifact downloads. Student guide and
reader sandboxes retain their previous capabilities. This self-review changes no
normative requirement, shared fact, schema-v2 byte or traceability row. The final
immutable-candidate independent review and installed gates remain open.
Independent review remains required at the exact candidate boundary in Task 11.

## Reviewed content implementation update, 2026-09-15

Tasks 2–4 add deterministic compatibility, private project/source ownership, and
reviewed one-file editing. The shared schema-v2 facts and normative requirement
rows remain identical to the approved handoff. The content journal uses the same
CourseStore lock and canonical manifest writer; it adds no student progress or
permission authority. Source/student originals remain preserved, and notebook
execution is reserved for later isolated preview.

The Task 4 content and recovery checks have development UI/API evidence. Two
export-specific assertions in its checklist depend on the Task 8 generic
packager and remain explicitly unchecked. Session role/context revocation is
Task 5 work. Exact installed gates, live six-role/research observations, human
visual review and the bounded independent review remain open. This update is a
mechanical audit and implementation self-review, not release acceptance.

## Author assistant implementation update, 2026-09-15

Task 5 adds the six visible rubrics, server-selected bounded context, exact source
quotation validation, session-only conversation/drafts and explicit draft saving.
It shares the existing provider lifecycle and AG-UI parser. The real text-only
reviewed-edit path passed with separate rejected and applied revisions. An earlier
invalid response failed closed; no automatic repair or native tools were used.
The desktop diff and narrow controls have assistant visual inspection, with no
human visual or learning claim.

Course-level assistant selection is explicitly course metadata with modules
preserved on the server. Module selection supports activity-structure edits, and
activity/learning/file selections bound the smaller editable unit. This clarifies
composition without changing schema-v2 semantics or the approved requirements.
Changing hats preserves valid conversation but revokes in-flight candidates;
deliberately saved changes retain their separate durable review lifecycle.

Normative rows, shared facts and traceability remain unchanged across all three
specifications. Task 6 research, Task 7 saved reviews, Task 8 export, Task 9 actual
preview, Task 10 recovery and Task 11 exact acceptance/independent review remain
required. All-six-role live acceptance and actual Brave research are open gates.

## Source research implementation update, 2026-09-15

Task 6 implements the optional separate Brave adapter, bounded public HTTPS
transport, explicit policy/network/cancellation controls, private source snapshots,
static extraction, source revision invalidation and durable actual research
outcomes. The existing Author text model remains separate from network actions;
only a human source decision and explicit per-request permission grant context.
No model output approves sources, publishes learner material or sets factual truth.

The shared lock gained an optional research deadline/cancellation wait check after
an observed held-lock failure. Immutable terminal reports publish atomically
without a mutable index. Source registry publication remains under the canonical
course lock. No Student schema, rule, state or consent behavior changed. Normative
rows, shared facts and traceability stay identical across the three specifications.
The development checks and live allowed fetch are not exact installed V05/V09
acceptance. Live Brave discovery, Task 7 findings, Task 8 packaging, Task 9 preview,
Task 10 recovery and Task 11 release/independent review remain required.
