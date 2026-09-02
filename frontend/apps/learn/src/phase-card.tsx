import { Button, EmptyState } from '@courseweave/ui';
import { hasStateRecord, type CoursePhase, type LearnerState } from '@courseweave/ui/courseweave-types';
import { useEffect, useRef, useState } from 'react';

import type { StateOperation } from './api';
import { postOpenSurface } from './dashboard';
import { HintLadder } from './hint-ladder';

export interface PhaseCardProps {
  moduleId: string;
  phase: CoursePhase | null;
  state: LearnerState;
  serviceOrigin: string;
  surfaceId: string | null;
  videoSeconds?: number | null;
  onStateOperation?(operation: StateOperation, signal?: AbortSignal): Promise<void>;
  onRefresh?(): Promise<void>;
  recovery?: boolean;
  onRecovery?(): void;
}

function SurfaceAction({ label, serviceOrigin, moduleId, phase, surfaceId }: Pick<PhaseCardProps, 'serviceOrigin' | 'moduleId' | 'phase' | 'surfaceId'> & { label: string }) {
  const surface = phase?.surfaces.find((candidate) => candidate.id === surfaceId) ?? null;
  if (phase === null || surface === null) return <p>No resolved course surface is available.</p>;
  return <Button type="button" onClick={() => postOpenSurface(serviceOrigin, { moduleId, phaseId: phase.id, surfaceId: surface.id })}>{label}</Button>;
}

export function PhaseCard({ moduleId, phase, state, serviceOrigin, surfaceId, videoSeconds, onStateOperation, onRefresh, recovery = false, onRecovery }: PhaseCardProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reflection, setReflection] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const reviewFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; reviewFlight.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!recovery) return;
    reviewFlight.current?.abort();
    setReviewPending(false);
  }, [recovery]);
  if (phase === null) return <EmptyState title="No active course document"><p>Select a course surface to continue.</p></EmptyState>;
  const completed = phase.completion.type !== 'manual' && hasStateRecord(state, 'completed_phases', moduleId, phase.id, phase.completion.record_id);
  if (completed) return <section aria-label="Phase completion"><h2>{phase.title}</h2><p role="status">Phase complete</p></section>;
  async function submitReview(operation: Extract<StateOperation, { type: 'record_reflection' | 'record_evidence' }>) {
    if (recovery || reviewPending || onStateOperation === undefined) return;
    const controller = new AbortController();
    reviewFlight.current = controller;
    setReviewPending(true);
    setReviewNotice(null);
    try {
      await onStateOperation(operation, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (operation.type === 'record_reflection') setReflection('');
      else setEvidence('');
      setReviewNotice(operation.type === 'record_reflection' ? 'Reflection recorded.' : 'Evidence recorded.');
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const conflict = typeof error === 'object' && error !== null
        && ((error as { status?: number }).status === 409 || (error as { code?: string }).code === 'revision_mismatch');
      if (conflict && onRefresh !== undefined) {
        try { await onRefresh(); setReviewNotice('State changed; review the refreshed course state.'); } catch (refreshError: unknown) {
          onRecovery?.();
          setReviewNotice('State refresh failed. Reconnect to continue.');
        }
      } else {
        const status = typeof error === 'object' && error !== null ? (error as { status?: number }).status : undefined;
        if (status === 401 || status === 403) onRecovery?.();
        setReviewNotice(operation.type === 'record_reflection' ? 'Reflection could not be recorded. Review and try again.' : 'Evidence could not be recorded. Review and try again.');
      }
    } finally {
      if (alive.current && reviewFlight.current === controller) {
        reviewFlight.current = null;
        setReviewPending(false);
      }
    }
  }
  switch (phase.kind) {
    case 'orient': return <section aria-label="Orientation"><h2>{phase.title}</h2><p>Time budget: {state.time_budget_minutes ?? 'not set'} minutes</p><SurfaceAction label="Open orientation" serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'read': return <section aria-label="Reading"><h2>{phase.title}</h2><SurfaceAction label="Open reading" serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'watch': return <section aria-label="Watching"><h2>{phase.title}</h2><SurfaceAction label={videoSeconds === null || videoSeconds === undefined ? 'Open video' : `Open video at ${Math.floor(videoSeconds)} seconds`} serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'predict': return <section aria-label="Prediction prompt"><h2>{phase.title}</h2><p>Record your prediction below before requesting results.</p></section>;
    case 'experiment': return <section><h2>{phase.title}</h2><HintLadder level={phase.capabilities.hint_level} /></section>;
    case 'lab': return <section aria-label="Lab workspace"><h2>{phase.title}</h2><p>Keep the implementation yours.</p><SurfaceAction label="Open lab" serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'review': return <section aria-label="Review actions"><h2>{phase.title}</h2><Button type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((open) => !open)}>Reflection and evidence</Button>{reviewOpen ? <><label>Reflection<textarea value={reflection} onChange={(event) => setReflection(event.target.value)} /></label><Button type="button" disabled={recovery || reviewPending || reflection.trim().length === 0 || onStateOperation === undefined} onClick={() => void submitReview({ type: 'record_reflection', module_id: moduleId, phase_id: phase.id, record_id: crypto.randomUUID(), text: reflection })}>Record reflection</Button><label>Evidence reference<input value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label><Button type="button" disabled={recovery || reviewPending || evidence.trim().length === 0 || onStateOperation === undefined} onClick={() => void submitReview({ type: 'record_evidence', module_id: moduleId, phase_id: phase.id, record_id: crypto.randomUUID(), reference: evidence })}>Record evidence</Button>{reviewNotice ? <p role="status">{reviewNotice}</p> : null}</> : null}</section>;
    case 'audit': return <section><h2>{phase.title}</h2><p role="status" aria-label="Teacher help is locked during audit">Teacher help is locked during audit</p></section>;
    case 'ship': return <section aria-label="Ship workspace"><h2>{phase.title}</h2><SurfaceAction label="Open shipment" serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
  }
}
