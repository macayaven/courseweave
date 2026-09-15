# Try a course in Student

**Student practice preview** opens the installed Student application using a
saved course export. It has its own course copy, notebook environment and study
records. The inspector's **Preview** card remains an inert view of metadata.

1. Save your source edits and create a standard export in **Course delivery**.
2. Under **Student practice preview**, choose **Reload preview inputs**, the
   saved export and a configured Student version.
3. Leave **Use Author’s configured model in this preview** unchecked for a
   provider-free preview. Selecting it explicitly shares that configured model
   with this Student session; its normal usage costs and sharing rules apply.
4. Choose **Prepare Student preview**. The first setup installs the pinned
   platform and course dependencies. It needs uv, internet access and disk space.
   Preparation is an explicit execution step; structural checks never run code.
5. When ready, choose **Open Student preview**. Use the ordinary Student reader,
   notebooks, native checks and assistance controls. Notebook execution remains
   your action. Wait for the native kernel status to show **Idle** before running
   code. The preview uses the snapshot even if you later edit Author files.
6. Return to Author and choose **Stop Student preview**. Record only the surfaces
   and actions you checked. Readiness means the application started; observations
   are your report, not an automatic compatibility, mastery or completion pass.
7. Choose **Keep preview files**, or **Discard preview files** and confirm. Stop
   retains the files by default. Discard removes only the identified preview
   folder; its record remains in the Author project.

One preview may run per Author home. Another project's active preview must be
stopped before preparing a new one. Each preview has a unique folder beneath
`author-home/previews/`, outside the working Author project. Its `study/course/`
holds the notebook copies and `study/state/` holds practice records. The adjacent
bundle provides the ordinary **Start Course.command** launcher. Author reports
retain package hash, Student version, status and explicit observations.

Author sources, private reviews, conversation and application credentials do not
enter the course snapshot. The default preview does not inherit the parent
provider environment. Explicit model sharing passes only that model configuration
to the Student supervisor. Search credentials and application tokens never reach
the notebook kernel. Preview readiness and browser tokens stay in memory.

At narrow widths, close Jupyter’s file browser and use the **CourseWeave** right
sidebar tab to alternate between the guide and notebook. Reading code side by
side with the guide is most comfortable in a desktop-sized window.

## Compatibility and recovery

Released Student v0.2.0 and candidate v0.3.0 use the same schema-v2 rules. A
verified reader difference remains: v0.2.0 cannot authenticate a local video's
media requests under the pinned Jupyter runtime. Candidate v0.3.0 fixes local
playback. Author reports an error for a v0.2.0 local-video surface and blocks a
paired standard handoff, including when candidate diagnostics were selected.
For a paired handoff, explicitly choose an HTTPS video or remove that surface.
Remote URLs are not fetched by the static compatibility check.

A failed setup retains its files and reports a failure. Check pinned release
inputs, internet access and free space before preparing a new preview. Normal
Author shutdown closes its preview. After an abrupt exit, reload preview inputs
to reconcile the recorded process, then explicitly stop, keep or discard it.
See [Author backup and recovery](recovery.md) for the supported recovery behavior.

To reopen a retained preview manually, use its generated launcher with the same
study folder shown on the receipt. For example, run
`"/local/author-home/previews/preview-ID/bundle/Start Course.command" start --home "/local/author-home/previews/preview-ID/study" --no-provider`
from Terminal, replacing both paths with the saved preview's actual paths.
Double-clicking the bundle without `--home` chooses its normal separate default
study home. Stop that Terminal launch before using the same study folder again.
