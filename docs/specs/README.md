# CourseWeave specification set

**Bundle:** `author-edition-0.3.0-review-1` · **Date:** 2026-09-14 · **Status:** Approved; local V00–V10 acceptance complete on 2026-09-16. Public release status is recorded separately.

These are the three continuing product specifications. They describe shared rules, Author Edition, and its student compatibility target. Approval establishes intended behavior; [local acceptance](../pilot/author-edition-acceptance.md) records the implemented candidate and its observed limits.

| Read | Document | Owns |
| --- | --- | --- |
| 1 | [CourseWeave](COURSEWEAVE.md) | Shared terms, machine-readable facts, versions, authority, privacy, evidence semantics, cross-edition invariants |
| 2 | [CourseWeave Teacher Edition](COURSEWEAVE-TEACHER-EDITION.md) | The Author product, its six assistant roles, curation/research, editing/review, validation, preview, export/recovery |
| 3 | [CourseWeave Student Edition](COURSEWEAVE-STUDENT-EDITION.md) | Student behavior the authoring output must preserve, including tutoring limits, native checks, notebooks, protocols and progress |

Implementation sequence and file-level work are in the [Author Edition plan](../superpowers/plans/2026-09-14-courseweave-author-edition.md). The [custom GPT feasibility note](../superpowers/specs/2026-09-14-chatgpt-courseweave-feasibility.md) is a dated decision aid, not a fourth normative product specification.

## Approval and implementation boundary

The approved scope targets application v0.3.0, preserves the released v0.2.0 application and course, and exports the current schema-v2 student contract. The source researcher includes optional configured public discovery; the student tutor gains no new web or knowledge-base access. Fact review remains evidence-linked assistance with human decisions; it does not become mastery grading.

On 2026-09-14, the owner's “go on” following the plan handoff was taken as approval to prepare the fresh-session implementation and persistent-goal prompts. This records approval of this revision, including its six-role scope, optional Brave Search connector, compatibility and acceptance gates, and 40–65-hour planning estimate. Implementation starts in the fresh session when the owner sends its implementation prompt. No application implementation, provider setup, publication, or deployment occurs as part of preparing that handoff. This lifecycle update changes no normative requirement and retains the bundle ID.

## How consistency is maintained

Each normative requirement has exactly one owner: `CW-*` in the shared specification, `TE-*` in Teacher, or `SE-*` in Student. Edition requirements inherit shared constraints. An edition cannot override a shared constraint in prose; the shared requirement and all affected mappings must change together.

The shared specification's JSON fact block owns enumerations and version relationships. The product's executable manifest schema remains the runtime source of truth. The specification set states intended behavior and acceptance requirements; a discovered code/spec mismatch is an issue to resolve, not permission to rewrite recorded release facts.

Each requirement maps to named verification IDs in the plan. [Traceability](traceability.csv) is generated from the three requirement tables, not maintained as a competing set of requirements. [Consistency review](CONSISTENCY-REVIEW.md) records this bundle's mechanical and semantic checks. Those checks do not constitute product acceptance.

For every normative change:

1. Identify the owning requirement and impacted edition requirements.
2. Update the shared fact block if a shared value changes; increment the bundle revision in all three specs and the plan.
3. Update the author-to-student mapping and implementation/verification coverage.
4. Run document ID, fact, link, and trace checks; review authority, privacy, state transitions, and claims semantically.
5. State whether the change is already observed, newly proposed, or deferred, and name the compatible student version.
6. Update release/API documentation and affected tests during implementation. Require a three-spec impact entry in relevant PRs.

Implementation began on 2026-09-15. Task 1 adds `scripts/check_specs.py`, closed author-only contract types, and regression fixtures. The checker emits JSON on stdout and a readable summary on stderr. The [implementation notes](../author/implementation.md) separate completed source work from open installed and live-provider gates. No normative requirement changed in this lifecycle update.

## Cross-edition impact map

| Topic | Shared owner | Teacher obligations | Student obligations |
| --- | --- | --- | --- |
| Versions and schema | CW-001, CW-002 | TE-011, TE-012, TE-020 | SE-001, SE-018 |
| Content identity and assets | CW-003, CW-008 | TE-013, TE-014, TE-020 | SE-003, SE-004 |
| Local ownership and preservation | CW-004, CW-005 | TE-001, TE-015, TE-019, TE-023 | SE-004, SE-014, SE-017 |
| Assistant authority | CW-006, CW-007, CW-009 | TE-002, TE-003, TE-010, TE-011 | SE-007, SE-011 |
| Source policy and knowledge | CW-013, CW-021 | TE-004, TE-006, TE-007, TE-008, TE-025 | SE-008, SE-009, SE-018 |
| Evidence, factual claims and learning | CW-014, CW-015 | TE-005, TE-009, TE-016, TE-017, TE-028 | SE-005, SE-006, SE-012, SE-015 |
| Privacy and replay | CW-010, CW-012, CW-017, CW-018 | TE-003, TE-021, TE-026 | SE-008, SE-009, SE-010 |
| Optional/unaided activities | CW-016, CW-021 | TE-018, TE-027 | SE-011, SE-013 |
| Failure, offline/manual use, recovery | CW-011, CW-019 | TE-008, TE-015, TE-023 | SE-014, SE-016, SE-017 |
| Release and review | CW-020, CW-022 | TE-022, TE-024, TE-027, TE-028 | SE-001, SE-017 |

## Historical documents

The September 1 platform design and September 8 pilot design remain historical records of their implementation phases. Released schema/API behavior and exact acceptance receipts remain evidence for those releases. This approved bundle does not retroactively change them. This set is the continuing product specification for the author-release work; older designs should link here for current intent.

There is no assertion that prose analysis can prove the absence of all inconsistencies. The structure makes ownership and contradictions inspectable, catches mechanical drift automatically once its checker is implemented, and requires a bounded semantic review for the rest.
