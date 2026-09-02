import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProposalDrawer } from '../src/proposal-drawer';

const pending = { id: 'proposal-1', revision: 4, type: 'workspace_file_replace', origin: 'teacher_suggested', status: 'pending' as const, summary: 'Improve the example', created_at: '2026-09-02T00:00:00Z', target: 'lesson.md', payload: { content: 'replacement', diff: '-old\n+new' }, target_hash: 'abc', result: null };
const client = () => ({ acceptProposal: vi.fn().mockResolvedValue(pending), rejectProposal: vi.fn().mockResolvedValue(pending), editProposal: vi.fn().mockResolvedValue(pending) });

afterEach(() => cleanup());

describe('ProposalDrawer', () => {
  it('renders REST pending proposal text and concrete diff', () => {
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={client()} onRefresh={vi.fn()} />);
    expect(screen.getByText('Improve the example')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === '-old\n+new')).toBeInTheDocument();
  });

  it.each([['Accept', 'acceptProposal'], ['Reject', 'rejectProposal']] as const)('%s sends only the expected revision through its REST client', (label, method) => {
    const api = client();
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(api[method]).toHaveBeenCalledWith('proposal-1', { expected_revision: 4 });
  });

  it('edits with the supported request fields only', () => {
    const api = client();
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'Tighten example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(api.editProposal).toHaveBeenCalledWith('proposal-1', { expected_revision: 4, request: { summary: 'Tighten example' } });
  });

  it('preserves an edit draft and announces review after a conflict without retrying', async () => {
    const api = client();
    api.editProposal.mockRejectedValue({ code: 'revision_mismatch' });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(<ProposalDrawer proposals={[pending]} state={{ revision: 7 }} client={api} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'retain edit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Proposal changed; review refreshed proposals.')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit summary')).toHaveValue('retain edit');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(api.editProposal).toHaveBeenCalledOnce();
  });

  it('does not expose actions for non-pending REST proposals', () => {
    render(<ProposalDrawer proposals={[{ ...pending, status: 'accepted' }]} state={{ revision: 7 }} client={client()} onRefresh={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });
});
