import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PhaseCard } from '../src/phase-card';

const capabilities = { chat: true, hint_level: 'graduated' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false };

afterEach(() => cleanup());

describe('PhaseCard', () => {
  const parentWindow = (postMessage = vi.fn()) => ({ postMessage }) as unknown as Pick<Window, 'postMessage'>;
  it.each([
    ['orient', 'Open orientation'],
    ['read', 'Open reading'],
    ['watch', 'Open video at 42 seconds'],
    ['predict', 'Record your prediction below before requesting results.'],
    ['experiment', 'Show a gentle hint'],
    ['lab', 'Open lab'],
    ['review', 'Reflection and evidence'],
    ['audit', 'Teacher help is locked during audit'],
    ['ship', 'Open shipment']
  ] as const)('renders the %s primary learner affordance', (kind, affordance) => {
    render(<PhaseCard moduleId="m01" phase={{ id: kind, title: `${kind} phase`, kind, capabilities, completion: { type: 'manual' }, surfaces: [{ id: 'surface-1', type: kind === 'watch' ? 'video' : 'markdown', role: 'primary', label: 'Reading' }] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId="surface-1" videoSeconds={42} />);
    if (kind === 'predict') expect(screen.getByText(affordance)).toBeInTheDocument();
    else expect(screen.getByRole(kind === 'audit' ? 'status' : 'button', { name: affordance })).toBeInTheDocument();
  });

  it.each([
    [{ type: 'prediction_recorded' as const, record_id: 'prediction' }, 'predict'],
    [{ type: 'receipt_recorded' as const, record_id: 'receipt' }, 'review'],
    [{ type: 'artifact_exists' as const, record_id: 'artifact', path: 'work.md' }, 'ship']
  ])('renders Phase complete from the authoritative %s record', (completion, phaseId) => {
    render(<PhaseCard moduleId="m01" phase={{ id: phaseId, title: 'Server phase', kind: phaseId as 'predict' | 'review' | 'ship', capabilities, completion, surfaces: [] }} state={{ revision: 1, completed_phases: { [`m01/${phaseId}/${completion.record_id}`]: { committed: true } } }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('Phase complete');
  });

  it('starts Orient with the authoritative time budget and opens the optional profile prompt', () => {
    render(<PhaseCard moduleId="m01" phase={{ id: 'orient', title: 'Orient', kind: 'orient', capabilities: { ...capabilities, create_profile_proposal: true }, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1, time_budget_minutes: 25 }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    expect(screen.getByText('Time budget: 25 minutes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start orientation' }));
    expect(screen.getByRole('status')).toHaveTextContent('Orientation started for 25 minutes.');
    fireEvent.click(screen.getByRole('button', { name: 'Review profile options' }));
    expect(screen.getByText('Profile updates require an explicit proposal review.')).toBeInTheDocument();
  });

  it('tracks Lab protocol and test checks as session-only learner-owned work', () => {
    render(<PhaseCard moduleId="m01" phase={{ id: 'lab', title: 'Lab', kind: 'lab', capabilities, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I read the protocol' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'I ran the named tests' }));
    expect(screen.getByRole('status')).toHaveTextContent('Lab session checks: 2 of 2 complete.');
    expect(screen.getByText('These checks do not mark the phase complete.')).toBeInTheDocument();
  });

  it('tracks Ship named verifications separately from authoritative learner receipts', () => {
    render(<PhaseCard moduleId="m01" phase={{ id: 'ship', title: 'Ship', kind: 'ship', capabilities, completion: { type: 'manual' }, surfaces: [] }} state={{ revision: 1, evidence: { 'm01/ship/check-1': { reference: 'pytest' }, 'm01/read/other': { reference: 'other' } } }} serviceOrigin="https://courseweave.test" surfaceId={null} />);
    expect(screen.getByText('Learner-recorded receipts: 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Typecheck passed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tests passed' }));
    expect(screen.getByRole('status')).toHaveTextContent('Release checks: 2 of 3 complete.');
    expect(screen.getByText('Only server state can mark this phase complete.')).toBeInTheDocument();
  });

  it.each([
    ['orient', 'Open orientation'],
    ['lab', 'Open lab'],
    ['ship', 'Open shipment']
  ] as const)('sends only the trusted IDs when %s surface navigation is requested', (kind, label) => {
    const postMessage = vi.fn();
    render(<PhaseCard moduleId="m01" phase={{ id: kind, title: kind, kind, capabilities, completion: { type: 'manual' }, surfaces: [{ id: 'surface-1', type: 'markdown', role: 'primary', label: 'Surface' }] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId="surface-1" parentWindow={parentWindow(postMessage)} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'courseweave.open-surface.v1', moduleId: 'm01', phaseId: kind, surfaceId: 'surface-1' }, 'https://courseweave.test');
  });

  it.each([null, 'missing-surface'])('does not navigate when the resolved surface is %s', (surfaceId) => {
    const postMessage = vi.fn();
    render(<PhaseCard moduleId="m01" phase={{ id: 'lab', title: 'Lab', kind: 'lab', capabilities, completion: { type: 'manual' }, surfaces: [{ id: 'surface-1', type: 'markdown', role: 'primary', label: 'Surface' }] }} state={{ revision: 1 }} serviceOrigin="https://courseweave.test" surfaceId={surfaceId} parentWindow={parentWindow(postMessage)} />);
    expect(screen.queryByRole('button', { name: 'Open lab' })).not.toBeInTheDocument();
    expect(postMessage).not.toHaveBeenCalled();
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

  it('enters application recovery when a review conflict refresh fails without an auth status', async () => {
    const onRecovery = vi.fn();
    const review = { id: 'review', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    render(<PhaseCard moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={vi.fn().mockRejectedValue({ code: 'revision_mismatch' })} onRefresh={vi.fn().mockRejectedValue(new Error('offline'))} onRecovery={onRecovery} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'retain reflection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record reflection' }));
    expect(await screen.findByText('State refresh failed. Reconnect to continue.')).toBeInTheDocument();
    expect(onRecovery).toHaveBeenCalledOnce();
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

  it('resets review local state when the trusted phase key changes', () => {
    const review = { id: 'review-a', title: 'Review', kind: 'review' as const, capabilities, completion: { type: 'manual' as const }, surfaces: [] };
    const { rerender } = render(<PhaseCard key="m01/review-a" moduleId="m01" phase={review} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    fireEvent.change(screen.getByLabelText('Reflection'), { target: { value: 'phase A only' } });
    rerender(<PhaseCard key="m01/review-b" moduleId="m01" phase={{ ...review, id: 'review-b' }} state={{ revision: 3 }} serviceOrigin="https://courseweave.test" surfaceId={null} onStateOperation={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reflection and evidence' }));
    expect(screen.getByLabelText('Reflection')).toHaveValue('');

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
