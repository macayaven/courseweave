import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PhaseCard } from '../src/phase-card';

const capabilities = { chat: true, hint_level: 'graduated' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false };

afterEach(() => cleanup());

describe('PhaseCard', () => {
  it.each([
    ['orient', 'Time and profile'],
    ['read', 'Open reading'],
    ['watch', 'Open video at 42 seconds'],
    ['predict', 'Record your prediction below before requesting results.'],
    ['experiment', 'Show a gentle hint'],
    ['lab', 'I ran my own checks'],
    ['review', 'Reflection and evidence'],
    ['audit', 'Teacher help is locked during audit'],
    ['ship', 'I verified the named checks']
  ] as const)('renders the %s primary learner affordance', (kind, affordance) => {
    render(<PhaseCard moduleId="m01" phase={{ id: kind, title: `${kind} phase`, kind, capabilities, completion: { type: 'manual' }, surfaces: [{ id: 'surface-1', type: kind === 'watch' ? 'video' : 'markdown', role: 'primary', label: 'Reading' }] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId="surface-1" videoSeconds={42} />);
    if (kind === 'predict') expect(screen.getByText(affordance)).toBeInTheDocument();
    else if (kind === 'lab' || kind === 'ship') expect(screen.getByRole('checkbox', { name: affordance })).toBeInTheDocument();
    else expect(screen.getByRole(kind === 'audit' ? 'status' : 'button', { name: affordance })).toBeInTheDocument();
  });

  it('disables the hint ladder when the server capability denies hints', () => {
    render(<PhaseCard moduleId="m01" phase={{ id: 'experiment', title: 'Experiment', kind: 'experiment', capabilities: { ...capabilities, hint_level: 'none' }, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    expect(screen.getByRole('button', { name: 'Show a gentle hint' })).toBeDisabled();
  });

  it('clamps a revealed hint immediately after a trusted capability downgrade', () => {
    const phase = { id: 'experiment', title: 'Experiment', kind: 'experiment' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    const { rerender } = render(<PhaseCard moduleId="m01" phase={phase} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show a gentle hint' }));
    expect(screen.getByText('Hint level 1 of 2')).toBeInTheDocument();
    rerender(<PhaseCard moduleId="m01" phase={{ ...phase, capabilities: { ...capabilities, hint_level: 'none' } }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    expect(screen.queryByText(/Hint level/)).not.toBeInTheDocument();
  });
});
