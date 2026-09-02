# CourseWeave architecture review packet

Repository: `/Volumes/mac-studio-ssd/education/courseweave`

Authoritative inputs:

- `docs/superpowers/specs/2026-09-01-courseweave-platform-design.md`
- `docs/superpowers/plans/2026-09-01-courseweave-platform.md`
- `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/AGENTS.md`
- `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/README.md`
- `/Volumes/mac-studio-ssd/education/agent-harness-path-adaptive-tutor/COURSE-MAP.md`

Goal:

Build a reusable, simple technical-course environment with one continuous,
phase-aware teacher in JupyterLab; automatic context but consented persistent
changes; OpenAI-compatible and Anthropic-compatible providers; and a separately
runnable authoring CRUD twin app. Then adapt the Agent Harness Path without
changing its canonical offline notebooks or the user's dirty source checkout.

Review questions:

1. Enumerate missing required behaviors, edge cases, error paths, ordering,
   de-duplication, and public interfaces.
2. Identify architecture that is too custom, too coupled, or unnecessarily
   complex, and propose the smallest correction that preserves the product.
3. Check whether Pydantic AI + AG-UI + FastAPI + a tiny JupyterLab bridge is a
   coherent boundary for this goal.
4. Check the plan for hidden dependency/version/build problems on Python 3.11,
   Node 20, JupyterLab 4.6, and current package releases.
5. Check whether the learner UI actually avoids context-switching across lesson
   HTML, video, notebook, lab Markdown, Python source, and terminal/test work.
6. Check consent, credential, path-jail, concurrency, and data-loss risks.
7. Check that Author Studio is genuinely reusable for another technical course.
8. Check that every specification requirement has an executable test or
   verification step.

Return Markdown only with:

- Critical findings
- Important findings
- Simplifications
- Missing tests
- Recommended plan edits
- Go/no-go verdict

Do not edit any file. Do not run destructive commands. Treat your response as
advisory; the coordinating agent owns final decisions.

