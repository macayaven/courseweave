# Historical local pilot verification

This page describes the receipt-bound verification used for the local pilot. It
is not the maintained release command reference. Use the current
[release runbook](../RELEASING.md) for source gates, artifact construction, the
full-course verifier interface, explicit `--test-root` requirements and optional
live-provider configuration.

The local `.pilot/receipt.json` and `.pilot/evidence/` directories named by these
records were retained private artifacts. Public readers should use the versioned
[acceptance summary](acceptance.md),
[full-course acceptance](full-course-acceptance.md), and
[review](review/README.md); the public source distribution does not contain the
receipt, raw logs, screenshots or live answers.

## What the historical gate established

- The full Python and frontend unit suites and all four typechecks ran on the
  final local-pilot product code. Later narrow fixes received focused covering
  checks rather than an unneeded broad rerun.
- Build determinism used two independent `git archive HEAD` trees, pinned
  frontend dependencies and clean emitted outputs. A separate corruption test
  required the Lab build to repair stale emitted JavaScript. The sdist retained
  its frontend source, locks, configuration and Python build inputs while
  excluding dependency trees.
- The generic installed-wheel suite used a small synthetic course. The installed
  adapter suite copied an exact committed course archive into temporary custody,
  used external learning state and the course interpreter, and checked
  post-shutdown credential, process and source preservation.
- Native course checks preserved notebook cells and output-free sources. No
  native live lab was run. Remote HTTP availability and actual screen-reader or
  learner-outcome evidence remained outside acceptance.
- The authenticated course reader admitted only declared HTML and image paths,
  rejected traversal, symlinks, undeclared files and query variants, and kept
  scripts, forms, frames and unspecified connections disabled.

## Immutable S01/S02 fixture

The historical installed-adapter suite is pinned to course commit
`776f64ae8ae5d1e4fceca3a93de89b9ebf446727` and its recorded tree and manifest
digest. `COURSEWEAVE_ADAPTER_ROOT` only supplies a checkout of that exact fixture;
it does not retarget the contract to an arbitrary current course checkout.

The following command is retained solely as the immutable fixture invocation:

```sh
COURSEWEAVE_ADAPTER_ROOT=/absolute/path/to/pinned-s01-s02-course-checkout \
  pnpm --dir frontend run test:e2e:installed-adapter
```

The S01–S14 verifier is a different interface. Its current synthetic-only default,
required disposable root and deliberate live-provider environment are documented
in [RELEASING](../RELEASING.md#5-prove-course-and-state-compatibility).
