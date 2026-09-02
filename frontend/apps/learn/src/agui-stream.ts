export type AguiEvent = {
  type: 'RUN_STARTED' | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END' | 'CUSTOM' | 'RUN_FINISHED' | 'RUN_ERROR';
  threadId?: string;
  runId?: string;
  messageId?: string;
  delta?: string;
  name?: string;
  value?: unknown;
  message?: string;
};

export interface StreamOutcome {
  status: 'finished' | 'error' | 'interrupted';
  text: string;
  candidates: string[];
  message?: string;
}

function invalid(): never { throw new Error('Invalid teacher stream.'); }

function candidateId(event: AguiEvent): string | null {
  if (event.name !== 'courseweave.proposal_candidate' || typeof event.value !== 'object' || event.value === null) return null;
  const candidate = (event.value as { candidate?: unknown }).candidate;
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as { id?: unknown }).id === 'string'
    ? (candidate as { id: string }).id : null;
}

export async function consumeAguiStream(
  body: ReadableStream<Uint8Array>,
  expected: { threadId: string; runId: string },
  onEvent: (event: AguiEvent) => void,
  signal?: AbortSignal
): Promise<StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stage: 'start' | 'message' | 'ended' | 'terminal' = 'start';
  let messageId: string | null = null;
  let text = '';
  const candidates: string[] = [];

  const consume = (record: string): StreamOutcome | null => {
    const data = record.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return null;
    let event: AguiEvent;
    try { event = JSON.parse(data) as AguiEvent; } catch { return invalid(); }
    if (!event || typeof event.type !== 'string') return invalid();
    if ((event.runId !== undefined && event.runId !== expected.runId) || (event.threadId !== undefined && event.threadId !== expected.threadId)) return invalid();
    if (stage === 'start') {
      if (event.type !== 'RUN_STARTED' || event.runId !== expected.runId || event.threadId !== expected.threadId) return invalid();
      stage = 'message';
    } else if (stage === 'message') {
      if (event.type === 'RUN_ERROR') { stage = 'terminal'; onEvent(event); return { status: 'error', text, candidates, message: 'The teacher run failed. Try again with a new request.' }; }
      if (event.type === 'TEXT_MESSAGE_START' && messageId === null && typeof event.messageId === 'string') messageId = event.messageId;
      else if (event.type === 'TEXT_MESSAGE_CONTENT' && messageId !== null && event.messageId === messageId && typeof event.delta === 'string') text += event.delta;
      else if (event.type === 'TEXT_MESSAGE_END' && messageId !== null && event.messageId === messageId) stage = 'ended';
      else return invalid();
    } else if (stage === 'ended') {
      if (event.type === 'CUSTOM') {
        const id = candidateId(event);
        if (id === null) return invalid();
        candidates.push(id);
      } else if (event.type === 'RUN_FINISHED' && event.runId === expected.runId && event.threadId === expected.threadId) {
        stage = 'terminal'; onEvent(event); return { status: 'finished', text, candidates };
      } else return invalid();
    } else return invalid();
    onEvent(event);
    return null;
  };

  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const outcome = consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (outcome !== null) return outcome;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally { reader.releaseLock(); }
  return { status: 'interrupted', text, candidates };
}
