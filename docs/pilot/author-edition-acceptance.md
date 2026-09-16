# Author Edition v0.3.0 acceptance

**Local V00–V10 acceptance complete, 2026-09-16.** The
[v0.3.0 release record](https://github.com/macayaven/courseweave/releases/tag/v0.3.0)
separately records public artifact identities, hosted CI, download verification
and publication status. A Pre-release marker means that public gate is open.

## Frozen local candidate

Candidate 8 was built from `546a28c4d6c408c773ba1e1cc55885048b6c805c`.

| Artifact | SHA-256 |
| --- | --- |
| Author/Student v0.3.0 wheel | `fc2ce929a5c2aedfbe84a4044b858d4db75c50ca4b4d11a7d60e207b0324c9af` |
| Source distribution | `76be0eac435d8bea633ce7aafb7ec803d09002e9b5dcccd088ce8f47e3512377` |
| Author archive | `7be590288a928c791a3525e3b5bc0bd63a1deedd1fb40ef05783ce1be5197501` |
| Released Student v0.2.0 wheel | `03a387d705477cf733ce8191841e9a010259e55ec2cd8049a4c8cf979bfa2e9c` |
| Runtime constraints | `f3f44355667089c5d89bd14198428a4de3218165e473ce30575febd59f518cf7` |
| Reviewed Agent Harness Path course tar | `f0a1facf8f4cce2f50629792507aa58d55898f490ca2a58e33029d4c166a43f4` |

The public release is rebuilt from its final merged commit. Its release record
binds those resulting hashes to this candidate through member comparisons and
affected installed checks. Documentation-only changes do not silently replace
the frozen local artifacts. Private receipts retain commands, per-module/per-role
coverage, exact inventories, screenshots, rejected attempts and cleanup results;
private logs, credentials and learner data are not public release inputs.

## Required local gates

The [approved plan](../superpowers/plans/2026-09-14-courseweave-author-edition.md)
defines the gates. Tasks 1–11 are locally complete.

| Gate | Observed evidence |
| --- | --- |
| V00 | Three-spec consistency: 68 requirements, 11 gates, unchanged canonical schema and authority boundaries; bounded independent review. |
| V01 | Canonical schema-v2 validation and deterministic progress; released Student 0.2.0 and candidate 0.3.0 installed compatibility. |
| V02 | Inventory-bound import, explicit source selection, private projects, path confinement and preservation of original course/student work. |
| V03 | Exact per-file reviewed apply, preserved notebook cell IDs, stale revisions, idempotency and crash reconciliation. |
| V04 | Useful real text-provider observations for all six roles, explicitly saved reports/drafts and human-only apply; model limits below. |
| V05 | Actual authorized Brave discovery, explicit result selection, separate allowed public-page fetch and provenance. Request/outcome survives reopening and backup/restore; provider result URLs/titles/snippets do not. Denied-origin tests make zero transport calls. |
| V06 | Evidence-linked reports, checked exact quotations/offsets, coverage gaps, saved human dispositions and stale-source handling; factual truth remains separate. |
| V07 | Faithful course import/export control, separate disclosed one-link repair, paired generic handoffs, rights/exclusion checks and no original-file replacement. |
| V08 | Both installed Student previews; all 14 Agent Harness Path lessons, 12 executed notebooks and optional S13/S14; rendered desktop/narrow inspection. |
| V09 | Fresh Author archive installation and incomplete-runtime recovery, complete new two-module course journey, paired full-course evidence, immutable artifact comparison and bounded independent review. |
| V10 | Actual Author/Jupyter/preview crashes, two-tab conflicts, inspected backup/new-project restore, restart/export/reset and owned-process/credential cleanup. |

The final installed journey used a new two-module Python data-validation course:
Markdown/HTML, prediction, both native-check outcomes, an authored hint, notebook
Run All/Save and an optional unaided protocol. Both Student versions preserved
notebooks and observations across actual restart and records export/reset.
Author restore disabled editing while its real request was pending. Revoked
sources left the assistant's permitted selection; reapproval did not restore
permission. The final run scanned 83,529 test files and left zero owned processes.

## Evidence reuse and provider observations

Both complete Agent Harness Path runs cover fourteen lessons, twelve notebooks
with stable cell IDs and no execution errors, native checks, 108 local HTML
link/fragment clicks each, explicit scope/sharing, optional S13/S14 restrictions,
attestation gates, restart/export/reset and cleanup. Records are synthetic; no
learner or real protocol completion is claimed.

The full-course Student runs used Candidate 1. Candidate 1→2 changed only Author
assistant instructions and wheel RECORD; Candidate 2→5 changed only Author
static assets and RECORD. Candidate 5→8 changed only Author research API/storage,
Author bundle README generation, Author static assets and RECORD. All Student
runtime, schema, reader, launcher, kernel and state members remain byte-identical,
and both runs used the course tar identified above. Changed Author behavior has
separate final installed evidence. Candidate 6→8 Python is byte-identical.

All six roles have useful observations across Candidate 2's full run and explicit
curator/proofreader retry. Those provider/context/citation/review boundaries are
unchanged in Candidate 8. The curator initially confused one redistribution
decision; the retry omitted some requested metadata. Strict validation rejected
incorrect quotation offsets and a wrong role. The fact-checker prompt supplied
the intended judgment, demonstrating structured provenance rather than blind
factual accuracy. Candidate 7's source researcher citation was rejected. A
separate narrower Candidate 8 request produced useful message-only synthesis
distinguishing JSON parsing from application field validation; it requested no
findings or edit and does not demonstrate new citation accuracy.

Source checks include the earlier full Python 3.11/3.12 suites (1,138 passed each),
unchanged Lab/Learn suites, affected research/backup/release Python checks (102
on 3.11 and 95 on 3.12), and final Author tests (178), typecheck and build. Source
tests, synthetic providers, real-provider observations, automated UI inspection
and human learning are separate evidence categories.

## Independent review

One bounded independent review assessed the immutable diff, specifications,
artifact identity and representative installed evidence. Material findings were
fixed and affected checks repeated: source revocation, editing during restore,
recovery-wrapper layout and late research-history overwriting live results.
The final review recomputed artifact identities, matched 374 versioned source
members and 60 wheel/source overlaps, checked the six final SourcePanel tests,
and inspected installed discovery/reopen/backup/restore and visual evidence.
No actionable defect remained within that scope. It is not a general security,
production or legal certification.

## Preservation and support limits

- Supported observation: single-user local macOS arm64, Python 3.11 application
  and Python 3.12 course kernel, tested text-only provider route. Model-native
  tools, human learning gains and screen-reader sessions are not established.
- Agent Harness Path baseline `c90aa1d84d3b1b1c21a5d263de03c4cb198f55c6`
  contains an invalid native Markdown fragment in `labs/s01_loop.md`. The faithful
  export remains a draft. The runnable copy changes only
  `README.md#wire-contract-so---replay-matches` to
  `README.md#Wire-contract-%28so---replay-matches%29`; all other included bytes
  and the reference source remain intact. The native link opens the correct
  README in Jupyter's text editor; rendered heading scrolling is not established.
  All HTML lesson fragments were checked separately. Unreferenced video LFS
  pointers are excluded; explicitly including them blocks the handoff.
- Released Student 0.2.0 cannot authenticate local video playback. Candidate
  playback is fixed; paired standard handoffs enforce permitted HTTPS video.
- A dismissible Jupyter news notification can overlap the lower narrow viewport.
  Rendered inspection was performed by the implementing/review assistants.
- Earlier failed attempts remain recorded. One older verifier cleanup failure
  required identity-based termination of two owned processes; no real model or
  search key was selected, but its lost bootstrap value could not be scanned
  retrospectively. Final cleanup checks passed.
- Brave search is optional and uses each author's own credential/account. No key
  is distributed. Results are transient; retained publisher-source material has
  separate permission/redistribution decisions. Account terms and publisher
  rights remain the author's responsibility.
- CourseWeave uses PolyForm Shield; Agent Harness Path retains its separate
  Apache-2.0 software and CC BY 4.0 content licensing.
