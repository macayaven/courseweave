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
    ]), { threadId: 'thread-a', runId: 'run-a' }, (event) => events.push(event.type));

    expect(outcome).toEqual({ status: 'finished', text: 'hello world', candidates: [] });
    expect(events).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
  });

  it('rejects malformed, mismatched, or out-of-order events and marks unfinished streams interrupted', async () => {
    await expect(consumeAguiStream(stream(['data: not-json\n\n']), { threadId: 'thread-a', runId: 'run-a' }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"other"}\n\n']), { threadId: 'thread-a', runId: 'run-a' }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"TEXT_MESSAGE_CONTENT","delta":"bad"}\n\n']), { threadId: 'thread-a', runId: 'run-a' }, () => undefined)).rejects.toThrow('Invalid teacher stream.');
    await expect(consumeAguiStream(stream(['data: {"type":"RUN_STARTED","threadId":"thread-a","runId":"run-a"}\n\n']), { threadId: 'thread-a', runId: 'run-a' }, () => undefined)).resolves.toEqual({ status: 'interrupted', text: '', candidates: [] });
  });
});
