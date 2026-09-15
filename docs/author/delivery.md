# Course delivery

The v0.3.0 candidate exports a saved course snapshot and builds a generic macOS
Student bundle. Application and course versions are separate. Required final
Author/Student release acceptance remains in the [implementation plan](../superpowers/plans/2026-09-14-courseweave-author-edition.md).

## Review and export

1. Save your course and finish any pending content/source decisions.
2. In **Course delivery**, choose **Inspect handoff files**. The initial selection
   contains declared learner material, linked local assets, the course license,
   README and declared notebook runtime inputs. Review additional files explicitly.
3. Imported material requires an approved source, intended use **student material**
   and redistribution **include**. Private, hidden and runtime files are excluded.
4. Enter the course version and a new `.tar` destination in an existing nonsynced
   local directory outside the author project. Choose **Export reviewed course**.

The source files remain intact. Export clears notebook outputs/counts only in its
copy and preserves cell IDs, sources and metadata. Stable ordering and archive
metadata make the same selected content/version produce the same package hash.
An external edit or changed source decision invalidates the reviewed inventory.
An existing destination is never replaced, including a destination created while
export is running.

Standard handoff blocks deterministic structure, asset, link/fragment, license and
runtime-input errors. A **DRAFT** retains reported incompleteness and cannot become
a Student bundle. Neither kind grants an editorial, installed-environment or
learning pass. External URLs are not fetched during packaging.

`COURSEWEAVE-PACKAGE.json` contains the course identity, selected course-file
inventory, required directories and compatibility report. Its inventory covers
course inputs after output clearing; generated setup/metadata are additionally
covered by the whole-archive hash in the separate private export receipt.
`COURSEWEAVE-SETUP.md` explains the snapshot. Original provenance, review reports,
author paths, conversations and student records are not added to the archive.

Local Markdown heading fragments follow the installed Jupyter renderer: text is
case-sensitive and literal spaces become hyphens. A GitHub heading fragment can
therefore need an explicit source correction for Jupyter. Unsupported links are
reported rather than silently rewritten. Code blocks/cells are never executed or
treated as document links during these checks.

## Build and start a Student bundle

A complete Author installation supplies a verified Student input descriptor. For
development, start Author with `--student-inputs /local/student-inputs.json`:

```json
{
  "format": "courseweave-student-inputs-v1",
  "runtimes": {
    "0.2.0": {
      "wheel": "courseweave-0.2.0-py3-none-any.whl",
      "wheel_sha256": "ACTUAL_64_CHARACTER_SHA256",
      "constraints": "requirements.txt",
      "constraints_sha256": "ACTUAL_64_CHARACTER_SHA256"
    }
  }
}
```

Paths are relative to that descriptor's directory. Replace placeholders with
actual verified hashes; the descriptor rejects them as written. Candidate
`0.3.0` inputs use the same fields. The selected wheel's internal name/version
must match. The browser cannot substitute a wheel, constraints or hash.

For a saved standard export, select a configured Student version and a new
Student bundle folder, then choose **Build Student bundle**. The folder contains
**Start Course.command**, a standalone launcher, application wheel, pinned
runtime inputs, course archive, separate application license, README and a release
descriptor. The original Agent Harness Path-specific delivered folders are
unchanged. The repository builder is now `uv run python
scripts/build_student_release.py --receipt /local/receipt.json --output
/local/new-bundle`; it accepts one receipted course archive without hard-coding a
repository identity. The standard-library launcher is one installed resource,
also used by the repository entry point.

Start the bundle on local macOS with uv installed. Course ID, course version and
package hash select a distinct study home. Platform and notebook environments are
separate. A notebook course supplies root `pyproject.toml` and `uv.lock`; explicit
setup uses `uv sync --frozen --no-default-groups` in its isolated Python 3.12
kernel. Its lock must include ipykernel and satisfy that Python version. A
Markdown-only course needs no Python project. Setup never changes a lockfile to
hide a dependency failure. The bundle README documents provider opt-in,
check/setup, state export/reset, restart and preserved notebooks.

The source archive publishes atomically. A bundle's release descriptor is its
completion marker; interrupted setup/bundle recovery has separate acceptance in
Task 10. Do not claim a partial destination as a complete handoff. Final release
receipts identify the actual tested application and course bytes.
