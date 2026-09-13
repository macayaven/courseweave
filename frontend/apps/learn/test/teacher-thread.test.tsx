import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeacherThread } from '../src/teacher-thread';
import captured from './fixtures/learner-events.json';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TeacherThread', () => {
  it('shows the submitted learner message and marks a plain successful answer Ready', async () => {
    const onProvider = vi.fn();
    const postGuide = vi.fn(async (body) => new Response([
      {type:'RUN_STARTED', threadId:body.threadId,runId:body.runId},
      {type:'TEXT_MESSAGE_START',messageId:'assistant'},
      {type:'TEXT_MESSAGE_CONTENT',messageId:'assistant',delta:'A useful answer'},
      captured.events.find(event => event.type === 'CUSTOM' && event.name === 'courseweave.provider_outcome')!,
      {type:'TEXT_MESSAGE_END',messageId:'assistant'},
      {type:'RUN_FINISHED',threadId:body.threadId,runId:body.runId}
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
    render(<TeacherThread client={{postGuide,share:vi.fn(),createProposal:vi.fn()}} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'),{target:{value:'My submitted question'}});
    fireEvent.click(screen.getByRole('button',{name:'Send'}));
    expect(await screen.findByText('A useful answer')).toBeInTheDocument();
    expect(screen.getByText('My submitted question')).toBeInTheDocument();
    expect(onProvider).toHaveBeenCalledWith('ready');
  });
  it('renders the authoritative teacher lock and does not start a guide run', () => {
    const postGuide = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} enabled={false} lockReason="Record your prediction before asking the teacher." />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'help' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('Record your prediction before asking the teacher.')).toBeInTheDocument();
    expect(postGuide).not.toHaveBeenCalled();
  });

  it('keeps a newer composer draft when an older guide run finishes', async () => {
    let resolveGuide: ((response: Response) => void) | undefined;
    const postGuide = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveGuide = resolve; }));
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'first request' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'next unsent draft' } });
    await act(async () => resolveGuide?.(new Response('data: {"type":"RUN_STARTED","threadId":"' + postGuide.mock.calls[0]![0].threadId + '","runId":"' + postGuide.mock.calls[0]![0].runId + '"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"RUN_FINISHED","threadId":"' + postGuide.mock.calls[0]![0].threadId + '","runId":"' + postGuide.mock.calls[0]![0].runId + '"}\n\n')));
    expect(screen.getByLabelText('Ask a question')).toHaveValue('next unsent draft');
  });
  it('posts only a fresh minimal AG-UI request and renders incremental trusted text', async () => {
    const postGuide = vi.fn().mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'Explain the lesson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    expect(postGuide).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ role: 'user', content: 'Explain the lesson' })], tools: [], context: [], forwardedProps: { source_id: 'source-a' } }), expect.any(AbortSignal));
  });

  it('keeps a composer draft after an authoritative pre-stream missing-provider result', async () => {
    const postGuide = vi.fn().mockRejectedValue({ code: 'not_configured' });
    const onProvider = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Course assistant unavailable')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask a question')).toHaveValue('keep me');
    expect(onProvider).toHaveBeenCalledWith('not_configured');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('promotes a denied teacher action to recovery with an explicit reconnect message', async () => {
    const onRecovery = vi.fn();
    const postGuide = vi.fn().mockRejectedValue({ status: 401 });
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} onRecovery={onRecovery} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'reconnect me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Course assistant access expired. Reconnect to continue.')).toBeInTheDocument();
    expect(onRecovery).toHaveBeenCalledOnce();
  });

  it('keeps one thread identity when trusted active-phase props change', async () => {
    const postGuide = vi.fn().mockResolvedValue(new Response('', { headers: { 'content-type': 'text/event-stream' } }));
    const common = { client: { postGuide, share: vi.fn(), createProposal: vi.fn() }, allowedShareKinds: [], maxShareChars: 20, onProvider: vi.fn(), onProposal: vi.fn(), onRefresh: vi.fn() };
    const { rerender } = render(<TeacherThread {...common} sourceId="source-a" />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    const firstThread = postGuide.mock.calls[0]?.[0].threadId;
    rerender(<TeacherThread {...common} sourceId="source-b" />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledTimes(2));
    expect(postGuide.mock.calls[1]?.[0].threadId).toBe(firstThread);
    expect(postGuide.mock.calls[1]?.[0].forwardedProps).toEqual({ source_id: 'source-b' });
  });

  it('persists an inert candidate only through candidate_id and never makes a shared-run candidate actionable', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const candidateStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"profile_patch","origin":"teacher_suggested","summary":"Improve profile","target":"profile","payload":{},"target_hash":null}}}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n')); controller.close(); } });
    const postGuide = vi.fn().mockResolvedValue(new Response(candidateStream, { headers: { 'content-type': 'text/event-stream' } }));
    const createProposal = vi.fn().mockResolvedValue({ id: 'candidate-a', revision: 1, status: 'pending' });
    const onProposal = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={onProposal} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'suggest a change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('button', { name: 'Save suggested change' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save suggested change' }));
    await vi.waitFor(() => expect(createProposal).toHaveBeenCalledWith('candidate-a', expect.any(AbortSignal)));
    expect(onProposal).toHaveBeenCalledOnce();
  });

  it('shares only after explicit confirmation and clears the dialog on a failed guide without reflecting content', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const postGuide = vi.fn().mockRejectedValue({ code: 'provider_error' });
    render(<TeacherThread client={{ postGuide, share, createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['text']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    const trigger = screen.getByRole('button', { name: 'Share before asking' });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'private excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({ run_id: expect.any(String), kind: 'text', content: 'private excerpt', source_id: 'source-a' }), expect.any(AbortSignal)));
    expect(await screen.findByText('Course assistant unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Share content')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('returns focus to the Share trigger after consent is cancelled with Escape', async () => {
    render(<TeacherThread client={{ postGuide: vi.fn(), share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['selection']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    const trigger = screen.getByRole('button', { name: 'Share before asking' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Share with Course assistant' }), { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('returns focus to the Share trigger after consent is cancelled', async () => {
    render(<TeacherThread client={{ postGuide: vi.fn(), share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['selection']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    const trigger = screen.getByRole('button', { name: 'Share before asking' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('restores focus to the enabled composer immediately after a successful Share and guide settlement', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const wire = 'data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n';
    render(<TeacherThread client={{ share: vi.fn().mockResolvedValue(undefined), postGuide: vi.fn().mockResolvedValue(new Response(wire)), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['text']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    const trigger = screen.getByRole('button', { name: 'Share before asking' });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    const composer = screen.getByLabelText('Ask a question');
    await vi.waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(composer).toHaveValue('');
      expect(composer).toHaveFocus();
    });
    expect(trigger).toBeDisabled();
  });

  it('keeps composer focus through the next message after a successful Share settles', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const wire = 'data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n';
    render(<TeacherThread client={{ share: vi.fn().mockResolvedValue(undefined), postGuide: vi.fn().mockResolvedValue(new Response(wire)), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['text']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share before asking' }));
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    const composer = screen.getByLabelText('Ask a question');
    await vi.waitFor(() => expect(composer).toHaveFocus());
    fireEvent.change(composer, { target: { value: 'n' } });
    expect(composer).toHaveFocus();
    fireEvent.change(composer, { target: { value: 'next request' } });
    expect(composer).toHaveFocus();
  });

  it('clears deferred Share restoration while recovering', async () => {
    let resolveGuide: ((response: Response) => void) | undefined;
    const postGuide = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { resolveGuide = resolve; }));
    const common = { client: { share: vi.fn().mockResolvedValue(undefined), postGuide, createProposal: vi.fn() }, sourceId: 'source-a', allowedShareKinds: ['text'] as Array<'text'>, maxShareChars: 20, onProvider: vi.fn(), onProposal: vi.fn(), onRefresh: vi.fn() };
    const { rerender } = render(<TeacherThread {...common} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask safely' } });
    const trigger = screen.getByRole('button', { name: 'Share before asking' });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    rerender(<TeacherThread {...common} recovery />);
    const composer = screen.getByLabelText('Ask a question');
    composer.focus();
    rerender(<TeacherThread {...common} recovery={false} />);
    await vi.waitFor(() => expect(composer).toHaveFocus());
    expect(trigger).not.toHaveFocus();
    await act(async () => resolveGuide?.(new Response('')));
  });

  it('captures only after disclosure confirmation and binds one excerpt to one Share then Guide run ID', async () => {
    const order: string[] = [];
    const captureShare = vi.fn().mockResolvedValue({ kind: 'selection' as const, content: 'safe', label: 'main.py' });
    const share = vi.fn().mockImplementation(async () => { order.push('share'); });
    const postGuide = vi.fn().mockImplementation(async (body: { threadId: string; runId: string }) => {
      order.push('guide');
      return new Response(`data: {"type":"RUN_STARTED","threadId":"${body.threadId}","runId":"${body.runId}"}\n\ndata: {"type":"RUN_FINISHED","threadId":"${body.threadId}","runId":"${body.runId}"}\n\n`);
    });
    render(<TeacherThread client={{ share, postGuide, createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['selection']} maxShareChars={4} captureShare={captureShare} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'use excerpt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share before asking' }));
    expect(captureShare).not.toHaveBeenCalled();
    expect(screen.getByText(/one run only/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    expect(order).toEqual(['share', 'guide']);
    expect(share.mock.calls[0]![0].run_id).toBe(postGuide.mock.calls[0]![0].runId);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ kind: 'selection', content: 'safe', label: 'main.py', source_id: 'source-a' }), expect.any(AbortSignal));
  });

  it('never calls Share or Guide after capture rejection and never calls Guide after Share API failure', async () => {
    const captureShare = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ kind: 'selection' as const, content: 'safe' });
    const share = vi.fn().mockRejectedValue(new Error('offline'));
    const postGuide = vi.fn();
    const common = { client: { share, postGuide, createProposal: vi.fn() }, sourceId: 'source-a', allowedShareKinds: ['selection'] as Array<'selection'>, maxShareChars: 4, onProvider: vi.fn(), onProposal: vi.fn(), onRefresh: vi.fn() };
    const view = render(<TeacherThread {...common} captureShare={captureShare} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'ask' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share before asking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    expect(await screen.findByText('Could not capture that content. Nothing was shared.')).toBeInTheDocument();
    expect(share).not.toHaveBeenCalled();
    expect(postGuide).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Share and ask' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(captureShare).toHaveBeenCalledTimes(2);
    expect(postGuide).not.toHaveBeenCalled();
    view.unmount();
  });

  it('renders each assistant delta before the terminal event and retains it after RUN_ERROR', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const guide = new ReadableStream<Uint8Array>({ start(next) { controller = next; } });
    const postGuide = vi.fn().mockResolvedValue(new Response(guide, { headers: { 'content-type': 'text/event-stream' } }));
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'stream it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    await act(async () => controller!.enqueue(new TextEncoder().encode('data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"partial"}\n\n')));
    expect(await screen.findByText('partial')).toBeInTheDocument();
    await act(async () => { controller!.enqueue(new TextEncoder().encode('data: {"type":"RUN_ERROR","message":"The provider request failed."}\n\n')); controller!.close(); });
    expect(await screen.findByText('The teacher run failed. Try again with a new request.')).toBeInTheDocument();
    expect(screen.getByText('partial')).toBeInTheDocument();
  });

  it('retires a candidate after its POST succeeds even when the refresh fails and never posts twice', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const wire = 'data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"profile_patch","origin":"teacher_suggested","summary":"Improve profile","target":"profile","payload":{},"target_hash":null}}}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n';
    const postGuide = vi.fn().mockResolvedValue(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    const createProposal = vi.fn().mockResolvedValue({ id: 'proposal-a', revision: 1, status: 'pending' });
    const onProposal = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={onProposal} onRefresh={vi.fn().mockRejectedValue(new Error('offline'))} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'suggest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const save = await screen.findByRole('button', { name: 'Save suggested change' });
    fireEvent.click(save);
    fireEvent.click(save);
    await vi.waitFor(() => expect(createProposal).toHaveBeenCalledOnce());
    expect(onProposal).toHaveBeenCalledOnce();
    expect(await screen.findByText('Suggested change saved, refresh unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save suggested change' })).not.toBeInTheDocument();
  });

  it.each([403, 404, 409])('retires a candidate after terminal %i without another POST', async (status) => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const wire = 'data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"profile_patch","origin":"teacher_suggested","summary":"Improve profile","target":"profile","payload":{},"target_hash":null}}}\n\ndata: {"type":"RUN_FINISHED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\n';
    const createProposal = vi.fn().mockRejectedValue({ status });
    render(<TeacherThread client={{ postGuide: vi.fn().mockResolvedValue(new Response(wire)), share: vi.fn(), createProposal }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'suggest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save suggested change' }));
    expect(await screen.findByText('Suggested change is unavailable. Ask a question again.')).toBeInTheDocument();
    expect(createProposal).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Save suggested change' })).not.toBeInTheDocument();
  });

  it('keeps the teacher draft editable while every teacher mutation is inert during recovery', () => {
    const postGuide = vi.fn();
    render(<TeacherThread client={{ postGuide, share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={['selection']} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} recovery />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'keep editing' } });
    expect(screen.getByLabelText('Ask a question')).toHaveValue('keep editing');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share before asking' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(postGuide).not.toHaveBeenCalled();
  });

  it('marks an unterminated assistant response with the stable interrupted-stream selector', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000001').mockReturnValueOnce('00000000-0000-4000-8000-000000000002').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const wire = 'data: {"type":"RUN_STARTED","threadId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000002"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"partial"}\n\n';
    render(<TeacherThread client={{ postGuide: vi.fn().mockResolvedValue(new Response(wire)), share: vi.fn(), createProposal: vi.fn() }} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={vi.fn()} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Ask a question'), { target: { value: 'stream' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('interrupted-stream')).toHaveTextContent('partial');
  });
});

it('shows the actual authored hint text in the same conversation without marking an unconfigured provider Ready',async()=>{
 const onProvider=vi.fn();const guideAction=vi.fn().mockResolvedValue({module_id:'s01',phase_id:'read',status:'hint',hint:{id:'one',text:'Inspect the tool call ID.',objective_ids:[]},message:'Try this step before asking for another hint.'});
 render(<TeacherThread client={{postGuide:vi.fn(),share:vi.fn(),createProposal:vi.fn(),guideAction}} sourceId="source-a" allowedShareKinds={[]} maxShareChars={20} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:'Next authored hint'}));
 expect(await screen.findByText('Inspect the tool call ID.')).toBeInTheDocument();expect(onProvider).not.toHaveBeenCalled();expect(guideAction).toHaveBeenCalledOnce();
});


it('declines revisiting with the confirmed source and existing conversation without provider or progress mutation', async()=>{
 const postGuide=vi.fn(), onProvider=vi.fn(), onRefresh=vi.fn();
 const guideAction=vi.fn().mockResolvedValue({module_id:'s01',phase_id:'read',status:'declined',message:'We will continue here.'});
 const client={postGuide,share:vi.fn(),createProposal:vi.fn(),guideAction};
 const props={client,sourceId:'source-a',allowedShareKinds:[] as never[],maxShareChars:20,onProvider,onProposal:vi.fn(),onRefresh};
 const view=render(<TeacherThread {...props} contextReady={false}/>);
 expect(screen.getByRole('button',{name:'Continue without revisiting'})).toBeDisabled();
 view.rerender(<TeacherThread {...props} contextReady={true}/>);
 fireEvent.click(screen.getByRole('button',{name:'Next authored hint'}));
 await screen.findByText('We will continue here.');
 const thread=guideAction.mock.calls[0]![0].thread_id;
 fireEvent.click(screen.getByRole('button',{name:'Continue without revisiting'}));
 await waitFor(()=>expect(guideAction).toHaveBeenCalledTimes(2));
 expect(guideAction.mock.calls[1]![0]).toEqual({thread_id:thread,source_id:'source-a',action:'decline_revisit'});
 expect(postGuide).not.toHaveBeenCalled();expect(onProvider).not.toHaveBeenCalled();expect(onRefresh).not.toHaveBeenCalled();
});
