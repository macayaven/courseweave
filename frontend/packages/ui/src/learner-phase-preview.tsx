import type { AuthorPhase } from './author-types';

const labels: Record<AuthorPhase['kind'], string> = {
  orient: 'Orientation', read: 'Reading', watch: 'Watching', predict: 'Prediction prompt',
  experiment: 'Experiment', lab: 'Lab workspace', review: 'Review actions', audit: 'Audit', ship: 'Ship workspace',
};

/** A display-only sketch of a learner card. It deliberately accepts no callbacks. */
export function LearnerPhasePreview({ phase }: { phase: AuthorPhase }) {
  return <section aria-label={`${labels[phase.kind]} preview`}>
    <h3>{labels[phase.kind]}</h3>
    <p>{phase.title}</p>
    <p role="status">Preview only — learner actions are disabled.</p>
  </section>;
}
