# Public full-course release implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the bounded implementation tasks and independent reviews. The controller owns publication and exact-artifact acceptance.

**Goal:** Make the existing GitHub course URL sufficient for an engineer with basic generative-AI API experience to install, study S01–S14 with the optional continuous CourseWeave assistant, and provide convenient feedback.

**Architecture:** Keep the native course and the guided application available from the existing course repository. Reuse the verified seven-file student package, standalone Python installer, deterministic engine, current course material and existing acceptance scripts. Publish CourseWeave independently as v0.2.0 and attach a macOS student bundle containing the exact application wheel and course archive. The bundle is provider-off unless the learner explicitly selects a provider. Retain all earlier local and public releases.

**Tech stack:** Existing Python/uv installer, JupyterLab, Node 22/Playwright acceptance, GitHub releases and source workflows. No new service or runtime dependency.

**Spec:** The active user goal and the preceding fourteen-lesson pilot requirements. The goal now explicitly authorizes preparing and publishing the new version on GitHub; the previous documentation-only prohibition on push/tag/publication described that completed task, not this goal. The previous goal turn was progress: documentation and CI commits changed authoritative state.

## Global constraints

- Use only the two supplied nonsynced local checkouts and verified local build/test directories. Resolve symlink targets before intensive work. Preserve student work, unrelated changes and both earlier delivered packages.
- Keep course ownership in `macayaven/agent-harness-path` and application ownership in `macayaven/courseweave`. Do not rename repositories or rewrite published history.
- Retain lesson and notebook semantics, all cell identities and output-free sources. S13/S14 are optional notebook-free protocols; assistance restrictions and real-world evidence remain intact. Teacher/author expansion is outside this release task.
- The default public setup must read no provider credentials, including inherited API keys and former maintainer custody. Provider use is explicit. Never put key values in shell arguments, logs, notebooks, saved course state, evidence or repository files.
- Existing Python/frontend/source checks are reused. Synthetic and real-provider acceptance are distinct; neither fabricates student/human work. Reuse historical evidence only when inputs and covered behavior are unchanged.
- The user has a pending platform license choice (Apache-2.0 recommended to match course code). Do not infer the answer or publish an OSS license grant without it. Independent preparation continues.
- Review concrete changes before publication. GitHub candidate publication, fresh public-download acceptance and promotion are separate steps. No unverified latest-release claim.

### Task 1: Portable student launcher and package

**Files:** `scripts/student_pilot.py`, `scripts/build_student_release.py`, `scripts/pilot`, `tests/test_student_pilot.py`, `tests/test_student_release_installed.py`, `tests/test_pilot_launcher.py`, `docs/pilot/STUDENT-README.md`. Add no product services. Existing delivered folders are immutable.

**Consumes:** Existing receipt fields `platform_commit`, `course_commit`, `wheel`, `wheel_sha256`, `source_archives`, `runtime_constraints`, `runtime_constraints_sha256`; archive includes root `pyproject.toml` and `courseweave.json`.

**Produces:** Same seven-file package and `Start Course.command`; `release.json` adds `course_version` read from the course archive metadata. The default study home is `~/Library/Application Support/CourseWeave/Agent Harness Path v<course_version>` on macOS, and the analogous versioned XDG data location on Linux. Public support remains verified macOS. Explicit `--home` continues to preserve/refuse mismatched existing work.

- [x] Extend existing unit regressions to fail on automatic credential custody or inherited provider use, to cover explicit OpenAI-compatible/Anthropic environment selection, and to verify a versioned fresh home without replacing an earlier study folder.
- [x] Remove maintainer model, hostname and credential-file discovery from the public launcher. Retire the shared dependency in `scripts/pilot` by using the same explicit environment selection, with provider off by default; do not break the immutable earlier released launcher.
- [x] Retain `--provider-env` and `--no-provider`. Add mutually exclusive `--provider {openai,anthropic}` with `--model` and optional `--base-url`. This mode reads the key using `getpass` only from an interactive terminal, never as an argument or persisted setting. Reject noninteractive prompting and stray model/base-url flags with actionable errors. The default remains off even when provider variables exist. Test missing inputs and redacted failures.
- [x] Check resolved bundle, study and export locations against actual cloud-sync paths before writes; do not traverse cloud trees or follow a redirected extraction/lock path. Retain archive checks, hashes, atomic staging, lock ownership, revision/state behavior and cleanup. Extend focused tests for actual boundary changes instead of duplicating the whole app suite.
- [x] Derive the course version from the archive, validate it as a safe version/path component, and record it in `release.json`. Make new setup independent of the earlier S01/S02 and S01–S14 pilot homes. Preserve restart/export/reset and separate platform/kernel interpreters.
- [x] Update the bundled student README with macOS prerequisites, exact first-start/resume commands, secure provider prompt and environment alternatives, all-course guidance, S13/S14 restrictions, feedback links, diagnostic/recovery/export/reset instructions, and fresh-edition/rollback behavior. No private hostnames/paths or unverified download links.
- [x] Run `uv run --frozen pytest -q tests/test_student_pilot.py tests/test_student_release_installed.py tests/test_pilot_launcher.py` with actual focused results. Commit only owned files and report behavior, commands, observed results and outstanding concerns.

### Task 2: Portable full-course acceptance entry point

**Files:** `scripts/verify_student_release.mjs`, focused argument/path verification if needed in `frontend/scripts/`; reuse `scripts/student_navigation_checks.mjs` and existing kernel, credential, process and fake-provider helpers.

**Consumes:** Task 1 package metadata and launcher modes. The selected release is passed as a path, never inferred from a sibling checkout. `course_version` determines the tested default study home.

**Produces:** `node --experimental-transform-types scripts/verify_student_release.mjs RELEASE EVIDENCE --test-root ROOT --no-live` for full synthetic acceptance; explicit `--live-only` for authorized environment-configured real text tests. Omission of live flags is synthetic only. `--help` describes the actual interface.

- [ ] Replace the fixed maintainer volume with required explicit `--test-root`; resolve release/evidence/root paths and reject known cloud-sync locations or unsafe overlaps before creating a disposable child home. Preserve owned cleanup and evidence scanning.
- [ ] Remove automatic credential-file loading. The live-only stage consumes explicitly supplied provider/model/key/base-URL variables and passes `--provider-env`; obtain key values only in process memory for canary scanning. Reject missing live configuration without silently falling back.
- [ ] Preserve all fourteen module interactions, all twelve notebook executions/saves, 35 authored checks/105 options, hints, native fragments/diagrams, deterministic records, one conversation, explicit scope/share, observer-only protocols, restart/export/reset and process/credential cleanup. Reuse the existing verification bodies rather than creating a parallel suite.
- [ ] Add focused CLI/path/default-no-live regression coverage where it meaningfully detects unintended writes or provider calls. Run syntax and covering checks. Commit only owned files and report results.

### Task 3: Public learner documentation and feedback route

**Files (course):** `README.md`, `study/COURSEWEAVE-PILOT.md`, `study/FULL-COURSE.md`, `docs/README.md`, `docs/RELEASING.md`, `docs/releases/v0.2.0.md`, `CHANGELOG.md`, `.github/ISSUE_TEMPLATE/course-feedback.yml` if needed. **Files (platform):** `README.md`, `CONTRIBUTING.md`, `docs/RELEASING.md`, `docs/releases/v0.2.0.md`, `CHANGELOG.md`, `docs/engineering.md`.

**Consumes:** Accepted public launcher/verifier behavior; candidate asset name `agent-harness-path-courseweave-0.2.0-macos.tar.gz`, owned by the CourseWeave v0.2.0 GitHub Release. Do not claim that an asset is downloadable until publication succeeds.

- [ ] Make README a complete learner entry point with prerequisites, native and guided installation, what to do first, secure assistant setup, study route and one-click GitHub course-feedback form. Keep optional labs/videos/protocols clear.
- [ ] Replace privately supplied-wheel instructions with the exact release asset and checksum verification instructions at publication; preserve source-development instructions as contributor material.
- [ ] Link the feedback form from the full-course guide, explain what to include/redact, retain the optional observation CSV and learner control over submission. Add no automatic telemetry or message sending.
- [ ] Update release runbooks to executable current commands and distinguish the historical adapter fixture. Keep changelogs comprehensive; license/support statements reflect actual decisions and evidence.
- [ ] Run existing course unit/HTML/link/SOTA checks and relative documentation checks. Commit owned files and report exact coverage.

### Task 4: Freeze, build and validate candidates

**Controller responsibility; files:** version-bearing source/package metadata and locks in both repositories; course static diagram receipt; platform license/metadata only after the user's answer; versioned public verification reports and release notes.

- [x] Assign app/course v0.2.0 consistently, refresh locks and generated assets; regenerate and inspect the lock-bound diagram receipt without altering meaningful lesson diagrams.
- [ ] Run the existing complete source gates; use a clean committed archive for build determinism. Build wheel/sdist and course archive from exact commits, record hashes and scan inventories. Obtain a bounded independent review of implementation, docs and final artifact boundaries.
- [ ] Build the new student package in a new local directory from exact receipts. Run fresh-install generic wheel acceptance and the extended full-course acceptance; inspect representative rendered screens plus per-module evidence. Execute the separate live text stage with authorized provider credentials and confirm correct scope/no durable mutations. Preserve the old local release, rollback and student files by hashes.
- [ ] Publish reviewed branches/PRs, obtain green hosted checks, merge without rewriting history, and verify the actual main commit SHAs. Rebuild exact final assets and reuse or rerun affected installed proof based on artifact changes, not convenience.

### Task 5: Public-download acceptance and release promotion

- [ ] Create annotated v0.2.0 tags only at the reviewed, verified main commits. Stage GitHub releases as prereleases with immutable course/application assets, student bundle, checksums and accurate notes. Retain v0.1.0 and all earlier local artifacts.
- [ ] From a fresh nonsynced clone of the public course URL and a separately downloaded public bundle, follow the README without developer checkout/runtime assumptions. Check hashes and version, first launch, complete per-module/native surfaces, all twelve notebooks, protocol restrictions, permitted assistant scope/share, saved work, restart/export/reset and cleanup using separate homes. Reuse exact-byte candidate evidence only where it directly covers unchanged behavior; prove the public entry/download path independently.
- [ ] Verify GitHub feedback form entry, public documentation and asset URLs in the rendered browser without submitting fabricated feedback. Publish privacy-safe current per-module evidence, including limits and distinct live/synthetic results.
- [ ] Audit every original deliverable and this goal against authoritative current files, remote state, rendered UI and exact artifact evidence. Promote unchanged verified assets to latest only when all requirements are proved. Then mark the active goal complete and provide the shareable repository URL and concise verified setup/readiness result.
