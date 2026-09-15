# CourseWeave Student Edition specification

**Bundle:** `author-edition-0.3.0-review-1` · **Date:** 2026-09-14 · **Status:** Approved compatibility specification; author implementation is in progress; new release gates remain open. Baseline behavior is already implemented where identified below.

This specification describes the student behavior the planned [Teacher Edition](COURSEWEAVE-TEACHER-EDITION.md) must target. [CourseWeave](COURSEWEAVE.md) owns shared definitions, fact values, invariants, and version distinctions. The author release does not replace the student's current installation or expand the student's assistant permissions.

## Student outcome and baseline

A student opens a prepared course, follows its authored route, reads local lessons and diagrams, works in personal notebooks, records predictions/attempts/observations, receives formative feedback, and asks the continuous Course assistant for permitted help. They retain control over sharing, personal records, optional activities, and recovery.

The Agent Harness Path release has fourteen lessons, twelve source notebooks for S01–S12, and two optional notebook-less practical protocols for S13/S14. The twelve core sessions follow reading → notebook work → self-check. Optional videos and hard labs remain accessible. A different authored course can use a different route; the platform does not hard-code this course's session count or impose a notebook on every module.

Student v0.2.0 is the compatibility baseline. Candidate v0.3.0 must preserve these semantics and support independently exported courses with distinct study homes. The original v0.2.0 convenience launcher contains Agent Harness Path-specific packaging assumptions; it is preserved rather than silently repurposed. The new generic course handoff path is verified separately against the released student application.

## Requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| SE-001 | A compatible authored package MUST open in released Student v0.2.0 and candidate Student v0.3.0 through their supported launch paths, with the same declared course rules. | V01, V07, V09 |
| SE-002 | Navigation MUST expose declared module/activity order, readable labels, required/optional/excluded status, and the actual selected surface. It MUST not silently complete activities or redirect based on assistant advice. | V08, V09 |
| SE-003 | Local HTML/Markdown, static images/diagrams, links, fragments, source views, videos, terminal declarations, external links, and notebook selectors MUST retain their documented target behavior. Unsupported rendering MUST be reported by Author checks. | V07, V08, V09 |
| SE-004 | Students MUST edit personal notebook copies with preserved cell identities. Source notebooks in distribution MUST be output-free; execution and saved student output MUST not mutate the distributed source or author project. | V03, V07, V08, V09 |
| SE-005 | The course MUST present authored objectives, meaningful activity prompts, ordered hints, and explanatory formative feedback without claiming that their presence proves learning quality. | V06, V08, V09 |
| SE-006 | Native single-choice checks MUST validate the selected authored option and show deterministic feedback. Correctness MUST not directly grant completion or mastery authority. | V01, V08, V09 |
| SE-007 | The Course assistant MUST remain continuous across permitted activities while its current phase policy and displayed context are correct for each accepted turn. | V04, V08, V09 |
| SE-008 | The assistant MUST receive authored learning metadata plus explicitly selected lesson text and permitted student evidence. It MUST not automatically ingest linked resources, private author sources, videos, or unshared notebooks. | V04, V08, V09 |
| SE-009 | Explicit lesson selection MUST identify the source and revision; changing it or revoking it MUST clear dependent replay. Truncated or omitted material MUST be disclosed. | V04, V08 |
| SE-010 | Sharing MUST show the selected content, respect permitted share kinds and limits, and attach to the authorized run. Raw shared content MUST not become durable state or an unconsented future attachment. | V04, V08, V09 |
| SE-011 | Prediction/submission gates, disabled assistance, and observer-only phases MUST block all model calls until their authored conditions permit them. Author features MUST not bypass this in student preview. | V01, V08, V09 |
| SE-012 | Progress MUST use only valid, correctly bound records and defined artifact-presence checks. Stale/orphan records MUST not count. Excluded phases MUST not enter the required total. | V01, V08, V09 |
| SE-013 | Optional protocol prerequisites and unaided conditions MUST remain explicit. Saving a plan, synthetic test record, or attestation MUST not be described as evidence that real activities occurred. | V07, V08, V09 |
| SE-014 | Restart, export, and reset MUST preserve notebook work according to the existing student contracts. Export/reset previews and error messages MUST accurately describe their effect. | V09, V10 |
| SE-015 | The local student product MUST not be described as a secure examination or proctoring environment. Withholding answers from model context does not make distributed formative answer keys secret or prevent outside assistance. | V01, V08 |
| SE-016 | Provider failure, missing configuration, or denied assistance MUST retain reading, notebook use, manual records, and native checks. No synthetic answer may be silently substituted for a real provider. | V04, V09, V10 |
| SE-017 | New course packages and updates MUST create separate study homes and retain existing source/application releases for rollback. The author edition MUST never migrate or replace a student's current home as a side effect. | V02, V09, V10 |
| SE-018 | Author review decisions, search restrictions, and prerequisite rubrics MUST not be interpreted as runtime extensions. Only supported manifest fields and the shared engine may affect student behavior. | V01, V07, V08 |

## Mapping from authoring to student behavior

| Author action | Existing student representation | Boundary |
| --- | --- | --- |
| Define objectives and overview | `phase.learning.objectives`, `overview` | Guidance metadata; not mastery criteria enforced by the engine. |
| Write predictions/attempts/observations | `phase.completion.requirements` with supported record kinds | Submission requirement, not correctness grading. |
| Set progressive hints | Ordered `learning.hints` and `teacher.guidance.hint_level` | Permitted hint progression, not unrestricted tutor autonomy. |
| Create a formative question | `learning.checks` with single-choice options, answer ID, feedback, objective IDs | Native feedback; no gradebook or certification. |
| Require an attempt before assistance | `teacher.access.requires` referencing valid local phase requirements | Existing server-enforced provider gate. |
| Define unaided work | `disabled` or `observer_only` policy with no share/proposal authorities | No provider calls through CourseWeave while active. |
| Approve a reference URL | `learning.sources` with label/URL/review date, or a lesson link | Reference only; no automatic retrieval. |
| Approve useful source material | Deliberately authored lesson content with attribution | Available through existing student reading and explicit lesson context. |
| Record source allow/deny rules | Private author research policy | Not a student web filter, because student browsing by the tutor is not implemented. |
| Define prerequisites or review rubrics | Human-readable course/activity guidance | Advisory; no demonstrated-mastery transition engine. |
| Mark a lab/video/protocol optional | Supported progress/surface metadata and clear guidance | Optional status survives packaging and preview. |
| Review a claim or proofread | Final accepted content; private review report stays in author project | The report does not alter student state or establish correctness. |

## Context, privacy, and assistance

The baseline context builder provides current activity learning metadata, strips direct answer identifiers and option feedback from pre-attempt teaching context, and supplies only the permitted selected hint. Explicit **Use this lesson** selects a bounded visible-text excerpt from an approved local HTML/Markdown surface. Its content hash and source label are recorded in the request's context metadata. The baseline excerpt bound is 16,000 characters; hidden/disclosure sections are excluded. It is not whole-course retrieval or visual understanding of every diagram.

Navigation changes activity policy. An explicitly selected lesson source has its own visible scope and is changed/reset deliberately; the UI must not imply that a previously selected excerpt automatically became a different lesson. The same assistant conversation can continue, but source changes and privacy revocations invalidate dependent replay. Preferences and durable activity evidence follow existing adaptation consent; raw private notebooks are never automatically read.

The assistant may guide and explain within policy; it has no authority to execute notebook code, accept its own proposals, write student files, mark work complete, or infer mastery. Students perform those actions themselves through supported controls. The author preview uses the same boundaries, with synthetic actions clearly identified in its receipt.

## Practical protocols and evidence

For Agent Harness Path, S13's rebuild audit and S14's cold acceptance/human pilot remain optional, with their authored prerequisites and assistance restrictions. The software can record preparation and after-the-fact evidence references. It cannot verify that a consenting human participated or that an unaided sitting was actually unaided. A test may simulate an interaction to check the interface and policy; it cannot claim the human activity occurred.

## Acceptance and maintenance

Acceptance uses fresh student homes, all fourteen reference lessons and twelve notebooks, both practical protocols, and a newly authored small course. It distinguishes reused evidence for unchanged behavior from new evidence required by changes to shared code, packaging, context, or presentation. Changed boundaries receive focused regression coverage; final installed acceptance is tied to exact artifact hashes.

Required observations include rendered surfaces and navigation, native checks, saved records/notebooks, assistant scope and permitted live responses, denied calls in restricted activities, restart, export/reset, and cleanup. A blocked browser or unavailable live provider is recorded as a missing gate, never replaced by source inspection or fixtures. These product checks do not establish student learning gains, universal accessibility, or teacher effectiveness.
