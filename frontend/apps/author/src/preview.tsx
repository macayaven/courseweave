import { LearnerPhasePreview, type AuthorPhase } from '@courseweave/ui';
import type { ValidationIssue } from './validation';

function surfaceLocation(phase: AuthorPhase): string[] {
  return phase.surfaces.flatMap((surface) => {
    if ('path' in surface && typeof surface.path === 'string') return [surface.path];
    if ('url' in surface && typeof surface.url === 'string') return [surface.url];
    return [];
  });
}

/** The preview has no event, network, navigation, or mutation capability. */
export function AuthorPreview({ phase, issues }: { phase: AuthorPhase | null; issues: readonly ValidationIssue[] }) {
  return <section aria-label="Preview"><h2>Preview</h2>
    {phase === null ? <p>Select a phase to see its inert learner card.</p> : <><LearnerPhasePreview phase={phase} />
      <h3>Inert surface metadata</h3><ul>{surfaceLocation(phase).map((location, index) => <li key={`${location}:${index}`}>{location}</li>)}</ul></>}
    <h3>Runnable diagnostics</h3>
    {issues.length === 0 ? <p>No runnable diagnostics have been requested.</p> : <ul>{issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
  </section>;
}
