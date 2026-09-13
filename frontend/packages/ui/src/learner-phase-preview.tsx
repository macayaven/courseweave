import type { AuthorPhase } from "./author-types";
/** A display-only learner card; no actions, network, or navigation capabilities. */
export function LearnerPhasePreview({ phase }: { phase: AuthorPhase }) {
  const label = phase.experience.id;
  return (
    <section aria-label={`${label} preview`}>
      <h3>{label.charAt(0).toUpperCase() + label.slice(1)}</h3>
      <p>{phase.title}</p>
      <p>
        {phase.progress} activity · Course assistant:{" "}
        {phase.teacher.access.mode}
      </p>
      {phase.learning?.overview ? <p>{phase.learning.overview}</p> : null}
      {phase.learning?.objectives?.length ? (
        <ul>
          {phase.learning.objectives.map((objective) => (
            <li key={objective.id}>{objective.text}</li>
          ))}
        </ul>
      ) : null}
      {phase.completion?.requirements.map((requirement) => (
        <p key={requirement.id}>{requirement.prompt}</p>
      ))}
      <p role="status">Preview only — learner actions are disabled.</p>
    </section>
  );
}
