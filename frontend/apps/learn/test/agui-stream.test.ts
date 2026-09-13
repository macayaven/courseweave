import { describe, expect, it } from 'vitest';

import { consumeAguiStream } from '../src/agui-stream';

function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    }
  });
}

describe('consumeAguiStream', () => {
  it('accepts the official ordered events across arbitrary chunks and joins text for its run only', async () => {
    const events: string[] = [];
    const outcome = await consumeAguiStream(stream([
      'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\n',
      'data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"hel',
      'lo"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":" world"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\ndata: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\n\n'
    ]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, (event) => events.push(event.type));

    expect(outcome).toEqual({ status: 'finished', text: 'hello world', candidates: [] });
    expect(events).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  });

  it('rejects malformed, mismatched, or out-of-order events and marks unfinished streams interrupted', async () => {
    await expect(consumeAguiStream(stream(['data: not-json\n\n']), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"other"}\n\n']), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"TEXT_MESSAGE_CONTENT","delta":"bad"}\n\n']), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\n']), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).resolves.toEqual({ status: 'interrupted', text: '', candidates: [] });
  });

  it('accepts CRLF events split at every byte boundary and rejects data after a terminal event', async () => {
    const wire = 'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\r\n\r\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\r\n\r\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"ok"}\r\n\r\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\r\n\r\ndata: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\r\n\r\n';
    for (let index = 1; index < wire.length; index += 1) {
      await expect(consumeAguiStream(stream([wire.slice(0, index), wire.slice(index)]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).resolves.toEqual({ status: 'finished', text: 'ok', candidates: [] });
    }
    await expect(consumeAguiStream(stream([`${wire}data: not-json\n\n`]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
  });

  it('only exposes fully shaped current proposal candidates', async () => {
    const prefix = 'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n';
    const suffix = 'data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\n\n';
    const valid = '{"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"profile_patch","origin":"teacher_suggested","summary":"Improve profile","target":"profile","payload":{},"target_hash":null}}}';
    await expect(consumeAguiStream(stream([`${prefix}data: ${valid}\n\n${suffix}`]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).resolves.toMatchObject({ status: 'finished', candidates: ['candidate-a'] });
    const malformed = valid.replace('"target_hash":null', '"target_hash":null,"unexpected":true');
    await expect(consumeAguiStream(stream([`${prefix}data: ${malformed}\n\n${suffix}`]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
  });

  it('cancels a pending reader on abort and rejects message-less RUN_ERROR events', async () => {
    let cancelled = false;
    const pending = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    const interrupted = consumeAguiStream(pending, { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined, controller.signal);
    controller.abort();
    await expect(interrupted).resolves.toEqual({ status: 'interrupted', text: '', candidates: [] });
    expect(cancelled).toBe(true);
    await expect(consumeAguiStream(stream(['data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\ndata: {"type":"RUN_ERROR"}\n\n']), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
  });

  it('accepts a 121-emoji candidate summary because its limit is code points', async () => {
    const prefix = 'data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n';
    const suffix = 'data: {"type":"RUN_FINISHED","threadId":"thread-a","runId":"run-a"}\n\n';
    const candidate = { id: 'candidate-a', type: 'profile_patch', origin: 'teacher_suggested', summary: '😀'.repeat(121), target: 'profile', payload: {}, target_hash: null };
    await expect(consumeAguiStream(stream([`${prefix}data: ${JSON.stringify({ type: 'CUSTOM', name: 'courseweave.proposal_candidate', value: { candidate } })}\n\n${suffix}`]), { threadId: 'thread-a', runId: 'run-a', candidateTypes: ['profile_patch','manifest_replace'] }, () => undefined)).resolves.toMatchObject({ candidates: ['candidate-a'] });
  });
});

it('accepts actual api.py learner effective-policy and nullable-label Share metadata, retaining strict validation',async()=>{
 const fixture=await import('./fixtures/learner-events.json');
 for(const events of [fixture.events,fixture.shared_events]){
  const start=events[0] as {threadId:string;runId:string};
  const wire=events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('');
  await expect(consumeAguiStream(stream([wire]),start,()=>undefined)).resolves.toMatchObject({status:'finished'});
  const invalid=structuredClone(events);const context=invalid.find(event=>'name' in event&&event.name==='courseweave.turn_context') as unknown as {value:{policy:{provider_callable:unknown}}};context.value.policy.provider_callable='true';
  await expect(consumeAguiStream(stream([invalid.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')]),start,()=>undefined)).rejects.toThrow('Invalid teacher stream.');
 }
});
