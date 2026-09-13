# GitHub release preparation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent documentation tasks, followed by a bounded review.

**Goal:** Prepare the existing course and its separate CourseWeave platform for an honest, maintainable GitHub publication, with comprehensive changelogs and reproducible release instructions.

**Architecture:** Keep one canonical course in `macayaven/agent-harness-path`; retain the standalone route and make CourseWeave an optional interface. Keep application implementation and versioning in `macayaven/courseweave`. Documentation must distinguish the verified local student artifacts from a future public release.

**Tech Stack:** Markdown, existing GitHub issue/PR templates and course CI, JSON verification receipts, Python/uv, existing Node/pnpm checks.

**Spec:** User request, 2026-09-13: create the documentation and structure needed before pushing to GitHub; recommend same-repository versus separate-version publication; provide a comprehensive changelog. The user prefers the latest release of the existing course repository.

## Global constraints

- Work only in the two verified nonsynced local checkouts. Preserve the delivered student package, existing study work and rollback release.
- Prepare local changes only. Do not push, create remote PRs, tag, publish, rename a repository or change the delivered artifacts.
- The current public course is `macayaven/agent-harness-path`; `the-harness-way` in conversation does not authorize a rename.
- Recommend course `v0.2.0` as the next minor release, but retain `Unreleased` and defer version/date/tag changes until publication checks pass. Existing course `v0.1.0` is a tag; no GitHub Release currently exists for it.
- CourseWeave's published `v0.1.0` wheel does not support this schema-v2 pilot. Do not invent a download URL or treat the locally tested same-version wheel as the public release.
- Preserve the course's existing Apache-2.0/CC-BY-4.0 split and third-party notices. The platform currently lacks a license; its license choice is pending user input.
- Report local installed evidence and live text responses narrowly. No general production, accessibility, learning-efficacy, teacher-workflow or live-tool certification.
- Keep private paths, credentials, participant data and raw logs out of new public-facing evidence. Retain historical local evidence without treating its paths as portable instructions.
- Reuse existing checks; no tests that merely restate documentation text. Do not rerun the entire installed pilot for documentation-only edits.

## Task 1: Course documentation and contributor structure

**Files:** course `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md`, `LICENSE`, `study/COURSEWEAVE-PILOT.md`, `study/FULL-COURSE.md`, `study/FIRST-TEST.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/course-feedback.yml`, `.gitignore`, and new `docs/README.md`, `docs/RELEASING.md`, `docs/releases/v0.2.0.md`.

- [x] Rewrite `Unreleased` into reader-focused Added/Changed/Fixed sections covering all changes since the existing tag, preserving historical entries.
- [x] Make README/navigation and CourseWeave installation status accurate for an outside contributor. Keep the native route immediately usable.
- [x] Update all-diagram contribution guidance, full-course adapter coverage and privacy-safe feedback instructions. Preserve historical S01/S02 transfer protocols while removing personal-only wording.
- [x] Provide a release runbook and draft release notes: same repository, independent platform version, promotion gates, clean-tree/version checks, assets/checksums, migration and rollback.
- [x] Add the minimal contributor/review structure and license coverage for the new documentation; keep one source of setup and validation instructions.
- [x] Validate existing course contracts, generated HTML and local links; report exact commands and source/artifact boundaries.

**Interfaces:** consumes verified pilot identities and public GitHub state above; links to root-owned `docs/verification/student-pilot-2026-09-13.md` and `.json`.

## Task 2: Platform documentation and publication boundary

**Files:** platform `README.md`, new `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/RELEASING.md`, `docs/releases/v0.2.0.md`, and appropriate `.github` contributor templates. License text is added only after the user's choice.

- [x] Replace stale two-lesson entry-point claims with the complete student scope and distinguish public v0.1.0 from the compatible local pilot.
- [x] Document changes since v0.1.0, including schema-v2/state compatibility, continuous assistant/sharing, student setup and navigation fixes, without overstating current Author evidence.
- [x] Provide portable contributor/build/test commands derived from actual project scripts and a concrete public release checklist.
- [x] Document the pending distinct package version, publicly available compatible artifact, explicit provider setup, generic installer verification, license and automated release-gate requirements.
- [x] Use current public source and local tests to validate commands, links and the stated boundary; do not claim hosted CI ran.

**Interfaces:** separate platform responsibility; cross-links to the course release and existing exact-pilot acceptance record.

## Task 3: Public evidence and final pre-push verification

**Files:** course `docs/verification/student-pilot-2026-09-13.md` and `.json`; platform `.github/workflows/verify.yml` and `docs/engineering.md`; plan progress/review artifacts under the plan's ignored workspace.

- [x] Export a bounded, privacy-safe per-module acceptance record with immutable tested artifact identities, check counts, notebook/source preservation, optional protocols, live/synthetic separation, recovery and review limits.
- [x] Inspect both documentation diffs and local Markdown links. Reuse existing CI commands and check modified templates parse.
- [x] Obtain a fresh bounded review of the complete preparation diff; resolve material documentation contradictions and broken commands.
- [x] Verify the delivered package and protected student/rollback hashes remain unchanged. Commit the prepared changes locally and report the recommended release strategy, key documentation links and any actual publication prerequisites.

No release or push is part of this plan. A public publication checkpoint is not a claim that the already verified local student trial is incomplete.

## Verification and review record

- Course checks: 24 unit tests, a 16-page rebuild with no generated drift, 184 local HTML references and 98 SOTA rows passed. Notebook execution, diagram rendering and installed student acceptance were reused for unchanged inputs.
- Platform checks: 758 Python tests plus 18 subtests passed, one test skipped; frontend type checks, 378 unit tests and the Node 22 production build passed locally. Hosted CI has not run for these unpublished changes.
- New documentation links and YAML templates/workflow parsed successfully. The public per-module JSON counts match the retained exact-pilot receipts.
- Bounded independent automated review covered both documentation sets, public evidence and source CI. Its corrections addressed CI/tag order, committed inputs for build determinism, Chromium setup, the historical adapter pin, release-specific clone instructions and uv-managed interpreters. All material findings were resolved; the final minor draft/publication wording mismatch was corrected.
- Hash checks confirm the seven delivered files, seven rollback files, 173 original student course files and one state file are unchanged. The new default full-course study home remains uncreated.
- This preparation does not publish a release. Platform licensing remains pending the user's choice, alongside the distinct public package version, portable installer/verifier configuration, public-download acceptance and green hosted release checks.
