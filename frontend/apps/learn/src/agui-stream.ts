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

function isJsonValue(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function candidateId(event: AguiEvent): string | null {
  if (event.name !== 'courseweave.proposal_candidate' || typeof event.value !== 'object' || event.value === null || Array.isArray(event.value)) return null;
  if (Object.keys(event.value).sort().join(',') !== 'candidate') return null;
  const candidate = (event.value as { candidate?: unknown }).candidate;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
  if (Object.keys(candidate).sort().join(',') !== 'id,origin,payload,summary,target,target_hash,type') return null;
  const value = candidate as Record<string, unknown>;
  return typeof value.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) && value.id.length <= 80
    && ['profile_patch', 'manifest_replace', 'workspace_file_replace', 'phase_record'].includes(value.type as string)
    && value.origin === 'teacher_suggested'
    && typeof value.summary === 'string' && value.summary.trim().length > 0 && value.summary.length <= 240
    && isJsonValue(value.target)
    && typeof value.payload === 'object' && value.payload !== null && !Array.isArray(value.payload) && isJsonValue(value.payload)
    && (value.target_hash === null || typeof value.target_hash === 'string') ? value.id : null;
}

function recordData(record: string): string | null {
  const data = record.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
  return data.length > 0 ? data : null;
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
  let outcome: StreamOutcome | null = null;

  const consume = (record: string) => {
    const data = recordData(record);
    if (data === null) return;
    let event: AguiEvent;
    try { event = JSON.parse(data) as AguiEvent; } catch { return invalid(); }
    if (!event || typeof event.type !== 'string') return invalid();
    if ((event.runId !== undefined && event.runId !== expected.runId) || (event.threadId !== undefined && event.threadId !== expected.threadId)) return invalid();
    if (stage === 'terminal') return invalid();
    if (stage === 'start') {
      if (event.type !== 'RUN_STARTED' || event.runId !== expected.runId || event.threadId !== expected.threadId) return invalid();
      stage = 'message';
    } else if (event.type === 'RUN_ERROR') {
      stage = 'terminal';
      outcome = { status: 'error', text, candidates, message: 'The teacher run failed. Try again with a new request.' };
    } else if (stage === 'message') {
      if (event.type === 'TEXT_MESSAGE_START' && messageId === null && typeof event.messageId === 'string' && event.messageId.length > 0) messageId = event.messageId;
      else if (event.type === 'TEXT_MESSAGE_CONTENT' && messageId !== null && event.messageId === messageId && typeof event.delta === 'string') text += event.delta;
      else if (event.type === 'TEXT_MESSAGE_END' && messageId !== null && event.messageId === messageId) stage = 'ended';
      else return invalid();
    } else if (stage === 'ended') {
      if (event.type === 'CUSTOM') {
        const id = candidateId(event);
        if (id === null) return invalid();
        candidates.push(id);
      } else if (event.type === 'RUN_FINISHED' && event.runId === expected.runId && event.threadId === expected.threadId) {
        stage = 'terminal';
        outcome = { status: 'finished', text, candidates };
      } else return invalid();
    } else return invalid();
    onEvent(event);
  };

  const drain = () => {
    const boundary = /\r?\n\r?\n/.exec(buffer);
    if (boundary === null || boundary.index === undefined) return false;
    consume(buffer.slice(0, boundary.index));
    buffer = buffer.slice(boundary.index + boundary[0].length);
    return true;
  };

  try {
    while (!signal?.aborted) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      while (drain()) { /* Drain post-terminal records too. */ }
    }
    buffer += decoder.decode();
    while (drain()) { /* A decoder flush can complete the final record. */ }
    if (buffer.trim().length > 0) invalid();
  } finally { reader.releaseLock(); }
  return outcome ?? { status: 'interrupted', text, candidates };
}
