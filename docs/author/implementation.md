# Author Edition implementation notes

Target: application v0.3.0; approved bundle `author-edition-0.3.0-review-1`.
Implementation began on 2026-09-15 from the public v0.2.0 baseline
`409f5c01e93d98f118967138116b0dbafff80ed7`. Required release gates remain open.

## Task 1: contract foundation

Added closed author-only models for project/selection/context, reviewed changes,
source research, separate model findings and human dispositions, compatibility,
exports, and student previews. Model drafts cannot provide a target path,
revision, mutation operation ID, human disposition, or compatibility pass flag.
Filesystem authority, transport enforcement, orchestration and persistence are
implemented in the subsequent plan tasks; the types alone do not grant them.

The shared schema and student runtime remain authoritative. This slice changes
no manifest schema, permission, progress or student state behavior.

Run `uv run python scripts/check_specs.py --root .` for a mechanical audit of
bundle headers, required facts, requirement ownership/references, verification
coverage, generated traceability, local links/fragments and balanced fences.
It emits JSON to stdout and a short summary to stderr. Semantic review remains
separate and no checker result is implementation or release acceptance.

Validation: the 90 existing manifest/Author API/store baseline tests passed.
The 24 new focused spec/contract cases passed after observed failing runs,
including undefined gates, duplicate owners, stale traceability, invalid links,
and attempted model authority fields. The audit covers 68 requirements and
11 gates. These are local development checks, not installed or live-provider
results. Final acceptance still requires both Python versions and exact archives.

## Three-spec impact review

The lifecycle headings and Task 1 checkboxes changed; normative requirement
rows, shared JSON facts, schema version 2, and requirement-to-gate traceability
are unchanged from the approved handoff. Shared authority remains one manifest
or one authored file per explicit apply; author state and model findings remain
separate from student state, compatibility decisions and human review. Source
research does not grant student retrieval. Neither objective coverage nor test
records prove mastery or real-world protocol completion. This is an implementation
self-review; the bounded independent review remains required in Task 11.

## Remaining work

Tasks 3–11, installed Author/Student journeys, actual public research, all six
real-provider roles, failure/recovery, rendered UI and independent final review
remain required. Source declarations and fixtures do not satisfy those gates.

## Task 2: released Student compatibility profile

The preliminary compatibility report now invokes the canonical structural and
runnable validators, with field-addressable structure/asset/profile sections
and explicit checks not performed. Its inventory hash is null until a stable
package inventory is checked; this draft report is not an export receipt.
Student v0.2.0 and candidate v0.3.0 share the unchanged released schema hash
`28ffd9b10fdcf4089e003db686924349c5fd488757de6f424bf11a26482d8839`.
Profile construction rejects schema drift, including disagreement with generated
canonical models. Workspace proposal declarations remain labeled inactive.

The Author inspector now derives enumerated choices from that canonical schema.
The new compatibility panel retains errors, omissions, target version and
actionable field links; a changed draft invalidates an in-flight result.
`POST /api/author/compatibility` is authenticated, bounded and read-only. It
accepts a manifest and an optional named Student version; callers cannot supply
pass flags. Manual compatibility requires no provider and makes no network calls.

Validation: 67 focused manifest/API/compatibility tests passed, including the
metadata rejection using a separate installation of the exact released v0.2.0
wheel. Its hash was checked against the existing public receipt. That check
exercises the released validator, not a complete learner installation journey.
Author typecheck and 31 affected frontend cases passed; the Author bundle built.
Required rendered/installed acceptance remains open. No shared manifest, engine,
policy or progress rule changed, and the approved normative specs/traceability
remain unchanged. Linked-asset closure and full packaging are Task 8 work.
