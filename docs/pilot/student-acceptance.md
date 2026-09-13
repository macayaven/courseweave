# Student release acceptance — 2026-09-11

The historical student release was accepted for another S01/S02 learner trial
through `Start Course.command` in the delivered `CourseWeave Student Pilot`
artifact. The [student README](STUDENT-README.md) was also present in that folder.
The default student study folder was still fresh; acceptance used disposable,
separate homes. For current setup, use the repository [README](../../README.md).

## Frozen delivery

- Application source: `b29d09e6a2a044e4def12873dc1765d72548be18`.
- Wheel SHA256: `098a9fcca59d2225fe1f0e64d29959e14616485d30e4b686659b0614b4138b54`.
- Course source: `776f64ae8ae5d1e4fceca3a93de89b9ebf446727`.
- Course archive SHA256: `b5450f55a164ef4f79ff9826ecc88716742761c17876fd123e7a09ecdf37e8a8`.
- Developer receipt: `.pilot/student-receipt.json`, including all delivered file
  hashes and archived application/course source inputs. The earlier
  `.pilot/receipt.json` remains historical prepared-checkout evidence.

## Verification against the delivered folder

| Requirement | Observed result |
| --- | --- |
| One entry point without source checkouts or prepared runtimes | Actual Start command installed the package into a new study folder with spaces and opened authenticated JupyterLab. |
| Repeatable setup | Fresh check created no study folder. Setup/check created no learning state. Repeated setup reused environments and preserved notebook edits. Installed test: 1 passed in 19.79 seconds; package downloads used the existing local cache. |
| Reading and explicit assistant scope | S01 lesson and diagram rendered. Use this lesson established scope. One real gateway answer cited Read the lesson, distinguished tool-call result obligations from ordinary text, and did not change learning records. |
| Native notebook runtime | S01: all 8 code cells executed; S02: all 7 code cells executed; no unhandled error outputs. The intended incomplete learner exercise remained Attempt pending. |
| Runtime separation | Actual kernel used the isolated course Python. Provider keys, the local capability and Jupyter token were absent from its environment. |
| Records and self-check | A synthetic prediction was saved. An incorrect self-check produced the authored corrective feedback. These checks did not falsely complete the required activities. |
| Reader navigation | Opening the self-check from the notebook made its authored fragment visible. Unit lifecycle coverage also checks preservation of ordinary tab revisit position. |
| Continuity and restart | The same conversation stayed available across surfaces during the first session. Immediate restart preserved the notebook edit, saved prediction and self-check attempt. The restarted session opened S02. |
| Inspect, export and reset | Shipped commands inspected and exported the recorded state. Confirmed reset cleared records and attempts while preserving the edited notebook. |
| Shutdown and credential handling | Both launches stopped with no surviving owned processes and no forced termination. No bootstrap/capability credential appeared in captured launcher output. |
| Documentation and storage | Student setup, configuration, first session, saving, stopping, restart, state locations, export/reset and recovery have one release README. Source, test homes, release and resolved dependency caches use nonsynced local storage. |

The final machine-readable receipt and deliberately captured UI images are under
`.pilot/evidence/student-release-final/`; its process log is
`.pilot/evidence/student-release-final.log`. Screenshots of the reading, notebook,
native self-check and S02 notebook were visually inspected.

Covering source checks passed: 57 Python tests, 74 Lab tests, 167 Learn tests, both
changed frontend typechecks and both frontend builds. Real-socket regressions
cover restart after TIME_WAIT and rejection of an active listener. Earlier
unchanged platform/course evidence remains in [the prior acceptance](acceptance.md).

## Review and limits

Two bounded independent reviews covered the delivery changes and the later
runtime/navigation fixes. The initial notebook-verifier finding was corrected:
acceptance requires every code cell and rejects unhandled errors. The requested
actual inspect/export/reset verification passed. The runtime review reported no
remaining actionable findings; its final-package and S02 execution conditions
are satisfied by the delivered-folder run above.

This is acceptance of the student software and delivery workflow, not evidence
of learning gains or completion of the exercises. Teacher workflows are outside
this trial. The demonstrated real gateway profile supplies text answers; live
tool-calling and third-party provider configurations are not established by this
run. Chat remains session-only, and local reset does not clear upstream logs.
