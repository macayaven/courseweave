# Engineering standard

CourseWeave should be useful, dependable, and simple to change. Production quality
means that a stated operating scope can be installed, exercised, diagnosed,
updated, and recovered reliably. It is not established by a demo, a large test
count, a review verdict alone, or the adoption of additional infrastructure.

The currently demonstrated scope is a single-user local student pilot. The
[full-course acceptance record](pilot/full-course-acceptance.md) and
[bounded review](pilot/review/full-course-review.md) identify the tested artifacts
and their limits. No broader production or external compliance certification is
claimed.

The [three product specifications](specs/README.md) describe the approved Author
Edition scope and its student compatibility target. Implementation is in
progress; new requirements are not claims about the delivered release. Keep
shared, teacher/author, and student requirements consistent throughout that work.

## Keep the architecture small

- Keep the deterministic course engine and canonical contracts authoritative.
  Provider adapters and user interfaces must not implement competing course rules.
- Keep the existing local application and transactional state store unless a
  measured requirement calls for something else. Do not introduce services,
  queues, plugin frameworks, or generic orchestration for hypothetical scale.
- Share actual common behavior, such as the stream parser. Prefer small explicit
  adapters over a universal abstraction with many switches.
- Separate pure decisions from I/O and give state transitions one owner. Preserve
  necessary consent, concurrency, and recovery logic even when it takes more code.
- Extract or delete code when doing so reduces responsibilities or duplicated
  behavior. Moving a large function into several tightly coupled files is not,
  by itself, a simplification.

## Evidence required for a supported release

The release must name its supported platform and provider capabilities. Its
versioned instructions must reproduce an installation, the main learner and
author workflows, and failure/recovery behavior on that supported target.
Automatic checks must catch contract drift and regressions; installed-artifact
checks must connect the built package to actual user behavior.

State export, recovery and update procedures must be explicit and tested before
claiming them as supported. Diagnostics must make actionable failures visible
without exposing credentials or silently substituting apparent success.
Dependency changes need reproducible builds and relevant validation. A production
claim also needs observed operation over a declared period, with real failures
and maintenance work recorded rather than inferred from a short smoke run.

Provider conformance fixtures, real endpoint results, usability observations,
accessibility testing and learning outcomes are separate kinds of evidence. A
working result in one category does not stand in for another.

## Historical assessment, 2026-09-09

This bounded assessment adds an engineering/release lens to the completed local
pilot review; it is not another exhaustive source audit. Product evidence remains
bound to platform `5c06a3f` and course `776f64a` in the pilot receipt.

| Area | Observed state and implication |
| --- | --- |
| Core authority and isolation | Canonical contracts, deterministic progress, transactional state, explicit sharing, installed privacy/recovery and actual course-kernel separation have retained evidence. These are working foundations. |
| Live assistant | The configured text-only route worked. A tool-bearing live request failed; synthetic Author/tool tests do not establish live tool support. |
| Installation | Wheel/sdist provenance and installed checks exist. The convenience launcher still relies on a prepared ignored `.pilot/` receipt/runtime, local paths and machine-specific provider custody. This is a usable local handoff, not a general installer. |
| Automatic regression enforcement | Reproducible commands and pinned dependencies exist, but no CI configuration is checked into this repository. The current evidence is a recorded local run, not a continuing automated gate. |
| Maintenance complexity | `api.py` combines HTTP and session/run orchestration, `store.py` owns several persistence operations, and Lab `surfaces.ts` implements multiple native integrations. These are areas to watch when changing behavior. Their size alone is not proof of a defect or a reason for a broad rewrite. |
| Release operations | This acceptance does not establish a production upgrade/rollback procedure, a restore drill for that procedure, or sustained operation. Those claims remain open until demonstrated. |
| Product outcomes | Actual learner timing, learning gains and screen-reader sessions remain unmeasured. |

The root README now points to the current pilot rather than presenting the old v0
setup as the active entry point. The repository instructions make simplicity and
evidence-backed claims binding for subsequent work. Remaining release gaps should
be closed through the smallest change that addresses an observed need; they are
not a mandate to add infrastructure or rewrite the functioning core.

## Release-preparation update, 2026-09-13

The full-course student package now has exact-artifact acceptance for S01–S14,
twelve notebooks and both optional practical protocols. Its self-contained local
launcher prepares a separate study home, and its recovery checks preserve prior
student work. That evidence remains tied to the recorded local artifact; it does
not establish a generic public installer or teacher/author acceptance for this
release.

The repository now includes a source CI workflow using the existing Python and
frontend checks, carries consistent 0.2.0 application metadata, retains the
reproducible source inputs in its sdist, and has a portable provider-off student
launcher plus an explicit-provider interface. Local checks validate those
contracts; green hosted checks, exact candidate
artifacts, and fresh public-download acceptance remain release gates in
[RELEASING](RELEASING.md). The two historical installation and CI observations
above describe their dated assessment, not the current repository structure.
