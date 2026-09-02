import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProposalDrawer } from '../src/proposal-drawer';

const pending = { id: 'proposal-1', revision: 4, type: 'workspace_file_replace', origin: 'teacher_suggested', status: 'pending' as const, summary: 'Improve the example', created_at: '2026-09-02T00:00:00Z', target: 'lesson.md', payload: { content: 'replacement', diff: '-old\n+new' }, target_hash: 'abc', result: null };
const client = () => ({ acceptProposal: vi.fn().mockResolvedValue(pending), rejectProposal: vi.fn().mockResolvedValue(pending), editProposal: vi.fn().mockResolvedValue(pending) });

afterEach(() => cleanup());

describe('ProposalDrawer', () => {
  it('renders REST pending proposal text and concrete diff', () => {
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={client()} onRefresh={vi.fn()} onProposal={vi.fn()} />);
    expect(screen.getByText('Improve the example')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === '-old\n+new')).toBeInTheDocument();
  });

  it.each([['Accept', 'acceptProposal'], ['Reject', 'rejectProposal']] as const)('%s sends only the expected revision through its REST client', (label, method) => {
    const api = client();
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} onProposal={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(api[method]).toHaveBeenCalledWith('proposal-1', { expected_revision: 4 }, expect.any(AbortSignal));
  });

  it('edits with the supported request fields only', () => {
    const api = client();
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} onProposal={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'Tighten example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(api.editProposal).toHaveBeenCalledWith('proposal-1', { expected_revision: 4, request: { summary: 'Tighten example' } }, expect.any(AbortSignal));
  });

  it('preserves an edit draft and announces review after a conflict without retrying', async () => {
    const api = client();
    api.editProposal.mockRejectedValue({ code: 'proposal_conflict', status: 409 });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={onRefresh} onProposal={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'retain edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Proposal changed; review refreshed proposals.')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit summary')).toHaveValue('retain edit');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(api.editProposal).toHaveBeenCalledOnce();
  });

  it('does not expose actions for non-pending REST proposals', () => {
    render(<ProposalDrawer proposals={[{ ...pending, status: 'accepted' }]} state={{ revision: 7 }} client={client()} onRefresh={vi.fn()} onProposal={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('commits a successful returned proposal so its stale pending action disappears', async () => {
    const api = client();
    const onProposal = vi.fn();
    api.acceptProposal.mockResolvedValue({ ...pending, status: 'accepted' });
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} onProposal={onProposal} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await vi.waitFor(() => expect(onProposal).toHaveBeenCalledWith({ ...pending, status: 'accepted' }));
  });

  it('continues a successful proposal lifecycle under the real StrictMode entry behavior', async () => {
    const api = client();
    const onProposal = vi.fn();
    render(<StrictMode><ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} onProposal={onProposal} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await vi.waitFor(() => expect(onProposal).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Accept' })).not.toBeDisabled();
  });

  it('keeps an orphaned controlled edit draft visible and non-actionable after refresh removes its proposal', () => {
    const drafts = { 'proposal-1': 'do not lose me' };
    const { rerender } = render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={client()} onRefresh={vi.fn()} onProposal={vi.fn()} drafts={drafts} onDraftsChange={vi.fn()} />);
    rerender(<ProposalDrawer proposals={[]} state={{ revision: 8 }} client={client()} onRefresh={vi.fn()} onProposal={vi.fn()} drafts={drafts} onDraftsChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Unsent proposal edits' })).toBeInTheDocument();
    expect(screen.getByLabelText('Unsent edit for proposal-1')).toHaveValue('do not lose me');
    expect(screen.queryByRole('button', { name: 'Save edit' })).not.toBeInTheDocument();
  });

  it.each(['accepted', 'rejected', 'superseded', 'failed'] as const)('keeps a draft orphaned when its same-ID proposal is %s', (status) => {
    const drafts = { 'proposal-1': 'do not retarget me' };
    render(<ProposalDrawer proposals={[{ ...pending, status }]} state={{ revision: 8 }} client={client()} onRefresh={vi.fn()} onProposal={vi.fn()} drafts={drafts} onDraftsChange={vi.fn()} />);
    expect(screen.getByLabelText('Unsent edit for proposal-1')).toHaveValue('do not retarget me');
    expect(screen.queryByRole('button', { name: 'Save edit' })).not.toBeInTheDocument();
  });

  it('keeps draft input editable but disables every proposal mutation during recovery', () => {
    const api = client();
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} onProposal={vi.fn()} recovery />);
    expect(screen.getByLabelText('Edit summary')).not.toBeDisabled();
    for (const name of ['Accept', 'Reject', 'Save edit']) expect(screen.getByRole('button', { name })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(api.acceptProposal).not.toHaveBeenCalled();
  });
});
