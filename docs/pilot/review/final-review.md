# Final whole-branch review

Reviewed 2026-09-09. This is the single combined final review of the accepted local pilot, covering both complete immutable ranges and their integration:

- Platform worktree: `07c882e5348c5dbe43b3c77db7d5523113111992` → `5c06a3f0304466ffec40495cad827e27b4bb25b1`.
- Course integration worktree: `7e849558de4d19ffdf4f245c3a9045b96361bb78` → `776f64ae8ae5d1e4fceca3a93de89b9ebf446727`.

The supplied complete-context packages, accepted spec and plan, global constraints, chronological rulings, acceptance matrix, Task 7 report including its fix append, scoped fix review, durable pilot documentation, receipt and retained evidence were the review inputs. Earlier verdicts were supporting context, not substitutes for source and integration judgment. Generated assets were assessed through their source, inventories, artifact correspondence, deterministic-build evidence and installed behavior.

## Strengths

- **Course authority is deterministic and separate from the assistant.** Canonical v2 contracts close identifiers, discriminators, record operations and authority fields; experience presentation cannot grant access. Progress derives from authored requirements and server-bound records rather than assistant assertions, check scores or UI labels. Digest binding distinguishes substantive changes from presentation edits and exposes stale/orphaned evidence. Optional/excluded activities, no-hint policy, provider gates and profile consent remain independent controls. The canonical schema copies and current runtime/client projections agree.
- **State and privacy boundaries survive the combined workflow.** External state identity, revision/CAS and explicit v1 preview/copy/import semantics avoid silently reinterpreting prior progress. The API binds current evidence, source, policy and privacy epoch to a run. Removal invalidates dependent replay and candidate authority while retaining the visible session conversation and unsent UI work. I traced both installed reset/delete cases through the test implementation and their actual recorded provider requests: the dependent record/question/answer chain was positively present before removal and absent afterward; genuine held actions and old reads did not restore authority.
- **The continuing assistant is implemented across native surfaces.** The retained Lumino widget, native source publisher, reader focus, context confirmation, React state and run attribution work together. Navigation during a held stream preserves the old turn's attribution and selects the new activity for the next run. Reconnect and Open guide recovery keep the same iframe/thread/composer and unsent proposal edit. Lesson grounding and native Share require explicit actions; workspace content remains bounded to one run and excluded from durable proposals and subsequent server replay. Incremental transcript announcements are disabled, with bounded terminal-status announcements and keyboard/narrow-layout evidence.
- **Author writes remain concrete review transactions.** Canonical fields and selected Learning are editable without granting the assistant direct mutation authority. Selected-activity candidates retain their exact source and unaffected siblings; proposal review, explicit accept/save, revision checks and byte-exact ETags preserve the intended boundary. Installed evidence exercises a scoped Learning candidate and a whitespace-only external edit conflict, not merely synthetic HTTP success.
- **S01/S02 contain substantive learning work.** The theory explains the client-owned loop, tool-call/result correspondence, execution bounds and controlled evaluation comparisons. Added notebook attempts start unanswered, preserve the original cells, and distinguish observable fixture behavior from general claims. Six required reading/notebook/self-check activities and optional labs are represented honestly; other modules remain accessible with explicitly limited guidance. Static S01/S02 diagrams have meaningful alternatives and checked provenance. Independent immediate/delayed transfer fixtures and separate keys preserve the documented attempt-before-feedback sequence and acknowledge the immediate-feedback confound.
- **Acceptance reaches the installed artifact and actual kernel.** The review did not rely on intended argv, a package import alone or a bare Ready label. The installed reader is authenticated, authorized, descriptor/path confined and script disabled, including explicitly admitted linked images without broadening Jupyter's generic CSP. Actual kernel evidence reports the course venv executable/prefix, the sole owned `python3` spec and false credential-presence flags. The final live browser answer cites the exact supplied lesson label and reaches Ready only after provider outcome metadata plus terminal success.

## Issues

### Critical — must fix

None found.

### Important — should fix

None found.

### Minor — nice to have

None newly identified that warrants a repair in this final wave. The previously deferred findings have the explicit dispositions below; they have not been silently dropped.

## Deferred findings and rulings

| Item | Final disposition checked |
|---|---|
| Earlier synthetic union-pointer concern | Closed: runtime validation removes synthetic union labels from field addresses; the retained regression asserts an actual field pointer. |
| Task 3 M1: measurable citation criterion | Closed: `tests/test_teaching.py:193` supplies the fixture-specific source label to both profiles and asserts it in the actual reply and selected model input. The final live browser receipt checks “Read the lesson” in assistant text, separately from surrounding UI. |
| Task 5 M1: deterministic revisit decline | Closed: the optional assistant control calls `decline_revisit`; server handling and installed journey evidence show no provider request or progress mutation. |
| Task 5 M2: Author color warnings | Closed: command-local normalization is documented; the retained required Author browser run contains no `NO_COLOR`/`FORCE_COLOR` conflict warning. Historical logs remain intact. |
| Task 6 M1: S02 overbroad opening/exercise wording | Closed at course `776f64a`: source and generated HTML describe bounded fixture comparisons, seeded latency stubs and no product-value/learner-outcome proof. |
| Task 6 M2: unencrypted kernel TCP warning | Explicit supported limitation: actual transport is TCP on `127.0.0.1`, with HMAC-SHA256 and a present key; payload encryption is not claimed. The warning is documented rather than suppressed, and actual course-kernel credential absence is recorded. |
| Task 7 M1: cross-filesystem copy warning | Closed: task-local `UV_LINK_MODE=copy` is documented and the final covering privacy/archive logs contain no hardlink fallback warning. No cosmetic-only suite rerun is required. |

All three chronological rulings are preserved with their reasons and costs if wrong in `docs/pilot/rulings.md` and implemented consistently: optional safe HTML fragments across schema/Author/Learn/Lab; provider-outcome-plus-terminal Ready semantics; immediate feedback only after a saved attempt, with a separate delayed key and acknowledged feedback confound. I found no parked Critical/Important finding or unaccounted material departure from the accepted pilot scope.

## Verification and evidence limits

I independently verified the immutable checkout identities and clean status, all **41** receipt-referenced hashes, all **27** generated-asset inventory hashes, the selected wheel's **44** `courseweave/` entries against current source, and the required frontend rebuild inputs in the final sdist. The canonical manifest/state schema copies match generated contracts after accounting for the JSON Schema dialect declaration. These were focused read-only checks; no full suite, build, native live lab or real-provider call was rerun during this review.

The retained evidence reports 740 final product-code Python tests, Learn 167 and Author 133 unit tests, all four typechecks, ten learner/native/recovery browser cases and sixteen Author browser cases. The later startup-restoration repair has 73 passing Lab tests including the real DockPanel regression. Generic installed coverage has twelve passing checks; the exact-course installed journey and the two final reset/delete cases pass separately. I inspected the assertions and relevant outputs for the acceptance-critical boundaries, including actual reader/kernel/native-sharing behavior, scoped Author acceptance, held privacy actions and stale response handling. These counts describe retained acceptance runs, not tests executed by this reviewer.

The selected wheel is `284a439589d311e1452261cb51fda5289289c60fd856f39b562f8b7266a2e7df`; the final fix sdist is `e98d4920a275e585717e5f9c431fcc571c8e2fa4712e938ca933e9f6255cabdd`. Both hashes match the receipt and retained bytes. The fix adds installed evidence without changing product bytes, and its rebuilt wheel is byte-identical to the frozen installed artifact.

The default `text-only-v1` live route is demonstrated. A tool-bearing live request failed, while synthetic tool conformance and installed Author review succeeded; those do not establish live tool support. Seven prior real completion requests are accounted for, including the unretained earlier stream and error cases. No genuine provider refusal, actual screen-reader session, native live lab, measured study timing, learning benefit or delayed retention result is claimed. S08 remote access remains unverified. Upstream gateway retention is distinct from CourseWeave's session-only replay policy. These limits are visible in the handoff and compatible with the accepted first-test scope.

## Recommendations

Proceed to the documented first-tester workflow using the pinned installed launcher and fresh user state. Preserve the receipt, source archives, evidence, rulings and review ledger before removing only the plan scratch. Keep later observations of usability, study time and transfer performance separate from the existing installation/provider evidence; no additional implementation or broad rerun is required by this review.

## Assessment

**Ready for the first tester? Yes.**

**Ready to merge? Yes for the reviewed local-pilot scope as a technical assessment; merge, push and publication are outside this review's authorization.**

**Reasoning:** The combined system meets the accepted deterministic-authority, continuous-assistant, explicit-sharing, native-course and installed-artifact requirements, with no unresolved Critical or Important finding. The remaining empirical and provider limits are accurately disclosed and do not prevent the intended local first test.

Only this report was written by the reviewer; no source, index, branch, global configuration or protected root was changed.
