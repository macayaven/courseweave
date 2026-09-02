import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it.each([
    ['reflection', 'Reflection', 'Record reflection', { type: 'record_reflection', text: 'what I learned' }],
    ['evidence', 'Evidence reference', 'Record evidence', { type: 'record_evidence', reference: 'check-42' }]
  ] as const)('records %s through the state contract and announces committed success', async (_, field, button, expected) => {
    const onStateOperation = vi.fn().mockResolvedValue(undefined);
    const review = { id: 'review', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    render(<PhaseCard moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={onStateOperation} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText(field), { target: { value: 'text' in expected ? expected.text : expected.reference } });
    fireEvent.click(screen.getByRole('button', { name: button }));
    await vi.waitFor(() => expect(onStateOperation).toHaveBeenCalledOnce());
    expect(onStateOperation).toHaveBeenCalledWith(expect.objectContaining({ ...expected, module_id: 'm01', phase_id: 'review', record_id: expect.any(String) }), expect.any(AbortSignal));
    expect(await screen.findByRole('status')).toHaveTextContent(expected.type === 'record_reflection' ? 'Reflection recorded.' : 'Evidence recorded.');
    expect(screen.getByLabelText(field)).toHaveValue('');
  });

  it('preserves review drafts and refreshes exactly once after a state conflict without replay', async () => {
    const onStateOperation = vi.fn().mockRejectedValue({ status: 409, code: 'revision_mismatch' });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const review = { id: 'review', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    render(<PhaseCard moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={onStateOperation} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'retain reflection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record reflection' }));
    expect(await screen.findByText('State changed; review the refreshed course state.')).toBeInTheDocument();
    expect(screen.getByLabelText('Reflection')).toHaveValue('retain reflection');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onStateOperation).toHaveBeenCalledOnce();
  });

  it('works for reflection and evidence after StrictMode setup cleanup setup', async () => {
    const onStateOperation = vi.fn().mockResolvedValue(undefined);
    const review = { id: 'review', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    render(<StrictMode><PhaseCard moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={onStateOperation} onRefresh={vi.fn()} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'strict reflection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record reflection' }));
    await vi.waitFor(() => expect(screen.getByText('Reflection recorded.')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Evidence reference'), { target: { value: 'strict evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence' }));
    await vi.waitFor(() => expect(screen.getByText('Evidence recorded.')).toBeInTheDocument());
    expect(onStateOperation).toHaveBeenCalledTimes(2);
  });

  it('resets review, lab, and ship local state when the trusted phase key changes', () => {
    const review = { id: 'review-a', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    const { rerender } = render(<PhaseCard key="m01/review-a" moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'phase A only' } });
    rerender(<PhaseCard key="m01/review-b" moduleId="m01" phase={{ ...review, id: 'review-b' }} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    expect(screen.getByLabelText('Reflection')).toHaveValue('');

    rerender(<PhaseCard key="m01/lab" moduleId="m01" phase={{ ...review, id: 'lab', kind: 'lab' }} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I ran my own checks' }));
    rerender(<PhaseCard key="m01/ship" moduleId="m01" phase={{ ...review, id: 'ship', kind: 'ship' }} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onRefresh={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'I verified the named checks' })).not.toBeChecked();
  });

  it('keeps review text editable but does not write during recovery', () => {
    const onStateOperation = vi.fn();
    const review = { id: 'review', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    render(<PhaseCard moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={onStateOperation} onRefresh={vi.fn()} recovery />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'keep this' } });
    expect(screen.getByRole('button', { name: 'Record reflection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Record reflection' }));
    expect(onStateOperation).not.toHaveBeenCalled();
  });
});
