import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PhaseCard } from '../src/phase-card';

const capabilities = { chat: true, hint_level: 'graduated' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false };

afterEach(() => cleanup());

describe('PhaseCard', () => {
  it.each([
    ['orient', 'Set your time and learning goal'],
    ['read', 'Open the local reading'],
    ['watch', 'Ask about this timestamp'],
    ['predict', 'Record your prediction'],
    ['experiment', 'Show a gentle hint'],
    ['lab', 'Keep the implementation yours'],
    ['review', 'Record reflection or evidence'],
    ['audit', 'Teacher help is locked during audit'],
    ['ship', 'Run the named verification']
  ] as const)('renders the %s primary learner affordance', (kind, affordance) => {
    render(<PhaseCard phase={{ id: kind, title: `${kind} phase`, kind, capabilities, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1 }} />);
    expect(screen.getByText(affordance)).toBeInTheDocument();
  });

  it('disables the hint ladder when the server capability denies hints', () => {
    render(<PhaseCard phase={{ id: 'experiment', title: 'Experiment', kind: 'experiment', capabilities: { ...capabilities, hint_level: 'none' }, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1 }} />);
    expect(screen.getByRole('button', { name: 'Show a gentle hint' })).toBeDisabled();
  });
});
