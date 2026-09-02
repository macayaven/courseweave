import { EmptyState } from '@courseweave/ui';
import type { CoursePhase, LearnerState } from '@courseweave/ui/courseweave-types';

import { HintLadder } from './hint-ladder';

export function PhaseCard({ phase, state }: { phase: CoursePhase | null; state: LearnerState }) {
  if (phase === null) return <EmptyState title="No active course document"><p>Select a course surface to continue.</p></EmptyState>;
  switch (phase.kind) {
    case 'orient': return <section><h2>{phase.title}</h2><p>Set your time and learning goal</p></section>;
    case 'read': return <section><h2>{phase.title}</h2><p>Open the local reading</p></section>;
    case 'watch': return <section><h2>{phase.title}</h2><p>Ask about this timestamp</p></section>;
    case 'predict': return <section><h2>{phase.title}</h2><p>Record your prediction</p></section>;
    case 'experiment': return <section><h2>{phase.title}</h2><HintLadder level={phase.capabilities.hint_level} /></section>;
    case 'lab': return <section><h2>{phase.title}</h2><p>Keep the implementation yours</p><ul><li>Read the protocol</li><li>Run your own checks</li></ul></section>;
    case 'review': return <section><h2>{phase.title}</h2><p>Record reflection or evidence</p></section>;
    case 'audit': return <section><h2>{phase.title}</h2><p>Teacher help is locked during audit</p></section>;
    case 'ship': return <section><h2>{phase.title}</h2><p>Run the named verification</p></section>;
  }
}
