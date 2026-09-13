# Historical local pilot evidence

This directory records the local CourseWeave pilot and its accepted artifacts.
It is a historical evidence index, not the maintained setup guide. For current
student setup and provider behavior, use the repository [README](../../README.md).
For current contributor verification, artifact construction and release gates,
use the [release runbook](../RELEASING.md).

The receipt names under `.pilot/` refer to local, receipt-bound development
artifacts retained by the original pilot custodian. They are not part of the
public source distribution and are not public-download evidence.

## Evidence map

- [Full-course acceptance](full-course-acceptance.md) records the exact course,
  launcher and wheel identities for the S01–S14 local student package, along with
  its synthetic and bounded real-provider limits.
- [Earlier local acceptance](acceptance.md) and
  [S01/S02 student acceptance](student-acceptance.md) preserve the prior installed
  browser, kernel, state, privacy and recovery results.
- [Historical verification](verification.md) explains how those receipt-bound
  checks were structured and distinguishes the immutable S01/S02 fixture from
  the current full-course verifier.
- [Design rulings](rulings.md) and the [review record](review/README.md) preserve
  the decisions, independent review and stated evidence boundaries.

## Course study references

The standalone [Agent Harness Path course](https://github.com/macayaven/agent-harness-path#quickstart)
remains authoritative for learning and feedback guidance. The accepted local
course artifact contains these guides:

- Full-course feedback guide: `study/FULL-COURSE.md`
- S01/S02 first-test protocol: `study/FIRST-TEST.md`
- Transfer rubric: `study/transfer/RUBRIC.md`

These receipt-bound guide paths are labels for the historical artifact, not a
claim that its unpublished course commit is already available from a public URL.

S13 and S14 remain optional notebook-free protocols. Their unaided phases do not
permit assistant help or sharing, and software acceptance does not establish that
a learner completed them. Save each unaided attempt before opening its permitted
feedback or review material; record premature exposure as assistance.

## Privacy and evidence limits

Historical live checks used public or synthetic course material with one
explicitly configured private endpoint. The public summaries omit workstation,
tester and provider-route identifiers. They retain the observed behavior and
exact artifact identities without publishing raw answers or credentials.

CourseWeave chat is session-only, but an upstream provider may retain requests
under its own policy. Current provider use requires the explicit configuration
documented in the root README; CourseWeave does not discover a machine credential
store. State exports omit raw chat and provider credentials. Remove credentials,
participant content, private project details and local paths from shared evidence.
