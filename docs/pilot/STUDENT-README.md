# CourseWeave — start your course

This portable student bundle contains the complete **Agent Harness Path, S01–S14**.
S01–S12 each have guided reading, a runnable notebook, predictions, attempts,
observations and self-checks. S13/S14 are optional practical protocols on a system
you own; they have no notebooks. A single Course assistant stays with you across
permitted activities. Teacher and course-author workflows are outside this release.

The `LICENSE` file in this folder covers the CourseWeave platform. The included
`course.tar` keeps the course's separate license, which appears as
`course/LICENSE` after setup. CourseWeave's third-party notices remain in the
application wheel. See the public
[CourseWeave licensing guide](https://github.com/macayaven/courseweave/blob/main/docs/LICENSING.md)
for an explanation; the license files control.

## Start

**Double-click `Start Course.command` in this folder.** Keep all the release files
together. Keep the release and your study folder on nonsynced local storage;
do not use iCloud Drive or Google Drive. You do not need either source repository,
a build command, Node,
environment activation, or a separate Jupyter installation.

The supported target is macOS. The launcher needs **uv** and internet for the
first setup. If uv is missing, follow the link it displays:
[install uv](https://docs.astral.sh/uv/getting-started/installation/).
The launcher installs isolated application and notebook environments and copies
the full course into a **new folder named for this course version automatically**.
Earlier study folders are retained. It displays setup progress, then opens an
authenticated local JupyterLab workspace in your browser. First setup can take
several minutes; later starts reuse it. Retrying an interrupted setup keeps your
saved work.

Keep the Terminal window open while studying. To stop, save your notebook and
press **Ctrl-C in that Terminal window**. Open the same Start command to resume.
Closing a browser tab alone does not stop the local services.

From a terminal opened in this release folder, the same entry point is:

```sh
./"Start Course.command"
```

## Your first session

1. In the CourseWeave guide, open **Read and trace the theory → Open Read the
   lesson**. The lesson opens beside the assistant. Start with its explanation
   and loop diagram. Course contents lets you revisit any required activity;
   optional activities and references are separate.
2. To ask about the lesson, choose **Use this lesson**, then type your question.
   The scope disclosure identifies the selected session. Navigating keeps that
   excerpt until you choose **Use this lesson** on the new reading or **Clear
   lesson scope**; check the S01–S14 label before asking about another lesson.
   Simply opening a file does not share its contents. Notebook **Share** is an explicit action
   for one request; it does not permanently share the notebook.
3. Open **Notebook: predict, attempt, observe**. Write a prediction before running
   the relevant code. Select a cell and press **Shift-Enter** to run it. Save your
   notebook with **Cmd-S**. Record the requested prediction, attempt and
   observation in the guide as you work; notebook saves and learning records are
   separate. The same assistant conversation remains available.
   If Jupyter asks for a kernel, choose **Course Python**, then **Select**.
4. Attempt the self-check before opening feedback. The guide shows which required
   activities have valid records. Merely reading a page or receiving an assistant
   answer does not mark an activity complete.
5. Continue through S12 when ready. The guide counts **36 required activities**:
   reading, notebook and self-check for each of twelve sessions. A notebook needs
   all three records, not just its prediction. Passing a check does not replace
   your reflection. Continue follows the next unrecorded required activity;
   Course contents lets you revisit or choose a different session freely.
6. Optional activities & references contains the hard labs and S13/S14. They do
   not block S01–S12. Lab commands are shown for you to run; copying a command never
   executes it. The notebook runtime needs no keys, network calls or paid model.

Write your prediction in the notebook **before** revealing the corresponding
solution cell. Several notebooks ask you to fill a function, choose a route or
label examples independently. **Run All** verifies that the demonstrations execute;
it does not complete those exercises. An empty attempt, a reference-label score or
an assistant-generated explanation is not your own independent work. Notebook
help becomes available after you save your prediction in the guide. Try an authored
hint first, and share a selected cell/output only if you want that evidence sent.

## The complete route

| Session | Practice in the notebook or protocol |
| --- | --- |
| S01 — The agent loop | Weather call IDs, message history, error handling and execution bounds |
| S02 — Golden sets and baselines | Fitness scope versus usefulness, fixture controls and honest metric labels |
| S03 — Context engineering | Concierge privacy, compaction, pinned rules and attention limits |
| S04 — Structured generation | Repair-shop parsing, schema validation, bounded retries and blinded labels |
| S05 — Consent gates | Mopbot approval/edit/reject, pre-action enforcement and visible degradation |
| S06 — Layered detection | Rental-inbox screening, classifier thresholds and false triggers |
| S07 — Bounded repair | Plant-shop feedback, resampling, anchoring and honest stop reasons |
| S08 — Observability and replay | Trivia traces, exporter recovery, strict matching and cassette exhaustion |
| S09 — Evidence reports | DIY report citations, event coverage and remaining limits on truthful claims |
| S10 — Error analysis | Recipe traces, hand-coded categories and failure-grown regression guards |
| S11 — Budgets and routing | Ledger-bot cost bounds, route comparisons and the local-content boundary |
| S12 — Judge calibration | Seeded defects, independent labels, false positives, agreement and kappa |
| S13 — Optional rebuild audit | An unaided core rebuild, suite comparison, forgot-list and delayed repeat |
| S14 — Optional ship and pilot | Cold acceptance/holdout, your own pilot page, consenting human and fixture evidence |

Static diagrams and foldable native self-check references work in the lesson
reader without scripts. Wide diagrams scroll horizontally so their labels remain
readable; focus the diagram region and use the arrow keys, or scroll sideways.
S01's optional **Course orientation** contains the Index, study plan and planning
references. Prev/Next navigation, lesson-to-notebook links and the self-check fragment
let you move through the material. A video is an optional Google Gemini Notebook
overview that may lag the text; it never replaces the notebook or protocol.

Study-duration labels are estimates, not timers or measured learning outcomes.
Keep the order when concepts depend on earlier sessions, but revisit freely.
The native lessons, optional labs and dated readings remain available in your
editable `course/` folder. Optional live labs require their own deliberate
credential/endpoint setup; replay is the starting point. The reference replay
demonstrates the supplied implementation, not that you finished the learner lab.

## S13 and S14: optional real-world work

**S13:** Reading needs S01–S02 vocabulary. Performing the audit needs a system you
own, the defended S02–S12 eval instrument and a banked baseline, or the trivia host
you actually built through the hard path. The installed course has no Git history:
prepare a separate nonsynced, versioned copy of your completed target before the
sitting. Preserve the canonical original, blank only the scratch copy, and follow
`course/study/S13-AUDIT.md`. Close the browser and assistant for the 60-minute
rebuild. The unaided activity also disables discussion and sharing. Save the
actual attempt before reviewing it. A planned week-later repeat is not a completed
delayed audit; record the actual delay when it happens.

**S14:** The authored prerequisites remain S01–S13 vocabulary/mechanisms and a
non-trivial system of your own, or your completed trivia host. Follow the activities
in order: prepare → cold acceptance and untouched holdout → write your pilot page
and invite critique → unaided human pilot → assemble evidence and review the claim.
Cold runs and the human pilot disable discussion/sharing. The assistant may critique
your draft before the pilot and review saved fixture evidence afterward; your final
words remain yours. A diagnosed fixture becomes a tuning case, so its green rerun
does not replace the untouched holdout.

Both practical sessions can be read and deferred. No notebook, synthetic test,
saved checkbox or assistant can stand in for your rebuild or a real consenting
adult. Review activities ask you to confirm that no unaided work is in progress
before discussion becomes available. The guide does not police other apps or
certify these external activities. Keep actual participant/session data private;
do not paste it into assistant chats or publish it. Public artifacts use fixtures.

Your records and notebooks survive a restart. The assistant conversation lasts for
the current application session. Learning memory is optional and starts disabled.
You can inspect it and review any suggested change before accepting it. No model
can silently mark your work complete or apply a proposed change.

## Assistant configuration

The assistant is **off by default**, even if your shell already contains OpenAI,
Anthropic or other provider variables. The launcher does not search for credential
files, inherit provider keys, or send a key to the notebook kernel. Reading,
notebooks, authored hints and self-checks remain available. This explicit command
has the same provider-free behavior:

```sh
./"Start Course.command" --no-provider
```

For the simplest provider setup, open an interactive Terminal in this folder and
select a provider and model. The launcher prompts for the API key with hidden input;
the key is used only in the launched process and is not saved in release, course,
state or settings files:

```sh
./"Start Course.command" --provider openai --model YOUR_OPENAI_MODEL
./"Start Course.command" --provider anthropic --model YOUR_ANTHROPIC_MODEL
```

Add `--base-url https://your-gateway.example/v1` only when your provider or
OpenAI-compatible gateway requires it. Prompt mode refuses noninteractive input so
a key cannot be silently read from a pipe or script. Never put a key in an argument.

For a credential manager, CI fixture or another deliberate environment-based
launch, set `COURSEWEAVE_PROVIDER` to `openai` or `anthropic`, the matching
`OPENAI_MODEL` / `ANTHROPIC_MODEL`, and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` is optional. Then run:

```sh
./"Start Course.command" --provider-env
```

Let the credential manager inject the key or use your shell's hidden-input feature;
do not paste it into course files or command history. `.env` files are not loaded.
The startup message distinguishes **configured** from **off**. Configuration alone
does not prove a connection; the connection is checked when you ask a question.
The bundled profile supports text answers. Live tool calling and arbitrary gateway
compatibility are not claimed by this release.

## Saved work and learning records

The default study folder is:

```text
~/Library/Application Support/CourseWeave/Agent Harness Path v<course-version>/
  course/       Your editable notebooks and course files
  state/        Learning records and preferences
  runtimes/     Isolated application and notebook environments
```

Your work is outside this release folder and outside the source repositories.
Keep the study folder to retain your work. For a separate trial, add
`--home "/absolute/path/to/another study folder"` consistently to your commands.
Opening a different course edition never silently replaces existing attempts.
Each new edition gets its own versioned default folder. To roll back, stop this
edition and open the Start command from the earlier bundle; its version metadata
selects its earlier study folder. Do not point one edition at another edition's
home, and do not run both on the same port. An explicit `--home` that already
contains a different edition is refused without replacing notebooks or records.

After stopping the running course, you can inspect or export learning records:

```sh
./"Start Course.command" inspect
./"Start Course.command" export --output "$HOME/Library/Application Support/CourseWeave/courseweave-records.json"
```

Export requires a new filename. It includes learning records, not your notebook
files or the raw conversation. Back up your `course/` folder separately if you
want to preserve notebook answers. To clear learning records/preferences while
keeping saved notebooks, use the guide's learning-memory controls, or stop and run:

```sh
./"Start Course.command" reset --confirm
```

Do not delete arbitrary hidden directories to reset progress. Provider/gateway
logs have their own retention policy; clearing CourseWeave memory does not delete
upstream logs.

## If something goes wrong

Run the safe check from this folder:

```sh
./"Start Course.command" check
```

It checks release files and the installed environments and reports the study
folder and assistant configuration without printing keys or making a model call.

| Symptom | Next step |
| --- | --- |
| First setup fails or was interrupted | Check internet access and disk space, then open Start again. It retries setup and preserves saved work. |
| Port 8765 is occupied | If your course is already open, use that window. Otherwise stop the prior Terminal with Ctrl-C, or start with `--port 8766`. |
| Browser did not open or the guide is missing | Keep the startup error visible; run `check`. In an open JupyterLab, use View → Activate Command Palette → **Open CourseWeave Guide**. |
| Assistant is off | Use the configuration section above, or continue with `--no-provider`. Your course and records remain usable. |
| Assistant request fails | Read its error, check the configured endpoint and retry deliberately. Failed responses do not complete activities or change records. |
| Guide is waiting for current context | Use **Reconnect** in the guide, or **Open CourseWeave Guide** from the command palette. Your current conversation and draft remain while context is confirmed. |
| Release files are damaged | Use a fresh copy of the release. Keep your separate study folder. |
| A different course edition is detected | Keep the existing study folder. Use a new `--home` folder for the other edition; your existing attempts are not overwritten. |
| A cloud-synced location is rejected | Move the bundle or choose a study/export path on nonsynced local storage, then run the same command again. |

For feedback throughout all fourteen sessions, use `course/study/FULL-COURSE.md`
and copy the observation template to your own nonsynced notes folder. Record the
session/activity, confusing step, actual versus expected behavior, help used and
whether feedback exposed an answer too early. No secrets or raw-chat export are
needed. Missing results, usage and cost stay marked unavailable.

Report a [course-content problem](https://github.com/macayaven/agent-harness-path/issues/new?template=content-bug.yml),
[notebook failure](https://github.com/macayaven/agent-harness-path/issues/new?template=notebook-fail.yml),
or [dated-reference drift](https://github.com/macayaven/agent-harness-path/issues/new?template=sota-drift.yml).
For a reproducible launcher, bundle or CourseWeave application problem, use the
[CourseWeave issue tracker](https://github.com/macayaven/courseweave/issues).
Remove keys, private participant data and raw chats before attaching diagnostics.

The earlier `course/study/FIRST-TEST.md` remains a separate optional S01/S02
interaction and transfer exercise. Its immediate/delayed answer keys stay separate
from unaided attempts. It is not a substitute for complete-course student feedback.
