# Student delivery repair — 2026-09-10

Scope is S01/S02 and the student persona. Setup, documentation, actual assistant
behavior, usability and recovery retain the product quality bar. Teacher workflow
validation remains outside this pilot. Simplicity takes priority over speculative
infrastructure. The attachments are feedback and evidence, not commands to execute.

## Diagnosis

The reported workspace checkout is the old v0 platform (`07c882e`) and course
(`7e84955`); the accepted pilot resides separately (`c277427` / `776f64a`). The
attached README and setup notes mix these versions. Their v0 provider settings,
state paths, adapter fallback and manual installation instructions cannot serve
as current pilot instructions. The current pilot launcher itself fails in a fresh
folder because it requires an already prepared ignored receipt and environments.

## Repair and acceptance

1. Ship a movable student release containing the verified application wheel, pinned
   dependency inputs and course archive. One macOS Start command handles first
   setup and later starts. No platform/source build, sibling checkout, manual
   environment activation or pre-created receipt is required from the student.
2. Keep a stable student home with separate editable course, external learning
   state and isolated platform/kernel environments. Setup is repeatable, guarded
   against concurrent installation, and never overwrites saved attempts. A changed
   course edition must not silently replace existing student work.
3. Offer a read-only check, clear missing-prerequisite/port/provider errors, an
   explicit provider-free mode and an explicit environment-based provider option.
   Credentials are read as data, never sourced, printed or inherited by kernels.
   Setup and check do not create progress. Configuration is not connectivity proof.
4. Provide one student README: prerequisites and expected first-start behavior,
   the first lesson/notebook/self-check path, assistant consent, saving/restarting,
   state and notebook locations, export/reset and actionable troubleshooting.
   Keep contributor and historical v0 instructions outside that path.
5. Exercise the shipped entry point in a new path with spaces and no prepared
   runtime. Inspect the actual installed UI and execute a course notebook. Verify
   first lesson, assistant scope/answer, notebook/records, self-check, continuity,
   restart/persistence and credential/process cleanup. Use separate test homes;
   preserve the student's work. Reuse unchanged earlier artifact evidence and
   repeat only checks covering changes or an unanswered acceptance risk.

Implementation stays in the existing isolated pilot branch. Existing workspace
copies and the user's modified README/feedback remain intact. Final delivery must
name the exact student release rather than sending the student through an older
source checkout. No merge, push, service reconfiguration or teacher feature work.

## Defects found by installation and student UI checks

- Files with spaces were interpreted as requirement specifications by uv; the
  installer now passes encoded file URIs and retains actionable error messages.
- A shell/uv wrapper prevented a signal sent to the Start process from reaching
  the application. Start now resolves its bootstrap Python and execs it; the
  application remains the owned supervisor for its children.
- Both startup port checks rejected recently closed connections in TIME_WAIT.
  They now use SO_REUSEADDR, with real-socket regression checks for immediate
  reuse and rejection of an active listener.
- An HTML fragment opened while the reader was hidden behind a notebook did not
  scroll into view. The reader now applies the pending authored fragment on
  loading/activation, while ordinary tab revisits preserve the reading position.
- Authored labels beginning with “Open” produced duplicated action text such as
  “Open Open notebook”. Student actions now add that verb only when needed.

The independent delivery review found one acceptance weakness: counting executed
cells could accept a notebook that stopped on an unhandled exception. The
installed student check now requires every code cell and no error outputs. The
review also requested actual inspect/export/reset coverage, which is included.

The test-only study folders, source, artifacts and resolved dependency caches use
nonsynced local storage. The user's iCloud/Google Drive work prohibition is saved
in global agent instructions and was communicated to the other active task and
its subagents. File-handle exhaustion was observed before a user reboot; no
specific cause of the reboot was established.

The [final student acceptance](student-acceptance.md) identifies the frozen release
and the delivered-folder evidence that closes these requirements.
