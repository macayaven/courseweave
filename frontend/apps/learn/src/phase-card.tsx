import { Button, EmptyState } from '@courseweave/ui';
import type { CoursePhase, LearnerState } from '@courseweave/ui/courseweave-types';
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
}

function SurfaceAction({ label, serviceOrigin, moduleId, phase, surfaceId }: Pick<PhaseCardProps, 'serviceOrigin' | 'moduleId' | 'phase' | 'surfaceId'> & { label: string }) {
  const surface = phase?.surfaces.find((candidate) => candidate.id === surfaceId) ?? null;
  if (phase === null || surface === null) return <p>No resolved course surface is available.</p>;
  return <Button type="button" onClick={() => postOpenSurface(serviceOrigin, { moduleId, phaseId: phase.id, surfaceId: surface.id })}>{label}</Button>;
}

export function PhaseCard({ moduleId, phase, state, serviceOrigin, surfaceId, videoSeconds, onStateOperation, onRefresh, recovery = false }: PhaseCardProps) {
  const [orientOpen, setOrientOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reflection, setReflection] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [labChecks, setLabChecks] = useState({ protocol: false, checks: false });
  const [shipVerified, setShipVerified] = useState(false);
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
  void state;
  if (phase === null) return <EmptyState title="No active course document"><p>Select a course surface to continue.</p></EmptyState>;
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
        await onRefresh();
        if (!alive.current || controller.signal.aborted) return;
        setReviewNotice('State changed; review the refreshed course state.');
      } else {
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
    case 'orient': return <section aria-label="Orientation"><h2>{phase.title}</h2><Button type="button" aria-expanded={orientOpen} onClick={() => setOrientOpen((open) => !open)}>Time and profile</Button>{orientOpen ? <p>Set a realistic time budget and review {phase.capabilities.create_profile_proposal ? 'your available profile proposal options.' : 'your learning goal.'}</p> : null}</section>;
    case 'read': return <section aria-label="Reading"><h2>{phase.title}</h2><SurfaceAction label="Open reading" serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'watch': return <section aria-label="Watching"><h2>{phase.title}</h2><SurfaceAction label={videoSeconds === null || videoSeconds === undefined ? 'Open video' : `Open video at ${Math.floor(videoSeconds)} seconds`} serviceOrigin={serviceOrigin} moduleId={moduleId} phase={phase} surfaceId={surfaceId} /></section>;
    case 'predict': return <section aria-label="Prediction prompt"><h2>{phase.title}</h2><p>Record your prediction below before requesting results.</p></section>;
    case 'experiment': return <section><h2>{phase.title}</h2><HintLadder level={phase.capabilities.hint_level} /></section>;
    case 'lab': return <section aria-label="Lab ownership checklist"><h2>{phase.title}</h2><p>Keep the implementation yours.</p><label><input type="checkbox" checked={labChecks.protocol} onChange={(event) => setLabChecks((checks) => ({ ...checks, protocol: event.target.checked }))} />I read the protocol</label><label><input type="checkbox" checked={labChecks.checks} onChange={(event) => setLabChecks((checks) => ({ ...checks, checks: event.target.checked }))} />I ran my own checks</label></section>;
    case 'review': return <section aria-label="Review actions"><h2>{phase.title}</h2><Button type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((open) => !open)}>Reflection and evidence</Button>{reviewOpen ? <><label>Reflection<textarea value={reflection} onChange={(event) => setReflection(event.target.value)} /></label><Button type="button" disabled={recovery || reviewPending || reflection.trim().length === 0 || onStateOperation === undefined} onClick={() => void submitReview({ type: 'record_reflection', module_id: moduleId, phase_id: phase.id, record_id: crypto.randomUUID(), text: reflection })}>Record reflection</Button><label>Evidence reference<input value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label><Button type="button" disabled={recovery || reviewPending || evidence.trim().length === 0 || onStateOperation === undefined} onClick={() => void submitReview({ type: 'record_evidence', module_id: moduleId, phase_id: phase.id, record_id: crypto.randomUUID(), reference: evidence })}>Record evidence</Button>{reviewNotice ? <p role="status">{reviewNotice}</p> : null}</> : null}</section>;
    case 'audit': return <section><h2>{phase.title}</h2><p role="status" aria-label="Teacher help is locked during audit">Teacher help is locked during audit</p></section>;
    case 'ship': return <section aria-label="Ship verification checklist"><h2>{phase.title}</h2><label><input type="checkbox" checked={shipVerified} onChange={(event) => setShipVerified(event.target.checked)} />I verified the named checks</label></section>;
  }
}
