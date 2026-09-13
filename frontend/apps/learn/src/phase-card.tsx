import { Button } from "@courseweave/ui";
import type {
  CoursePhase,
  LearnerState,
} from "@courseweave/ui/courseweave-types";
import { postOpenSurface, openSurfaceLabel } from "./dashboard";
import { RequirementCard } from "./requirement-card";
import { CheckCard } from "./check-card";
import type { StateActionProps } from "./use-state-action";
export function PhaseCard({
  moduleId,
  phase,
  state,
  serviceOrigin,
  surfaceId,
  parentWindow,
  onDiscuss,
  showOpen = true,
  showHeading = true,
  ...actions
}: StateActionProps & {
  moduleId: string;
  phase: CoursePhase;
  state: LearnerState;
  serviceOrigin: string;
  surfaceId: string | null;
  videoSeconds?: number | null;
  parentWindow?: Pick<Window, "postMessage">;
  onDiscuss?(prompt: string): void;
  showOpen?: boolean;
  showHeading?: boolean;
}) {
  const progress = state.progress.phases.find(
    (item) => item.module_id === moduleId && item.phase_id === phase.id,
  );
  const surface = phase.surfaces.find((item) => item.id === surfaceId);
  const duration = phase.learning?.duration;
  return (
    <section className="cw-activity" aria-label="Current activity">
      {showHeading ? <h2>{phase.title}</h2> : null}
      {duration ? (
        <p className="cw-detail">
          {duration.min_minutes}–{duration.max_minutes} min ·{" "}
          {phase.progress === "required"
            ? "Core activity"
            : phase.progress === "optional"
              ? "Optional activity"
              : "Reference activity"}
        </p>
      ) : null}
      {phase.learning?.overview ? <p>{phase.learning.overview}</p> : null}
      {phase.learning?.objectives?.length ? (
        <ul className="cw-objectives">
          {phase.learning.objectives.map((objective) => (
            <li key={objective.id}>{objective.text}</li>
          ))}
        </ul>
      ) : null}
      {surface && showOpen ? (
        <Button
          type="button"
          onClick={() =>
            postOpenSurface(
              serviceOrigin,
              { moduleId, phaseId: phase.id, surfaceId: surface.id },
              parentWindow,
            )
          }
        >
          {openSurfaceLabel(surface.label)}
        </Button>
      ) : null}
      {progress ? (
        <p className="cw-detail">
          {progress.complete
            ? "Activity complete"
            : progress.progress === "excluded"
              ? "Outside required progress"
              : `${progress.requirements.filter((item) => item.satisfied).length} of ${progress.requirements.length} requirements recorded`}
        </p>
      ) : null}
      {phase.completion?.requirements.map((requirement) => (
        <RequirementCard
          key={requirement.id}
          requirement={requirement}
          moduleId={moduleId}
          phaseId={phase.id}
          state={state}
          {...actions}
        />
      ))}
      {phase.learning?.checks?.length ? (
        <details className="cw-checks">
          <summary>Self-checks ({phase.learning.checks.length})</summary>
          {phase.learning.checks.map((check) => (
            <CheckCard
              key={check.id}
              check={check}
              moduleId={moduleId}
              phaseId={phase.id}
              state={state}
              onDiscuss={onDiscuss}
              {...actions}
            />
          ))}
        </details>
      ) : null}
    </section>
  );
}
