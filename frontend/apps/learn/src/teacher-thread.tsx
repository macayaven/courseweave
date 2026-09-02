import { Button } from '@courseweave/ui';
import { useEffect, useRef, useState } from 'react';

import { consumeAguiStream, type AguiEvent } from './agui-stream';
import type { Proposal } from '@courseweave/ui/courseweave-types';
import { ShareDialog, type ShareKind } from './share-dialog';
import type { ProviderStatus } from '@courseweave/ui/courseweave-types';

type TeacherClient = {
  postGuide(body: { threadId: string; runId: string; messages: Array<{ id: string; role: 'user'; content: string }>; tools: []; context: []; forwardedProps: { source_id?: string } }, signal?: AbortSignal): Promise<Response>;
  share(body: { run_id: string; kind: ShareKind; content: string; label?: string; source_id?: string }, signal?: AbortSignal): Promise<unknown>;
  createProposal(candidateId: string, signal?: AbortSignal): Promise<Proposal>;
};

export function TeacherThread({ client, sourceId, allowedShareKinds, maxShareChars, onProvider, onProposal, onRefresh }: { client: TeacherClient; sourceId: string; allowedShareKinds: ShareKind[]; maxShareChars: number; onProvider(status: ProviderStatus): void; onProposal(proposal: Proposal): void; onRefresh(): Promise<void> }) {
  const [threadId] = useState(() => crypto.randomUUID());
  const [composer, setComposer] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ id: string; shared: boolean }>>([]);
  const active = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);

  async function persistCandidate(id: string) {
    try {
      const proposal = await client.createProposal(id);
      if (!alive.current) return;
      onProposal(proposal);
      await onRefresh();
      if (!alive.current) return;
      setCandidates((items) => items.filter((item) => item.id !== id));
    } catch {
      if (alive.current) setNotice('Suggested change is unavailable. Ask the teacher again.');
    }
  }

  async function send(shared?: { kind: ShareKind; content: string; label?: string }) {
    if (pending || composer.trim().length === 0) return;
    const controller = new AbortController();
    active.current = controller;
    const runId = crypto.randomUUID();
    setPending(true);
    setNotice(null);
    try {
      if (shared !== undefined) {
        await client.share({ run_id: runId, kind: shared.kind, content: shared.content, label: shared.label, source_id: sourceId }, controller.signal);
        if (!alive.current || controller.signal.aborted) return;
        setShareOpen(false);
      }
      const body = { threadId, runId, messages: [{ id: crypto.randomUUID(), role: 'user' as const, content: composer }], tools: [] as [], context: [] as [], forwardedProps: { source_id: sourceId } };
      const response = await client.postGuide(body, controller.signal);
      const currentText: string[] = [];
      const outcome = await consumeAguiStream(response.body!, { threadId, runId }, (event: AguiEvent) => {
        if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') currentText.push(event.delta);
      }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (outcome.status === 'finished') {
        onProvider('ready');
        if (outcome.text) setTranscript((items) => [...items, outcome.text]);
        setCandidates((items) => [...items, ...outcome.candidates.map((id) => ({ id, shared: shared !== undefined }))]);
        setComposer('');
      } else if (outcome.status === 'error') {
        onProvider('provider_error');
        setNotice(outcome.message ?? 'The teacher run failed. Try again with a new request.');
      } else setNotice('Teacher connection interrupted. Your draft is unsent.');
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      if (shared !== undefined) setShareOpen(false);
      const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
      if (code === 'not_configured') { onProvider('not_configured'); setNotice('Teacher unavailable'); }
      else if (code === 'provider_error') { onProvider('provider_error'); setNotice('Teacher unavailable'); }
      else setNotice('Teacher connection interrupted. Your draft is unsent.');
    } finally {
      if (alive.current && active.current === controller) { active.current = null; setPending(false); }
    }
  }

  return <section aria-label="Teacher thread"><h2>Teacher</h2>{transcript.map((text, index) => <p key={index}>{text}</p>)}<label>Ask the teacher<textarea value={composer} onChange={(event) => setComposer(event.target.value)} /></label><Button type="button" disabled={pending || composer.trim().length === 0} onClick={() => void send()}>Ask teacher</Button>{allowedShareKinds.length > 0 ? <Button type="button" disabled={pending || composer.trim().length === 0} onClick={() => setShareOpen(true)}>Share before asking</Button> : null}{shareOpen ? <ShareDialog maxChars={maxShareChars} allowedKinds={allowedShareKinds} onCancel={() => setShareOpen(false)} onConfirm={send} /> : null}{candidates.map((candidate) => <section key={candidate.id}><p>Suggested change ready for review.</p><Button type="button" disabled={candidate.shared} onClick={() => void persistCandidate(candidate.id)}>Save suggested change</Button></section>)}{notice ? <p role="status">{notice}</p> : null}{notice && composer.trim().length > 0 ? <Button type="button" disabled={pending} onClick={() => void send()}>Retry</Button> : null}</section>;
}
