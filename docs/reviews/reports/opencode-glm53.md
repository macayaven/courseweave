I have the context and the five authoritative inputs. Now let me examine the actual repository state to ground the review in facts (current files, existing progress, versions).
Repo state confirmed: `courseweave` is plan-stage (initial commit + docs only), the tutor fork is clean, and the protected `agentic-harnessing-companion` checkout is indeed dirty. Now let me ground the adapter-mapping and serving questions in the actual course tree, and verify library facts.
Course tree facts confirmed (relative links in generated HTML, GCS video URLs, 12 notebooks, 12 lab protocols, no S13/S14 notebooks). Now verifying the library-boundary facts: Pydantic AI's AG-UI integration, AG-UI package names, and JupyterLab 4.6 prebuilt-extension build requirements.
Pydantic AI's AG-UI support is confirmed mature (`pydantic-ai-slim[ag-ui]`, `AGUIAdapter.dispatch_request`, native tool-approval interrupts — which map closely onto the proposal lifecycle). Now checking the AG-UI client SDK and JupyterLab 4.6 prebuilt-extension build constraints.
JupyterLab 4.6 facts confirmed (new `jupyter-builder`/`@jupyter/builder` toolchain, Rspack, no setuptools at runtime). One more check: the AG-UI JS client package, plus the local toolchain versions.
# CourseWeave Architecture & Implementation-Plan Review

**Inputs reviewed:** `docs/superpowers/specs/2026-09-01-courseweave-platform-design.md`, `docs/superpowers/plans/2026-09-01-courseweave-platform.md`, tutor repo `AGENTS.md`/`README.md`/`COURSE-MAP.md`, plus repo-state inspection of all three checkouts and current library documentation (Pydantic AI AG-UI, AG-UI JS SDK, JupyterLab 4.6 migration guide). Read-only; nothing edited, committed, or installed.

**Verified environment facts:** `courseweave` repo is plan-stage (initial commit + docs only). Tutor fork is clean; protected `agentic-harnessing-companion` checkout is dirty (as the spec assumes). Local toolchain: Python 3.11.14, Node 22 (plan says Node 20), pnpm 10.32.1, uv 0.11.19. JupyterLab 4.6.0 is real; its extension build toolchain moved to `jupyter-builder`/`@jupyter/builder` with Rspack, and 4.6 dropped `setuptools` at runtime.

---

## Critical findings

**C1. No course-content file-serving route exists in the spec.** Spec §10 lists only `/api/*`, `/learn/`, `/author/`. The Learn reader and Author preview must render lesson HTML, lab Markdown, and stream video — content that lives in the course repo, not in the platform. JupyterLab's own `/files/` API is unreachable from the guide iframe (different origin, plus auth), and video playback needs HTTP Range support. Generated lesson HTML uses *relative* links (`../labs/s01_loop.md`, `../notebooks/s01_*.ipynb`, sibling `SNN-*.html` — verified in `lessons/S01-agent-loop.html`), so any file route must mirror the course-root path structure. **Required:** a jailed `GET /files/{course-relative-path}` route (path-jail after symlink resolution, deny `.courseweave/` and dotfiles, correct MIME, Range/206 for video), plus a defined behavior for cross-surface relative links (viewer intercepts links to mapped surfaces and routes them to the dashboard/JupyterLab open). Without this, Tasks 5, 6, and 9 are unimplementable as written.

**C2. Lesson-HTML rendering inside JupyterLab is asserted but never designed.** Invariant 1 and §12 ("opens course paths through JupyterLab's document manager") collide with the fact that JupyterLab 4.6 has no built-in HTML viewer — `.html` opens as raw text in the editor. This breaks the core "no context switching" claim for the single most-used surface (lessons). **Smallest correction:** declare a surface viewer inside the Learn app (guide rail/dashboard panel) that renders `html`, `markdown`, and `video` surfaces itself; reserve JupyterLab document-manager opening for `notebook`, `source`, and `terminal`. This also solves `video_seconds` reporting (see I1) and shrinks the bridge.

**C3. Teacher-thread persistence is unspecified.** Invariant 2 promises one continuous teacher and §2.7 implies "chat files" exist, but §8's state schema has no chat field, no task stores conversations, and AG-UI clients (`@ag-ui/client` `HttpAgent`) hold message history only in memory — a JupyterLab reload silently drops the thread. Pydantic AI's AG-UI docs explicitly recommend server-side history persistence for reload-safe, spoof-resistant continuity (client-held history is untrusted input). **Required:** thread/message persistence under `.courseweave/` with server-side `message_history` rehydration, a redaction test (credentials never in chat files), and an explicit statement in §8.

**C4. The `launch`/extension environment story doesn't close.** The prebuilt labextension must be installed in the *same* environment that runs `jupyter lab`. The course's own quickstart (`uv run jupyter lab` from the course venv) will have no CourseWeave extension, and nothing in Tasks 4/7/8 says which interpreter `launch` uses for JupyterLab or how the extension gets into it. Sibling-checkout resolution ("locate a sibling checkout or an installed courseweave") still needs an install target. **Required decision:** e.g., `launch` creates/uses a dedicated courseweave-managed environment (`uv tool install courseweave[jupyter]` or an on-demand `.courseweave/venv/`) and spawns `jupyter lab` from there; document that the course venv stays untouched. Without this, Task 8's "one-command optional launch" is unverifiable.

---

## Important findings

**I1. Video surfaces must be URL-based, not local paths (LFS trap).** `.lfsconfig` skips fetching mp4s on clone; local-path video surfaces fail `must_exist` on fresh clones — or worse, validate against LFS *pointer* files and then don't play. The generated lessons already stream the GCS replica. Task 8 should mandate `url` video surfaces (GCS), and `validate`/`doctor` should detect LFS pointer files (tiny file with the `git-lfs` spec header) as a warning. Related gap: `WorkspaceContext` identifies documents by `active_path`, but URL videos have no path — define how a video surface is identified in context (surface id or url) so resolver level 3 can match.

**I2. The proposal↔AG-UI contract is undefined.** The spec defines a REST proposal store and an AG-UI chat but never says how a teacher proposal appears in the event stream or how Accept/Edit/Reject round-trips. Pydantic AI's AG-UI tool-approval interrupts (`requires_approval=True` → `RUN_FINISHED` with interrupt outcome → resume payload `{approved, editedArgs, reason}`; needs `ag-ui-protocol >= 0.1.19`) map almost 1:1 onto Accept/Edit/Reject. **Recommend:** model proposals as approval-gated tools; the React drawer renders the interrupt and resumes; the REST store remains the durable audit/idempotency layer keyed by `tool_call_id`. Pin this contract in the spec before Tasks 3 and 5 diverge.

**I3. `command-success` completion has no mechanism.** Watching a JupyterLab terminal WebSocket for exit codes is fragile and untestable. Simplest coherent design: learner-consented, server-side execution of the *manifest-named* command (jailed to course root, timeout, captured exit code + output tail as the receipt). This preserves "no shell autonomy for the teacher" — the command comes from the manifest, not the model — and makes completion deterministic. Spec §5.3/§7 and Task 4 need this specified.

**I4. Same-path multi-phase ambiguity is acknowledged but not handled.** S01–S12 sessions will each have `predict` and `experiment` phases referencing the *same notebook path*; "first matching phase in manifest order wins" makes the later phase unreachable automatically. Specify: dashboard surface-opens always send `explicit_phase_id`; when an active document maps to multiple phases in the current module, either show a phase picker or deterministically prefer the current module's first *incomplete* matching phase (document whichever — purity is preserved either way since the rule is a pure function of state + context).

**I5. Single-process serialization is insufficient for the stated usage.** `serve` + `author` on the same course root (both are advertised entry points), or a stale server plus `launch`, give last-writer-wins corruption on `state.json`/manifest. Add an OS-level lockfile (`.courseweave/lock`) with a clear `busy` error, or enforce a single-writer rule at CLI startup.

**I6. Accepted file mutations have no undo path.** Atomic replace prevents torn writes, not regret; accepts write into a git-tracked course checkout. Cheap fix: copy prior bytes to `.courseweave/backups/<proposal-id>/` before applying, recorded in the audit trail. Also resolve the tension with invariant 8 ("course stays canonical") — the lab phase explicitly contemplates notebook diffs; one sentence in the spec should say canonical-content mutation is allowed only via the proposal lifecycle (or targeted copies).

**I7. Packaging: build-order and toolchain drift.** `uv build` won't run pnpm; Tasks 5–7 need one canonical build entrypoint (make/justfile or a hatch build hook invoking pnpm) and a CI check that the wheel build fails when built frontend assets are missing. The extension must use the 4.6-era template: `hatchling` + `jupyter-builder`/`@jupyter/builder` (4.6 no longer ships setuptools at runtime), and pin `jupyterlab >=4.6,<4.7` (4.7 upgrades xterm 5→6). Note the plan's "Node 20" should read "Node ≥ 20" (local machine runs 22; fine).

**I8. Provider/trust details worth pinning.** (a) The env names collide productively with the course labs' `OPENAI_BASE_URL/KEY/MODEL` — fine, but `doctor` should label them "teacher provider" so a labs `--live` setup isn't misread. (b) Use Pydantic AI `instructions` (not client system prompts) — the `AGUIAdapter` defaults already strip client-injected `SystemMessage`s; keep that default and keep capability enforcement server-side, as §7 already says. (c) `GET /api/context` semantics (what it returns absent a prior POST) are undefined; and there is no push channel for proposals created while another tab is open — state that v0 polls.

**I9. Watch-phase timestamp tracking requires the platform player.** Lesson HTML embeds GCS video links internally; timestamps clicked inside a rendered lesson can't be observed. Watch phases should present the manifest video surface in the platform player (which owns `video_seconds` reporting), with the lesson page as the accompanying text surface.

---

## Simplifications

- **S1 (with C2):** One surface viewer in the Learn app replaces "open everything in JupyterLab": the bridge then handles only notebook/source/terminal context — a genuinely tiny extension.
- **S2 (with I2):** Reuse AG-UI interrupts for the approval UX instead of inventing a parallel custom-event protocol for the drawer; the REST store stays as persistence/audit only.
- **S3:** `launch` should use process-group signal passthrough (`os.setsid` + group SIGTERM), not a hand-rolled supervisor. Ports, URLs, and the settings file are already enough plumbing.
- **S4:** The server-side stale-sequence check adds an error/edge surface for a single-user local app where the extension is the only context source; client dedupe by content hash is sufficient. Keep it only if it's nearly free (the tests are already planned).
- **S5:** Import/export in Author can be plain client-side serialize/`PUT /api/course` of the already-defined schema — no new endpoints.

---

## Missing tests

1. File-route tests: jail, symlink escape, `.courseweave/`/dotfile denial, MIME, Range/206 for video (C1).
2. Proposal-as-interrupt round-trip: interrupt outcome → resume approved / `editedArgs` / denied → store transitions, idempotency keyed by `tool_call_id` (I2).
3. Chat persistence: reload rehydrates thread; fake-gateway redaction test proving credential values never land in chat/state files (C3, §2.7).
4. LFS-pointer video fixture → validation warning/error; fresh-clone simulation with no LFS objects (I1).
5. `command-success`: exit 0 / non-zero / timeout → completion + receipt; jail (manifest-declared command only, course-root cwd, sanitized env) (I3).
6. Same-path ambiguity: explicit phase wins from dashboard; unknown path → general context (I4).
7. Two-process lock: concurrent `serve`+`author` write → clean `busy`/409, no corruption (I5).
8. Backup-on-apply: prior bytes recoverable after accept (I6).
9. Wheel-build guard: `uv build` fails without built frontend assets; `jupyter labextension list` in a fresh disposable venv (plan has the latter) (I7).
10. Watch-phase E2E: video timestamp drives context to the correct phase/segment (I9) — absent from Task 9's flow list.
11. Provider failure mid-SSE-stream: visible error, no state change, reconnect works (spec §9 asserts it; no test plans it).
12. Accessibility beyond "keyboard labels": focus in/out of the iframe, contrast, reduced-motion, narrow sidebar (spec §11 requires all four).
13. Empty-course E2E: author creates course from scratch → learn surfaces empty states (both apps in one flow).

---

## Recommended plan edits

1. **Spec §10 + Task 4:** add the jailed course-content file route (C1) with Range support; define `GET /api/context` cold semantics.
2. **Spec §11/§12 + Tasks 5, 7:** adopt the surface-viewer split — Learn app renders html/markdown/video; JupyterLab opens notebook/source/terminal; bridge scope shrinks accordingly (C2, I9).
3. **Spec §8 + Task 3/4:** add persisted teacher threads under `.courseweave/` with server-side history and redaction (C3).
4. **Spec §14 + Task 8:** decide and document the `launch` environment strategy (dedicated venv/`uv tool`), including where the labextension installs and proof the course venv is untouched (C4).
5. **Spec §7/§8.2 + Task 3/5:** pin the proposal↔AG-UI interrupt contract and `ag-ui-protocol >= 0.1.19` floor (I2).
6. **Spec §5.3 + Task 4:** specify manifest-named, jailed, consented server-side command execution for `command-success` (I3).
7. **Task 8:** mandate URL video surfaces + LFS-pointer validation rule (I1); state that dashboard opens always carry explicit phase IDs (I4).
8. **Task 2:** add lockfile/single-writer behavior and backup-on-apply (I5, I6).
9. **Task 7:** require the 4.6 extension template (`jupyter-builder`, hatchling), pin `jupyterlab >=4.6,<4.7`, add a top-level build orchestration entrypoint and the wheel-guard test (I7); change "Node 20" to "Node ≥ 20" and record actual versions in receipts.

---

## Go/no-go verdict

**Conditional GO.** The boundary is coherent and evidence-backed: `pydantic-ai-slim[ag-ui]` provides first-class `AGUIAdapter.dispatch_request` for FastAPI (including state, frontend tools, and approval interrupts), `@ag-ui/client.HttpAgent` is a framework-agnostic fit for React 19/Vite, and the JupyterLab 4.6 prebuilt-extension path is real — the "tiny bridge + iframe" instinct is right. Nothing found requires re-architecture. But C1–C4 are spec-level gaps that tasks 3–9 depend on, and the repo contains no code yet, so fixing them now is nearly free and fixing them later is expensive. Proceed once the four critical findings are folded into the spec and plan (all edits above are compatible with the existing task order and product invariants).
