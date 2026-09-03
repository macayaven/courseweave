import { LearnerPhasePreview, type AuthorPhase } from '@courseweave/ui';
import type { ValidationIssue } from './validation';

export type PreviewValidation = { status: 'not_requested' | 'checking' | 'passed' | 'issues'; issues: readonly ValidationIssue[] };

function surfaceLocation(phase: AuthorPhase): string[] {
  return phase.surfaces.flatMap((surface) => {
    if ('path' in surface && typeof surface.path === 'string') return [surface.path];
    if ('url' in surface && typeof surface.url === 'string') return [surface.url];
    return [];
  });
}

/** The preview has no event, network, navigation, or mutation capability. */
export function AuthorPreview({ phase, issues, structural = { status: 'not_requested', issues: [] }, runnable }: { phase: AuthorPhase | null; issues?: readonly ValidationIssue[]; structural?: PreviewValidation; runnable?: PreviewValidation }) {
  const runnableState: PreviewValidation = runnable ?? { status: issues === undefined || issues.length === 0 ? 'not_requested' : 'issues', issues: issues ?? [] };
  const label = (name: string, value: PreviewValidation) => `${name}: ${value.status === 'not_requested' ? 'not requested' : value.status}.`;
  return <section aria-label="Preview"><h2>Preview</h2>
    {phase === null ? <p>Select a phase to see its inert learner card.</p> : <><LearnerPhasePreview phase={phase} />
      <h3>Inert surface metadata</h3><ul>{surfaceLocation(phase).map((location, index) => <li key={`${location}:${index}`}>{location}</li>)}</ul></>}
    <h3>Validation state</h3><p>{label('Structural validation', structural)}</p><p>{label('Runnable diagnostics', runnableState)}</p>
    {runnableState.status === 'issues' ? <ul>{runnableState.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}>{issue.message}</li>)}</ul> : null}
  </section>;
}
