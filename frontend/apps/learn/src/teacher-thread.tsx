import { Button } from '@courseweave/ui';
import { useEffect, useRef, useState } from 'react';

import { consumeAguiStream, type AguiEvent } from './agui-stream';
import type { Proposal, ProviderStatus } from '@courseweave/ui/courseweave-types';
import { ShareDialog, type ShareKind } from './share-dialog';

type TeacherClient = {
  postGuide(body: { threadId: string; runId: string; messages: Array<{ id: string; role: 'user'; content: string }>; tools: []; context: []; forwardedProps: { source_id?: string } }, signal?: AbortSignal): Promise<Response>;
  share(body: { run_id: string; kind: ShareKind; content: string; label?: string; source_id?: string }, signal?: AbortSignal): Promise<unknown>;
  createProposal(candidateId: string, signal?: AbortSignal): Promise<Proposal>;
};

type TranscriptItem = { id: string; text: string; state: 'streaming' | 'finished' | 'interrupted' | 'failed' };

export function TeacherThread({ client, sourceId, allowedShareKinds, maxShareChars, onProvider, onProposal, onRefresh, composer: controlledComposer, onComposerChange, onDraftChange, recovery = false }: { client: TeacherClient; sourceId: string; allowedShareKinds: ShareKind[]; maxShareChars: number; onProvider(status: ProviderStatus): void; onProposal(proposal: Proposal): void; onRefresh(): Promise<void>; composer?: string; onComposerChange?(value: string): void; onDraftChange?(hasDraft: boolean): void; recovery?: boolean }) {
  const [threadId] = useState(() => crypto.randomUUID());
  const [internalComposer, setInternalComposer] = useState('');
  const composer = controlledComposer ?? internalComposer;
  const setComposer = onComposerChange ?? setInternalComposer;
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ id: string; pending: boolean }>>([]);
  const active = useRef<AbortController | null>(null);
  const candidateFlights = useRef(new Map<string, AbortController>());
  const shareTrigger = useRef<HTMLSpanElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); candidateFlights.current.forEach((controller) => controller.abort()); }; }, []);
  useEffect(() => { onDraftChange?.(composer.trim().length > 0); }, [composer, onDraftChange]);
  useEffect(() => {
    if (!recovery) return;
    active.current?.abort();
    candidateFlights.current.forEach((controller) => controller.abort());
    candidateFlights.current.clear();
    setPending(false);
    setShareOpen(false);
    setCandidates([]);
    setTranscript((items) => items.filter((item) => item.state !== 'streaming'));
  }, [recovery]);

  function finishPartial(id: string, state: TranscriptItem['state']) {
    setTranscript((items) => items.map((item) => item.id === id ? { ...item, state } : item));
  }

  async function persistCandidate(id: string) {
    if (recovery) return;
    if (candidateFlights.current.has(id)) return;
    const controller = new AbortController();
    candidateFlights.current.set(id, controller);
    setCandidates((items) => items.map((item) => item.id === id ? { ...item, pending: true } : item));
    try {
      const proposal = await client.createProposal(id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onProposal(proposal);
      setCandidates((items) => items.filter((item) => item.id !== id));
      try {
        await onRefresh();
      } catch {
        if (alive.current && !controller.signal.aborted) setNotice('Suggested change saved, refresh unavailable.');
      }
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const status = typeof error === 'object' && error !== null ? (error as { status?: number }).status : undefined;
      setCandidates((items) => items.filter((item) => item.id !== id));
      setNotice(status === 403 || status === 404 || status === 409 ? 'Suggested change is unavailable. Ask the teacher again.' : 'Suggested change could not be saved.');
    } finally { candidateFlights.current.delete(id); }
  }

  async function send(shared?: { kind: ShareKind; content: string; label?: string }) {
    if (recovery || pending || composer.trim().length === 0) return;
    const controller = new AbortController();
    active.current = controller;
    const runId = crypto.randomUUID();
    const messageKey = crypto.randomUUID();
    setPending(true);
    setNotice(null);
    try {
      if (shared !== undefined) {
        await client.share({ run_id: runId, kind: shared.kind, content: shared.content, label: shared.label, source_id: sourceId }, controller.signal);
        if (!alive.current || controller.signal.aborted) return;
        setShareOpen(false);
      }
      const body = { threadId, runId, messages: [{ id: messageKey, role: 'user' as const, content: composer }], tools: [] as [], context: [] as [], forwardedProps: { source_id: sourceId } };
      const response = await client.postGuide(body, controller.signal);
      const outcome = await consumeAguiStream(response.body!, { threadId, runId }, (event: AguiEvent) => {
        if (event.type === 'TEXT_MESSAGE_START') setTranscript((items) => [...items, { id: messageKey, text: '', state: 'streaming' }]);
        if (event.type === 'TEXT_MESSAGE_CONTENT' && typeof event.delta === 'string') setTranscript((items) => items.map((item) => item.id === messageKey ? { ...item, text: item.text + event.delta } : item));
      }, controller.signal);
      if (!alive.current) return;
      if (controller.signal.aborted) { finishPartial(messageKey, 'interrupted'); return; }
      if (outcome.status === 'finished') {
        finishPartial(messageKey, 'finished');
        if (outcome.candidates.length > 0) onProvider('ready');
        setCandidates((items) => [...items, ...outcome.candidates.map((id) => ({ id, pending: false }))]);
        setComposer('');
      } else if (outcome.status === 'error') {
        finishPartial(messageKey, 'failed');
        onProvider('provider_error');
        setNotice(outcome.message ?? 'The teacher run failed. Try again with a new request.');
      } else {
        finishPartial(messageKey, 'interrupted');
        setNotice('Teacher connection interrupted. Your draft is unsent.');
      }
    } catch (error: unknown) {
      if (!alive.current) return;
      if (controller.signal.aborted) { finishPartial(messageKey, 'interrupted'); return; }
      finishPartial(messageKey, 'failed');
      if (shared !== undefined) setShareOpen(false);
      const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
      if (code === 'not_configured') { onProvider('not_configured'); setNotice('Teacher unavailable'); }
      else if (code === 'provider_error') { onProvider('provider_error'); setNotice('Teacher unavailable'); }
      else setNotice('Teacher connection interrupted. Your draft is unsent.');
    } finally {
      if (alive.current && active.current === controller) { active.current = null; setPending(false); }
    }
  }

  return <section aria-label="Teacher thread"><h2>Teacher</h2>{transcript.map((item) => <p key={item.id} data-state={item.state} data-testid={item.state === 'interrupted' ? 'interrupted-stream' : undefined}>{item.text}</p>)}<label>Ask the teacher<textarea value={composer} onChange={(event) => setComposer(event.target.value)} /></label><Button type="button" disabled={recovery || pending || composer.trim().length === 0} onClick={() => void send()}>Ask teacher</Button>{allowedShareKinds.length > 0 ? <span ref={shareTrigger}><Button type="button" disabled={recovery || pending || composer.trim().length === 0} onClick={() => setShareOpen(true)}>Share before asking</Button></span> : null}{shareOpen ? <ShareDialog maxChars={maxShareChars} allowedKinds={allowedShareKinds} onCancel={() => setShareOpen(false)} onConfirm={send} restoreFocus={() => shareTrigger.current?.querySelector('button')?.focus()} /> : null}{candidates.map((candidate) => <section key={candidate.id}><p>Suggested change ready for review.</p><Button type="button" disabled={recovery || candidate.pending} onClick={() => void persistCandidate(candidate.id)}>Save suggested change</Button></section>)}{notice ? <p role="status">{notice}</p> : null}{notice && composer.trim().length > 0 ? <Button type="button" disabled={recovery || pending} onClick={() => void send()}>Retry</Button> : null}</section>;
}
