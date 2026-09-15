# CourseWeave Author Edition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after owner approval. This document authorizes no implementation by itself. Steps use checkbox (`- [ ]`) syntax for tracking. Use separate agents only when the owner or applicable instructions authorize them.

**Status:** Approved on 2026-09-14; implementation began on 2026-09-15. Required release gates remain open. See the [approval record](../../specs/README.md#approval-and-implementation-boundary). The fresh-session implementation prompt starts execution.

**Goal:** Deliver a complete local Author Edition with six useful assistant roles, reviewed content changes, source curation/research, deterministic compatibility checks, actual student preview, and reproducible course handoff.

**Architecture:** Extend the existing Author Studio and shared engine. Add bounded author-only services for project/content ownership, source research, review artifacts, and delivery. Keep a single manifest authority and the released schema-v2 student contract; do not add a second tutor, runtime rule engine, vector database, or autonomous agent framework.

**Tech Stack:** Existing Python >=3.11, FastAPI, Pydantic, Pydantic AI text provider adapters, JupyterLab, React/TypeScript, pnpm/Vitest/Playwright, uv, and the existing atomic storage/proposal mechanisms. Use Python standard-library file/network primitives where adequate; explicitly declare and pin any reused transitive HTTP dependency if imported directly. One optional Brave Search API connector; no new hosted CourseWeave service.

**Spec:** [CourseWeave](../../specs/COURSEWEAVE.md), [Teacher Edition](../../specs/COURSEWEAVE-TEACHER-EDITION.md), [Student Edition](../../specs/COURSEWEAVE-STUDENT-EDITION.md), and the [cross-spec index](../../specs/README.md). All belong to bundle `author-edition-0.3.0-review-1`.

## Global Constraints

- Exports targeting Student v0.2.0 MUST retain schema version 2 and pass the released validator as well as candidate validation. Author-only fields MUST NOT be inserted into that manifest.
- Existing course/module/phase/check/objective IDs and notebook cell IDs MUST survive import and unchanged export. Explicit identity edits MUST show their impact; no silent renumbering or migration is allowed.
- Active work MUST use verified nonsynced storage. Symlinks, path traversal, special files, and redirected destinations MUST fail safely at read/write boundaries.
- An assistant response MUST remain advice, a review report, or a pending change. Only an explicit human decision through the authoritative service may apply the shown revision.
- Each accepted change MUST target one manifest or one authored file, use an expected content hash/revision, and be atomic and idempotent. A collection of changes MUST NOT be described as one atomic transaction.
- Conversation history MUST be session-only. Persisted author reports or proposals MUST be deliberate artifacts with an explicit save action; saving one MUST NOT silently save its entire chat.
- Submission, file presence, an authored correct option, and an assistant's confidence MUST NOT be represented as demonstrated mastery. No chapter mastery gate is added in this release.
- Student-facing promises MUST be limited to capabilities enforced by the targeted student runtime. Author research rules, review rubrics, and prerequisite notes MUST NOT be presented as student-enforced retrieval or mastery controls.
- The product MUST expose what each compatibility/review status means and checks not performed. A human reviewer may resolve editorial findings but MUST NOT override structural incompatibility.

## Starting state and execution location

Inspected 2026-09-14: the local pilot checkout was clean at `d6a2e590175a55179d2d7e5f007a78a6f91d1800` on `codex/courseweave-continuous-pilot`. Published application v0.2.0 is `409f5c01e93d98f118967138116b0dbafff80ed7`; course v0.2.0 is `c90aa1d84d3b1b1c21a5d263de03c4cb198f55c6`. Verify these again before implementation; preserve intervening work.

Use a new nonsynced checkout/worktree in the owner's verified local education storage, on `codex/courseweave-author-edition`, based on the public application baseline or its reviewed public successor. The post-approval fresh-session prompt will supply the exact local paths. Read the worktree skill at execution time. Copy only the approved planning documents into that checkout; never merge or push the private pilot ancestry. Keep the source course checkout, current student homes, and all existing release folders untouched. The existing public-release clones are evidence/reference inputs, not implementation directories. Keep host-specific working paths in the private execution handoff, not public product documentation.

The local author target is the Mac Studio on macOS Apple Silicon. Python checks run on 3.11 and 3.12. Windows/Linux/DGX installed acceptance is outside this release, even if pure Python checks run there. Hosted multi-user operation is outside scope.

## Decision record and scope

**Chosen:** extend the existing Author Studio with one assistant and six explicitly selected workflows. This reuses working editing, validation, streaming, and review controls and keeps student compatibility testable.

**Alternative:** six autonomous agents with independent tools and memory. Deferred because separate orchestration and overlapping mutation authority add current complexity without proving a better author workflow.

**Alternative:** implement Author/Student as custom GPTs first. Rejected as the foundation: they cannot replace the local deterministic boundaries, and current OpenAI documentation announces retirement. A future plugin/app can be an adapter to the same backend; see the [feasibility note](../specs/2026-09-14-chatgpt-courseweave-feasibility.md).

This release includes real public source discovery when the optional search key is configured, not just a renamed chatbot. It includes manual URL/file research when it is not. It includes reviewed Markdown and notebook-cell edits, but not a rich HTML/diagram editor or arbitrary assistant shell execution. It includes coverage and prerequisite notes, but not mastery gating. The package profile names unsupported environments and does not silently promise them.

## Estimate and checkpoints

Planning estimate: **40–65 active engineering hours**, roughly **6–9 working days** allowing for normal review. This is larger than the earlier student release preparation: it adds product workflows, bounded research, authored-file mutation, and generic distribution. It is an estimate, not a completion timebox.

| Stage | Tasks | Estimated active effort | Reviewable outcome |
| --- | --- | --- | --- |
| Contract and project foundation | 1–3 | 7–11 h | Consistent specifications, frozen compatibility profile, safe project import |
| Content and assistant vertical slice | 4–5 | 10–16 h | Reviewed Markdown/notebook changes and six-role conversation on a real text route |
| Research and editorial review | 6–7 | 9–14 h | Bounded discovery, source evidence, claim review, proofreading, alignment view |
| Delivery and recovery | 8–10 | 9–15 h | Course export, real student preview, restart/restore and conflict handling |
| Exact release acceptance | 11 | 5–9 h | Installed author/student evidence and bounded independent review |

Re-estimate after Task 5, when the real-provider draft path has been exercised. Report a forecast outside this range promptly. Search API access and at least one live model route are prerequisites for their acceptance gates. A missing credential does not justify claiming a complete six-role release; finish independent work and report the remaining gate honestly.

## File ownership and interfaces

Keep the existing manifest/engine/store authoritative. New author modules are cohesive I/O boundaries; do not create a plugin framework or reorganize unrelated code.

| File | Responsibility |
| --- | --- |
| `src/courseweave/author/contracts.py` | Closed author project, role/context, source, change, finding, report, and receipt types; no student schema additions. |
| `src/courseweave/author/project.py` | Selected project import, private state, inventory, versioned backups, shared-lock coordination, and restart reconciliation. |
| `src/courseweave/author/content.py` | Per-file candidate assembly, notebook-cell preservation, before/after review, hash-bound atomic application. |
| `src/courseweave/author/assistant.py` | Six role policies, bounded server-selected context, text-only result parsing and candidate staging; use existing provider lifecycle/limits. |
| `src/courseweave/author/sources.py` | Source catalogue, optional search adapter, safe public text retrieval, provenance and policy checks. |
| `src/courseweave/author/quality.py` | Deterministic compatibility/coverage and citation-location checks; separate model judgments and human dispositions. |
| `src/courseweave/author/delivery.py` | Stable package snapshots, export receipts, isolated student preview and its owned process lifecycle. |
| `src/courseweave/author/api.py` | Narrow authenticated author routes, project selection, request validation, and error translation. |
| Existing `api.py`, `professor.py`, `store.py`, `cli.py`, `launch.py`, `jupyter_runtime.py` | Small integration seams only; preserve student behavior and reuse authoritative save/provider/launch paths. `launch.py` owns LaunchSupervisor, child environment filtering, ports, and cleanup. |
| Existing `frontend/apps/author/src/*` | Retain outline/inspector, learning fields, validation, streaming conversation, proposal review, and conflict UI. Add focused source, content, report, and delivery panels. |
| Existing release scripts plus new `scripts/build_author_release.py` | Versioned author launcher and generic course handoff, reusing verified student setup/recovery logic. |

The following signatures are the planned service boundaries. Their types are defined in Task 1. Internal implementation may change after code review, but an interface change must update dependent tasks and specifications together.

```text
create_project(source_root: Path | None, destination: Path, selected_paths: tuple[str, ...]) -> AuthorProject
stage_change(project: AuthorProject, context: AuthorContext, draft: ChangeDraft) -> PendingChange
assemble_notebook(notebook: dict, replace_sources: dict[str, str]) -> dict
apply_change(project: AuthorProject, change_id: str, expected_revision: int, request_id: str) -> ApplyReceipt
build_author_context(project: AuthorProject, selection: AuthorSelection, role: AuthorRole, source_ids: tuple[str, ...]) -> AuthorContext
parse_author_reply(text: str, context: AuthorContext) -> AuthorReply
research_sources(project: AuthorProject, request: ResearchRequest, search: SearchClient, fetch: FetchClient) -> ResearchReport
check_package(project: AuthorProject, profile: StudentProfile) -> CompatibilityReport
save_review(project: AuthorProject, report: ReviewReport, expected_revision: int) -> ReviewReport
export_course(project: AuthorProject, destination: Path, profile: StudentProfile) -> ExportReceipt
start_preview(project: AuthorProject, receipt: ExportReceipt, runtime: StudentRuntime) -> PreviewHandle
```

## Task 1: Establish the contract types and specification checks

**Files:** Create `scripts/check_specs.py`, `src/courseweave/author/__init__.py`, `src/courseweave/author/contracts.py`, and `tests/test_spec_consistency.py`. Maintain `docs/specs/*` and the existing contract documentation.

**Consumes:** approved three-spec bundle. **Produces:** versioned author-only types, document consistency checks, verification V00.

- [x] Extract the shared JSON fact block, document requirement rows, and verification IDs. Reject duplicate ownership, dangling references, mismatched bundle IDs, unmapped requirements, and missing required facts. Treat semantic analysis as a separate required review, not a regex guarantee.
- [x] Add the failing fixture below, then implement the checker and closed Pydantic author types. The checker must support `--root PATH` and report JSON plus a readable summary.

```python
def test_spec_checker_rejects_an_unknown_gate(tmp_path):
    import shutil, subprocess, sys
    from pathlib import Path
    shutil.copytree(Path("docs/specs"), tmp_path / "docs/specs")
    shutil.copytree(Path("docs/superpowers/plans"), tmp_path / "docs/superpowers/plans")
    target = tmp_path / "docs/specs/COURSEWEAVE.md"
    target.write_text(target.read_text().replace("| V00, V09 |", "| V99 |"))
    result = subprocess.run([sys.executable, "scripts/check_specs.py", "--root", str(tmp_path)], capture_output=True, text=True)
    assert result.returncode != 0
    assert "V99" in result.stdout + result.stderr
```

- [x] Define `AuthorProject` with resolved `course_root`, `state_root`, `project_id`, and `revision`. Define `AuthorSelection` with server-resolved course/module/phase/file IDs; `AuthorContext` adds hashes, role, selected source revisions, truncation notices, and request budget. Define `ChangeDraft` as a closed union of selected manifest-fragment replacement, Markdown replacement, and notebook-cell edits; target authority comes from context, never the model.
- [x] Define `PendingChange` with server ID, revision, target path, before hash, validated after bytes/hash, context digest, status, and validation issues. Define `ApplyReceipt` with operation ID and before/after hashes. Define `SourceRecord`, `ResearchRequest/Report`, `ReviewReport`, `CompatibilityReport`, `ExportReceipt`, `StudentProfile`, `StudentRuntime`, and `PreviewHandle` using the named states and bounds in the specs. `SearchClient.search(query, limit)` and `FetchClient.fetch(url, policy)` are narrow injectable transport protocols; production has one implementation each.
- [x] Run `uv run pytest tests/test_spec_consistency.py -q` and `uv run python scripts/check_specs.py --root .`. Expected: malformed fixture rejected, approved bundle passes. Commit this tested contract slice with its documentation.

## Task 2: Freeze and expose the actual student compatibility profile

**Files:** Modify `src/courseweave/author/quality.py`, existing `contracts/models.py` consumers and Author inspector/validation UI; create `tests/test_author_compatibility.py`. Preserve the released manifest schema bytes.

**Consumes:** StudentProfile and CW facts. **Produces:** V01 and the baseline consumed by packaging/preview.

- [x] Record baseline release/commit/schema hash. The inspected schema SHA256 is `28ffd9b10fdcf4089e003db686924349c5fd488757de6f424bf11a26482d8839`; verify it from the pinned public baseline before relying on it.
- [x] Extend existing author validation tests with a manifest that inserts an author-only field; both released and candidate validators must reject it. Add mismatch cases for unknown surface/check types, unmet phase gate IDs, and overlapping notebook selectors by extending current fixtures.

```python
def test_author_metadata_is_not_a_student_manifest_field():
    import json
    from pathlib import Path
    import pytest
    from courseweave.manifest import parse_manifest_data
    data = json.loads(Path("examples/minimal-course/courseweave.json").read_text())
    data["author_research_policy"] = {"network_enabled": True}
    with pytest.raises(ValueError):
        parse_manifest_data(data)
```

- [x] Implement profile checks by invoking existing contracts/engine functions. Derive form options from the canonical schema/profile. Label schema metadata with no operational student route, such as workspace proposal authority; never imply an assistant can execute/write because a declaration exists.
- [x] Expose separate `structural`, `assets`, `links`, `profile`, and `not_performed` report sections. No model can write these statuses. Keep advisory prerequisite notes and source research policy outside runtime fields.
- [x] Run `uv run pytest tests/test_manifest.py tests/test_author_api.py tests/test_author_compatibility.py -q` plus Author typecheck. Expected: existing valid examples remain valid; incompatible expectations are field-addressable. Commit the slice.

## Task 3: Create safe, recoverable author projects and inventories

**Files:** Create `author/project.py`, initial `author/api.py`, `tests/test_author_project.py`, and `frontend/apps/author/src/project-panel.tsx`; integrate the existing Author app and launcher selection.

**Consumes:** AuthorProject/contracts. **Produces:** V02 and the project used by all later services.

- [x] Add import tests before writes: source remains byte-identical; imported manifest/assets are copied; selected symlinks and special files fail; duplicate destination fails; excluded `.git`, `.env`, runtimes, state, and chats never copy. Cover the bounded traversal and size/file-count limits with small fixtures.

```python
def test_project_creation_never_replaces_source(tmp_path):
    from courseweave.author.project import create_project
    source = tmp_path / "source"
    source.mkdir()
    (source / "lesson.md").write_text("Original lesson\n")
    project = create_project(source, tmp_path / "author-project", ("lesson.md",))
    assert (source / "lesson.md").read_text() == "Original lesson\n"
    assert (project.course_root / "lesson.md").read_text() == "Original lesson\n"
    assert project.state_root.parent == project.course_root.parent
    assert project.state_root != project.course_root
```

- [x] Implement new/import flows with an inventory preview. Use the existing empty manifest draft for a new project; save only on direct author action. Limit initial inventory traversal to 10,000 files/1 GiB within the explicitly selected local root; individual model-readable files obey smaller context limits. Larger projects receive an explicit unsupported-size error, not a partial copy called complete.
- [x] Store author state adjacent to the course, using atomic JSON and immutable saved artifacts. Store references/hashes rather than duplicate all course bytes in every report. Reuse the existing course lock through a small public context-manager seam if necessary; do not reach across processes with an unrelated lock.
- [x] Add source metadata fields from TE-004 and separate `author_reference`/`student_material` decisions. Show unsupported extraction explicitly; preserve binary files without pretending the assistant read them.
- [x] Run `uv run pytest tests/test_author_project.py tests/test_author_api.py -q` and the new project-panel tests. Inspect first-launch and import screens. Commit the slice.

## Task 4: Add reviewed Markdown and notebook edits without student mutation

**Files:** Create `author/content.py`, `tests/test_author_content.py`, `frontend/apps/author/src/content-panel.tsx`; extend existing `proposal-review.tsx`, conflict controls, and `store.py` only for the shared lock seam.

**Consumes:** AuthorProject, AuthorContext, ChangeDraft. **Produces:** `stage_change`/`apply_change`, V03.

**Development status:** Content service/UI and crash recovery are implemented and verified. The two unchecked items below include export assertions: output-free source copies are verified through reviewed file apply, while actual export output clearing and missing-asset export rejection remain open for Task 8's generic packager. This records the dependency without weakening either assertion.

- [x] Add regression tests for reject/no-write, stale target, same request replay, two tabs, interrupted acceptance, and changed notebook cells. Notebook fixtures must contain untouched cell IDs, metadata, code outputs, and a selector referring to a named cell.
- [x] Implement validated assembly. Manifest fragment edits target the server-selected course/module/phase/learning node and compose into a full manifest candidate using current bytes. Reuse existing manifest replacement review/save. Markdown writes and notebook-cell changes may target only selected author files; arbitrary paths/scripts are denied.

```python
def test_cell_source_replacement_preserves_identity_and_other_cells():
    import copy
    from courseweave.author.content import assemble_notebook
    original = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
        {"id": "reading", "cell_type": "markdown", "metadata": {"tags": ["read"]}, "source": ["Predict first.\n"]},
        {"id": "attempt", "cell_type": "code", "metadata": {"tags": ["attempt"]}, "source": ["prediction = None\n"], "execution_count": None, "outputs": []}
    ]}
    before = copy.deepcopy(original)
    candidate = assemble_notebook(original, {"attempt": "prediction = 'my prediction'\n"})
    assert original == before
    assert candidate["cells"][0] == original["cells"][0]
    assert candidate["cells"][1]["id"] == "attempt"
    assert candidate["cells"][1]["metadata"] == original["cells"][1]["metadata"]
    assert candidate["cells"][1]["source"] == ["prediction = 'my prediction'\n"]
```

- [ ] Implement one-file atomic apply with a hash-bound journal: `prepared` records before/after hash and backup; replace/fsync the file; persist `applied`. On restart, an exact after-hash reconciles to applied, an exact before-hash remains unapplied, and any third hash is a visible conflict. Repeated operation IDs return the original receipt. A failed write cannot silently mutate the receipt to success. Extend the notebook tests through the actual file boundary to cover output-free export, original/student-copy preservation, unmatched cell IDs, and new-cell ID assignment.
- [ ] Expose exact diffs and separate structural/readiness status. A draft may temporarily reference missing assets; standard export fails until repaired. Do not promise atomic multi-file changes or automatically apply a sequence.
- [x] Run `uv run pytest tests/test_author_content.py tests/test_store.py -q` and focused proposal/content frontend tests. Verify keyboard rejection, conflict recovery, and preserved cell selection in the UI. Commit the slice.

## Task 5: Deliver the six-role assistant on the real text-only route

**Files:** Create `author/assistant.py`, `tests/test_author_assistant.py`, `tests/fixtures/author-evaluation-v1.json`; extend `professor.py`, `/api/author/guide`, existing `curriculum-thread.tsx`, shared turn metadata, and proposal review.

**Consumes:** server-selected project/context, existing provider lifecycle, stage_change. **Produces:** V04, text-only validated reports/drafts, and the first real-provider vertical slice.

- [x] Add contract tests for each role, selected activity/file mismatch, stale source, malicious quoted instructions, overflow, cancellation, malformed/truncated response, and provider failure. Reuse existing AG-UI transport tests rather than a second parser.
- [x] Replace full-course manifest prompt dumping with a bounded course outline plus the selected editable unit. Full manifest bytes remain available to the server for composition/validation. A large course must not fail merely because its entire manifest cannot fit into one model request.
- [x] Use the existing text completion route. Explicit draft/review actions request this closed envelope; normal conversation can remain prose. Parse only after a complete successful response, never from partially streamed JSON.

```json
{
  "version": "author-reply-v1",
  "role": "proofreader",
  "message": "The selected sentence confuses prediction and observation.",
  "findings": [],
  "change": {
    "kind": "markdown_replace",
    "text": "Write your prediction before running the cell.\n"
  }
}
```

- [x] Resolve the change target, before hash, authority, and source references from AuthorContext; the model cannot provide authoritative paths/revisions. Unknown citations or malformed changes produce a rejected draft with editable manual recovery. No repair loop, tool-profile requirement, or hidden extra provider request.
- [x] Show role, scope, selected source count, and omissions before sending. Changing the hat does not clear valid conversation by itself; a revoked source or changed content invalidates dependent replay. Saving a report/proposal does not save chat.
- [x] Run `uv run pytest tests/test_author_assistant.py tests/test_professor.py tests/test_teaching.py -q` and `pnpm --dir frontend --filter @courseweave/author test`. Then use an authorized real text-only provider to draft one lesson correction, reject it, request a new change, and accept the reviewed revision. Record sanitized provider evidence separately from fixtures. Re-estimate remaining effort and commit the slice.

## Task 6: Make source research and curation useful and bounded

**Files:** Create `author/sources.py`, `tests/test_author_sources.py`, `frontend/apps/author/src/source-panel.tsx`; extend author contracts/routes and provider setup documentation.

**Consumes:** project catalogue, research policy, SearchClient/FetchClient. **Produces:** V05 and source evidence for the assistant/reviews.

- [x] Test network-off behavior, allow/deny precedence, normalized path-prefix boundaries, redirects, duplicate sources, unknown dates, oversized/decompressed responses, timeouts, DNS changes, cancellation, and unavailable discovery. No live network belongs in the default test suite.

```python
# Policy assertions in the source-policy unit test, with public fixture addresses:
assert policy.permits("https://docs.example.org/course/intro")
assert not policy.permits("https://docs.example.org/coursework/private")
assert not policy.permits("https://docs.example.org/course/answers")
assert not policy.permits("http://docs.example.org/course/intro")
assert not policy.permits("https://127.0.0.1/course/intro")
```

- [x] Implement a single Brave Search adapter using its documented web-search API and separate secret input. Never scrape search-result pages. Keep discovery optional and show its configured state and cost responsibility without inventing prices.
- [x] Implement bounded public HTTPS text retrieval with DNS-validated connection pinning and TLS hostname verification. Deny private/reserved addresses at every connection and redirect; do not trust a precheck followed by unrestricted DNS resolution. A narrow standard-library HTTPS transport is adequate; no browser automation or cookie store is involved.
- [x] Enforce the exact TE research limits. Make search query content and source fetch policy visible, honor cancellation, and never automatically approve a discovered source. Preserve fetch failures as evidence rather than replacing them with model summaries.
- [x] Implement local text/HTML/Markdown extraction with source offsets and hashes, source review decisions, explicit inclusion in learner-facing material, and revoked/stale resource handling. Complex PDFs/images/video are attachment metadata or author-supplied text extracts, not claimed understanding.
- [ ] Run `uv run pytest tests/test_author_sources.py tests/test_author_assistant.py -q`. Perform one small real discovery run and one real allowed-source fetch using authorized credentials; record actual returned URLs and statuses. Confirm a denied origin causes zero transport calls. Commit the slice.

## Task 7: Add evidence-linked fact review, proofreading, and alignment

**Files:** Extend `author/quality.py`, create `tests/test_author_quality.py`, `frontend/apps/author/src/review-panel.tsx`, and `coverage-panel.tsx`; extend role rubrics and evaluation fixtures.

**Consumes:** exact source/target revisions, shared validator output, AuthorReply. **Produces:** V06, saved review artifacts, and objective coverage.

- [ ] Build a small deterministic evaluation corpus: supported statement, contradicted statement, insufficient source, nonexistent citation, changed source, ambiguous check, terminology drift, broken objective reference, and a requested unsupported mastery gate. Declare expected findings before running a provider.
- [ ] Validate every evidence reference against source ID, raw/extracted text hashes, extractor version, and quoted span. Store this provenance check separately from the model's `supported`/`contradicted`/`insufficient`/`not_checked` judgment and the human's disposition. The server initializes human disposition to `unreviewed`; model output cannot set or change it. The following is a saved finding representation, not an allowed model authority field set.

```json
{
  "claim_id": "claim-1",
  "judgment": "insufficient",
  "evidence": [],
  "explanation": "The selected reference does not establish this claim.",
  "human_disposition": "unreviewed"
}
```

- [ ] Add a course coverage table mapping each required activity/objective to prompts, hints/checks, selected source support, and reviewed gaps. Existing courses without objective metadata remain importable; the UI reports missing guidance rather than silently inventing it or changing required progress.
- [ ] Save, dismiss with reason, delete, and export review reports explicitly. Source/target changes mark dependent results stale. The compatibility role reads deterministic findings and only proposes repairs; it cannot author a pass flag.
- [ ] Run `uv run pytest tests/test_author_quality.py tests/test_author_compatibility.py -q` and frontend review/coverage tests. Exercise fact checker, proofreader, and compatibility reviewer with a real provider using the bounded corpus. Human-review every live result; keep deviations visible and fix material defects. Commit the slice.

## Task 8: Produce complete course packages and generic student handoffs

**Files:** Create `author/delivery.py`, `tests/test_author_delivery.py`, `frontend/apps/author/src/delivery-panel.tsx`; extend `scripts/build_student_release.py`, `scripts/student_pilot.py`, existing installed-release tests, and release documentation.

**Consumes:** exact working course/inventory and StudentProfile. **Produces:** V07, stable export snapshots, generic student launch path.

- [ ] Add a full-course no-op import/export test and a new small-course fixture. Compare IDs, unchanged source bytes, notebook metadata/cell IDs, static assets, native checks, optional status, and all included files. Reject missing linked assets, invalid fragments, LFS pointers, escaping paths, case collisions, and private-file inclusion.
- [ ] Compute a stable inventory under the course lock and copy approved files into a new staging directory using jailed reads. Recheck hashes before finalization to detect external-editor changes. Validate the snapshot, write hashes/receipt, then atomically finalize a new destination. Partial exports are never given a successful receipt.
- [ ] Keep packaging and readiness separate. A draft export is conspicuously labeled. Standard handoff blocks deterministic errors and records unperformed preview/editorial/environment checks; it cannot declare unsupported external dependencies verified.
- [ ] Generalize the existing launcher in the new release to choose study homes by sanitized course ID, course version, and package hash. Do not modify the already delivered Agent Harness Path launcher. Keep explicit provider opt-in, isolated platform/kernel environments, first-launch setup, restart, export/reset, and safe cleanup.

```python
# Assertions added to the existing launcher-installed test harness:
assert first_course_home != second_course_home
assert first_course_home != new_revision_home
assert existing_student_notebook.read_bytes() == existing_student_before
assert all("author-state/" not in path for path in exported_paths)
assert all(".env" not in path.split("/") for path in exported_paths)
assert receipt["student_compatibility_target"] == "0.2.0"
```

- [ ] Export a course archive plus a macOS student bundle using verified, pinned wheel/runtime inputs. Receipt identity is generic, not hard-coded to `agent-harness-path`. A Markdown-only course does not need a project `pyproject.toml`; a notebook course needs the declared runtime inputs. Reuse verified archive extraction, license copying, provider custody, and constraints handling.
- [ ] Validate exports using separately installed released Student v0.2.0 and candidate code. Run `uv run pytest tests/test_author_delivery.py tests/test_student_release_installed.py -q`. Commit the slice.

## Task 9: Replace implied preview with actual isolated student practice

**Files:** Extend `author/delivery.py`, `cli.py`, `launch.py`, `jupyter_runtime.py`, existing `frontend/apps/author/src/preview.tsx`; create `tests/test_author_preview.py` and `frontend/e2e/author-student-roundtrip.spec.ts`. Reuse `tests/test_kernel_launch.py` and `tests/test_jupyter_runtime.py` for supervision/relay boundaries.

**Consumes:** ExportReceipt/StudentRuntime. **Produces:** V08 and preview receipts.

- [ ] Preserve the current inert card preview and its label. Add an explicit actual Student preview action that uses a stable exported snapshot, unique home, port, process ownership record, and capability token.
- [ ] Use the existing student launch path and LaunchSupervisor. Do not embed a second renderer or recreate student policy in Author JavaScript. Preview shares no author token, private source catalogue, student state directory, or parent provider environment by default. Preserve the existing child environment allowlist so neither model keys nor the new search key enters the notebook kernel.
- [ ] Extend existing learner E2E helpers with the fresh authored course: navigate every surface, use keyboard controls, run the notebook manually through the supported UI, submit a prediction, reveal a hint, answer every native check, and enter/exit the optional unaided activity.

```ts
// Add to the real-backend round-trip journey, after entering its unaided phase.
await expect(page.getByText(/assistant.*unavailable|unaided/i).first()).toBeVisible();
await expect(page.getByRole("button", { name: /send/i })).toBeDisabled();
// The server receipt must independently show zero provider calls for that phase.
```

- [ ] Record package hash, student runtime version, exercised surfaces, manual notebook/check actions, synthetic versus real-provider usage, and unperformed work. Stopping preview cleans only the owned process; save or discard its test home explicitly. Keep real study homes untouched.
- [ ] Run the new preview tests and existing learner/native reader/Author keyboard tests affected by integration. Inspect actual rendered UI, narrow layout, citations/diffs, focus, errors, and return-to-author workflow. Commit the slice.

## Task 10: Complete restart, restore, conflict, and cleanup behavior

**Files:** Extend `author/project.py`, `content.py`, `delivery.py`, existing reconnect/conflict UI; create `tests/test_author_recovery.py` and extend `frontend/e2e/retained-recovery.spec.ts` where shared behavior changed.

**Consumes:** durable author artifacts and operation receipts. **Produces:** V10 and the complete recovery contract.

- [ ] Inject failure before file replace, after replace/before receipt, during source fetch, during export, and after preview start. Restart and reconcile from exact hashes/owned process records.
- [ ] Verify duplicate acceptance, stale manifest/file revision, external edit, two author tabs, changed source approval, deleted report, and canceled response cannot resurrect a rejected change or revoked context.
- [ ] Add author backup/restore as a distinct explicit operation. Backup includes selected author artifacts but no credentials/chat/student data. Restore always creates a new project; it never overwrites the working or student home. Report partial/incompatible archives before mutation.

| Injected failure | Required outcome after actual restart |
| --- | --- |
| Before file replacement | Original target hash; change still pending or explicitly failed; no success receipt |
| After replacement, before applied receipt | Candidate target hash; reconcile exactly once to applied; repeat request returns the same result |
| External edit before reconciliation | External target hash retained; visible conflict; no automatic rollback over the external edit |
| Export interrupted before finalization | No finalized successful export; staging is identified and removable |
| Preview startup interrupted | Only the recorded child may be reconciled/stopped; pre-existing user processes remain running |
| Source revoked or report deleted | No dependent replay or automatic reactivation; private backups are only restored through a new explicit project restore |

- [ ] For each case above, compare the original author source and separate student state/notebooks before and after, inspect durable receipts after reopening the application, and scan resulting artifacts for planted synthetic secrets. These are end-to-end fault tests, not tests of an isolated status helper.

- [ ] Test provider/search keys through the established protected input mechanism, request redaction, and child-process cleanup. Never delete or rotate the user's pre-existing credentials. Verify no test token in logs, reports, exports, browser storage, or persistent environment artifacts.
- [ ] Run `uv run pytest tests/test_author_recovery.py tests/test_store.py tests/test_student_release_installed.py -q` and affected browser recovery journeys. Commit the slice.

## Task 11: Build and verify the exact paired release

**Files:** Create `scripts/build_author_release.py` and `scripts/verify_author_release.mjs`; extend existing acceptance harnesses, README/CHANGELOG/RELEASING/SECURITY, CI, and `docs/pilot/author-edition-acceptance.md`.

**Consumes:** all prior gates. **Produces:** V09, release candidate, evidence and bounded independent review.

- [ ] Align application metadata to the approved next version, package all reproducible source/runtime inputs, and build a fresh Author bundle with **Start Author.command** and a complete README. Correct dated release-status guidance as part of this candidate's documentation; preserve historical changelog entries.
- [ ] Run the shared Python suite on 3.11/3.12, frontend typecheck/build/unit tests, and relevant installed/browser checks. Reuse established commands and fixtures. Repeat broad checks only after material changes or failures.
- [ ] Install the actual built archive into separate fresh test homes. Complete the full author journey on a new two-module Python data-validation course: approved instructor/reference material, one notebook, native checks, and an optional unaided protocol. Use all six roles with the real text-only route and real configured source discovery. Save/restart/export/restore. Do not create real-world completion claims.
- [ ] Import and export the exact Agent Harness Path baseline unchanged. Verify all fourteen rendered lessons and navigation, all twelve notebooks executed in test copies without unhandled errors, all native checks, S13/S14 interactions and restrictions, assistant scope, saved records/notebooks, restart, export/reset, and cleanup. Reuse prior evidence only for unchanged boundaries, with exact provenance and a rationale; changed package/context/reader behavior gets new installed evidence.
- [ ] Open generated course handoffs in separately installed Student v0.2.0 and candidate Student v0.3.0. Verify fresh setup and course-specific homes using the new generic launcher. Preserve all old packages and the user's original study workspace byte-for-byte.
- [ ] Obtain a bounded independent review of the immutable diff, all three specs, compatibility matrix, release receipt, and representative UI evidence. Review authority is evaluation, not auto-approval. Resolve material findings; record unresolved nonblocking limitations. Do not request public publication until the exact candidate and its evidence are reviewable.
- [ ] Record the final support scope and per-module/per-role coverage. No completion declaration while a required installed, real-provider, research, recovery, or compatibility gate is missing. The owner receives clickable launchers, READMEs, and concise verified results.

## Verification catalogue

| ID | Required evidence | Reuse and limits |
| --- | --- | --- |
| V00 | Three-spec fact/ID/link/trace checks and semantic cross-review | New documentation evidence; not implementation acceptance. |
| V01 | Released/candidate schema, policy, progress, and profile conformance | Extend `test_manifest`, `test_author_api`, `test_professor`, `test_teaching`; do not duplicate the engine. |
| V02 | New/import inventory, local path safety, source preservation, author separation | New behavior; source checks alone cannot establish installation. |
| V03 | Reviewed per-file/manifest edits, IDs, atomicity, CAS, idempotency | Reuse manifest/store/proposal tests; new authored-file cases required. |
| V04 | Six roles, context, privacy, text-only draft path, failure handling | Reuse stream/provider contracts; real-provider author evidence is new. |
| V05 | Live discovery/fetch, source provenance, deny rules, budgets, cancellation | Synthetic network-policy tests plus separate actual search/provider evidence. |
| V06 | Fact/proofreading corpus, evidence locations, human disposition, alignment | Model findings are not scientific truth or mastery evidence. |
| V07 | Full-course round trip, exact export inventory, links/fragments, source notebooks, private exclusions | New generic packaging plus existing artifact-preservation checks. |
| V08 | Actual student preview, all supported surfaces, native checks, keyboard/narrow layout, unaided gates | Extend real learner paths; existing inert Author fixtures do not satisfy this gate. |
| V09 | Exact archive installation, paired released/candidate student runs, per-module/per-role coverage, independent review | Preserve separate synthetic/live/human evidence and unchanged-behavior reuse rationale. |
| V10 | Restart, backup/restore, canceled/stale/racing operations, process and credential cleanup | Extend existing recovery evidence only where ownership/behavior matches. |

## Completion and handoff

The owner approved proceeding to the fresh-session handoff on 2026-09-14. Prepare a self-contained implementation prompt and a separate persistent-goal prompt carrying this approved revision, exact local paths, branch ancestry rule, preservation requirements, limits, acceptance gates, and honest completion criteria. Implementation begins when the owner sends that prompt in the fresh session. Do not create a goal, launch implementation, change provider settings, publish, or deploy while preparing the handoff.
