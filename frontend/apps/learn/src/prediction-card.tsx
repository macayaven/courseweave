import { Button, EmptyState } from '@courseweave/ui';
import { hasStateRecord, type CoursePhase, type LearnerState } from '@courseweave/ui/courseweave-types';
import { useEffect, useRef, useState } from 'react';

import type { StateOperation } from './api';

type PredictionOperation = Extract<StateOperation, { type: 'record_prediction' }>;

export interface PredictionCardProps {
  moduleId: string;
  phase: CoursePhase;
  state: LearnerState;
  client: { recordPrediction(body: { expected_revision: number; operation: PredictionOperation }, signal?: AbortSignal): Promise<LearnerState> };
  onState(state: LearnerState): void;
  onRefresh(): Promise<void>;
  recovery?: boolean;
}

export function PredictionCard({ moduleId, phase, state, client, onState, onRefresh, recovery = false }: PredictionCardProps) {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const flight = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flight.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!recovery) return;
    flight.current?.abort();
    setPending(false);
  }, [recovery]);
  const recordId = phase.completion.type === 'prediction_recorded' ? phase.completion.record_id : null;
  const recorded = recordId !== null && hasStateRecord(state, 'predictions', moduleId, phase.id, recordId);
  if (recordId === null) return null;
  const predictionRecordId = recordId;
  async function submit() {
    if (recovery || pending) return;
    const controller = new AbortController();
    flight.current = controller;
    setPending(true);
    try {
      const next = await client.recordPrediction({ expected_revision: state.revision, operation: { type: 'record_prediction', module_id: moduleId, phase_id: phase.id, record_id: predictionRecordId, text } }, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onState(next);
      setNotice(null);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const conflict = typeof error === 'object' && error !== null
        && ((error as { status?: number }).status === 409 || (error as { code?: string }).code === 'revision_mismatch');
      if (conflict) {
        await onRefresh();
        if (!alive.current || controller.signal.aborted) return;
        setNotice('State changed; review the refreshed course state.');
      } else {
        setNotice('Prediction could not be saved. Review and try again.');
      }
    } finally {
      if (alive.current && flight.current === controller) setPending(false);
    }
  }
  return <section aria-label="Prediction"><h2>Record your prediction</h2>
    {recorded ? <p>Prediction recorded</p> : <><p>Record a prediction before requesting results.</p><label>Your prediction<textarea value={text} onChange={(event) => setText(event.target.value)} /></label><Button type="button" disabled={recovery || text.trim().length === 0 || pending} onClick={() => void submit()}>{pending ? 'Saving prediction' : 'Save prediction'}</Button></>}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
