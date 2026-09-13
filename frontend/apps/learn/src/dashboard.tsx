import { Button, EmptyState } from "@courseweave/ui";
import type {
  CourseManifest,
  CourseSurface,
  LearnerState,
} from "@courseweave/ui/courseweave-types";
export function openSurfaceLabel(label: string): string {
  return /^open\b/i.test(label.trim()) ? label.trim() : `Open ${label}`;
}

export function postOpenSurface(
  expectedParentOrigin: string,
  ids: { moduleId: string; phaseId: string; surfaceId: string },
  parentWindow: Pick<Window, "postMessage"> = window.parent,
): void {
  if (parentWindow === window) return;
  parentWindow.postMessage(
    { type: "courseweave.open-surface.v1", ...ids },
    expectedParentOrigin,
  );
}
export function nextRequiredActivity(
  course: CourseManifest,
  state: LearnerState,
  active: { moduleId: string; phaseId: string } | null,
) {
  const phases = course.modules.flatMap((module) =>
    module.phases
      .filter((phase) => phase.progress === "required")
      .map((phase) => ({ module, phase })),
  );
  const index = phases.findIndex(
    (item) =>
      item.module.id === active?.moduleId && item.phase.id === active?.phaseId,
  );
  const complete = (moduleId: string, phaseId: string) =>
    state.progress.phases.find(
      (item) => item.module_id === moduleId && item.phase_id === phaseId,
    )?.complete === true;
  if (
    index >= 0 &&
    !complete(phases[index]!.module.id, phases[index]!.phase.id)
  )
    return phases[index]!;
  if (index >= 0)
    return (
      phases
        .slice(index + 1)
        .find((item) => !complete(item.module.id, item.phase.id)) ??
      phases.find((item) => !complete(item.module.id, item.phase.id)) ??
      null
    );
  const entry = phases.find(
    (item) =>
      item.module.id === course.entry_module_id &&
      !complete(item.module.id, item.phase.id),
  );
  return (
    entry ??
    phases.find((item) => !complete(item.module.id, item.phase.id)) ??
    null
  );
}
export function Dashboard({
  course,
  state,
  active = null,
  expectedParentOrigin,
  onOpenSurface,
}: {
  course: CourseManifest;
  state?: LearnerState;
  active?: { moduleId: string; phaseId: string } | null;
  expectedParentOrigin: string;
  onOpenSurface?(coordinate: {
    moduleId: string;
    phaseId: string;
    surface: CourseSurface;
  }): void;
}) {
  if (course.modules.length === 0)
    return (
      <EmptyState title="This course has no modules yet">
        <p>Ask your course author to add a module.</p>
      </EmptyState>
    );
  const open = (moduleId: string, phaseId: string, surface: CourseSurface) => {
    onOpenSurface?.({ moduleId, phaseId, surface });
    postOpenSurface(expectedParentOrigin, {
      moduleId,
      phaseId,
      surfaceId: surface.id,
    });
  };
  const next = state ? nextRequiredActivity(course, state, active) : null;
  const primary =
    next?.phase.surfaces.find((item) => item.purpose === "primary") ??
    next?.phase.surfaces[0];
  const current =
    next?.module.id === active?.moduleId && next?.phase.id === active?.phaseId;
  const contents = (optional: boolean) =>
    course.modules.map((module) => {
      const phases = module.phases.filter((phase) =>
        optional
          ? phase.progress !== "required"
          : phase.progress === "required",
      );
      if (!phases.length) return null;
      return (
        <section key={module.id}>
          <h2>{module.title}</h2>
          {phases.map((phase) => (
            <section key={phase.id}>
              <h3>{phase.title}</h3>
              {phase.surfaces.map((surface) => (
                <Button
                  key={surface.id}
                  type="button"
                  onClick={() => open(module.id, phase.id, surface)}
                >
                  {openSurfaceLabel(surface.label)}
                </Button>
              ))}
            </section>
          ))}
        </section>
      );
    });
  return (
    <section aria-label="Course dashboard" className="cw-navigation">
      {next && primary ? (
        <Button
          className="cw-continue"
          type="button"
          onClick={() => open(next.module.id, next.phase.id, primary)}
        >
          {active === null
            ? `Start: ${next.phase.title}`
            : current
              ? openSurfaceLabel(primary.label)
              : `Continue: ${next.phase.title}`}
        </Button>
      ) : state ? (
        <p>
          {state.progress.required_total > 0
            ? "All required activities are recorded. You can revisit them below."
            : "Browse the course activities below."}
        </p>
      ) : null}
      <details>
        <summary>
          <span>Course contents</span>
          {state ? (
            <span className="cw-detail">
              {" "}
              · {state.progress.required_complete}/
              {state.progress.required_total} required
            </span>
          ) : null}
        </summary>
        {contents(false)}
      </details>
      {course.modules.some((module) =>
        module.phases.some((phase) => phase.progress !== "required"),
      ) ? (
        <details>
          <summary>Optional activities &amp; references</summary>
          {contents(true)}
        </details>
      ) : null}
    </section>
  );
}
