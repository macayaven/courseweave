# Local pilot review record

The product revision reviewed and installed is platform `5c06a3f0304466ffec40495cad827e27b4bb25b1` with course `776f64ae8ae5d1e4fceca3a93de89b9ebf446727`. The broad review covers original bases `07c882e5348c5dbe43b3c77db7d5523113111992` and `7e849558de4d19ffdf4f245c3a9045b96361bb78`, respectively. Any later commit containing this review record is documentation bookkeeping; the selected runtime and source artifacts remain explicitly bound to the product revisions in `.pilot/receipt.json`.

Final combined review: **ready for the first tester; 0 Critical, 0 Important, 0 new Minor findings**. All seven task gates are complete and the combined review is clean.

The seven implementation gates completed schema/progress, external identity/state, teaching runtime, Author transactions, retained Learner/native assistant, S01/S02 course content and assessment, then installed acceptance. Task7's installed pending-proposal privacy evidence gap was closed by two real installed reset/delete tests and independently re-reviewed with no remaining findings. No finding is parked.

Start with the [pilot guide](../README.md), [observed acceptance](../acceptance.md), [verification commands](../verification.md), and [design rulings and their costs](../rulings.md). The [complete final review](final-review.md) judges the combined result. The [protected-source receipt](protected-sources.json) confirms the original checkouts and pre-existing dirty files were preserved.

## Detailed local evidence

The owned ignored `.pilot/` directory retains the installed runtime, source archives, wheel/sdist, final receipt, original validation logs, browser screenshots and public/synthetic provider observations. It must be retained with the owned course checkout for the installed launcher to remain usable. First-test state is separate from acceptance state.

The original plan's top-level reports, review packages, logs, screenshots, decision ledger and supporting inputs are preserved verbatim under `.pilot/evidence/review-archive/`, with a SHA256 inventory. Historic reports name their original temporary paths; the same filenames are available in that archive. Ephemeral dependency caches and generated test-fixture directories are not part of the retained evidence. The source history and committed regression tests preserve their reproducible inputs.

No tests, builds or live-provider calls are repeated for this documentation-only record. The selected artifact's full and covering validation, limitations and exact hashes remain in the acceptance guide and receipt. Actual learning outcomes, study durations, screen-reader behavior and live tool support are not inferred from product smoke checks.

Both owned branches and worktrees remain local for the first test. The original platform, protected companion and divergent worktree were not modified. No merge, push or publication is part of this handoff.
