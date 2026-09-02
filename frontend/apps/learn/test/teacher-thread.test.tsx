import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeacherThread } from '../src/teacher-thread';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TeacherThread', () => {
  it('posts only a fresh minimal AG-UI request and renders incremental trusted text', async () => {
    const postGuide = vi.fn().mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'Explain the lesson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask teacher' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    expect(postGuide).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ role: 'user', content: 'Explain the lesson' })], tools: [], context: [], forwardedProps: { source_id: 'source-a' } }), expect.any(AbortSignal));
  });

  it('keeps a composer draft after an authoritative pre-stream missing-provider result', async () => {
    const postGuide = vi.fn().mockRejectedValue({ code: 'not_configured' });
    const onProvider = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask teacher' }));
    expect(await screen.findByText('Teacher unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the teacher')).toHaveValue('keep me');
    expect(onProvider).toHaveBeenCalledWith('not_configured');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps one thread identity when trusted active-phase props change', async () => {
    const postGuide = vi.fn().mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    const common = { client: { postGuide, share: vi.fn(), createProposal: vi.fn() }, allowedShareKinds: [], maxShareChars: 20, onProvider: vi.fn(), onProposal: vi.fn(), onRefresh: vi.fn() };
    const { rerender } = render(<TeacherThread {...common} sourceId="source-a" />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask teacher' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Ask teacher' })).not.toBeDisabled());
    const firstThread = postGuide.mock.calls[0]?.[0].threadId;
    rerender(<TeacherThread {...common} sourceId="source-b" />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask teacher' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledTimes(2));
    expect(postGuide.mock.calls[1]?.[0].threadId).toBe(firstThread);
    expect(postGuide.mock.calls[1]?.[0].forwardedProps).toEqual({ source_id: 'source-b' });
  });

  it('persists an inert candidate only through candidate_id and never makes a shared-run candidate actionable', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const candidateStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a"}}}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n')); controller.close(); } });
    const postGuide = vi.fn().mockResolvedValue(new Response(candidateStream, { headers: { 'content-type': 'text/event-stream' } }));
    const createProposal = vi.fn().mockResolvedValue({ id: 'candidate-a', revision: 1, status: 'pending' });
    const onProposal = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={onProposal} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'suggest a change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask teacher' }));
    expect(await screen.findByRole('button', { name: 'Save suggested change' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save suggested change' }));
    await vi.waitFor(() => expect(createProposal).toHaveBeenCalledWith('candidate-a'));
    expect(onProposal).toHaveBeenCalledOnce();
  });

  it('shares only after explicit confirmation and clears the dialog on a failed guide without reflecting content', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const postGuide = vi.fn().mockRejectedValue({ code: 'provider_error' });
    render(<TeacherThread client={{ postGuide, share, createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['selection']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'ask safely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share before asking' }));
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'private excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ run_id: expect.any(String), kind: 'selection', content: 'private excerpt', source_id: 'source-a' }), expect.any(AbortSignal)));
    expect(await screen.findByText('Teacher unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Share content')).not.toBeInTheDocument();
  });
});
