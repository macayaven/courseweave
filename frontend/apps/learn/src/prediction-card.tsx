import { Button, EmptyState } from '@courseweave/ui';
import { hasStateRecord, type CoursePhase, type LearnerState } from '@courseweave/ui/courseweave-types';
import { useState } from 'react';

import type { StateOperation } from './api';

type PredictionOperation = Extract<StateOperation, { type: 'record_prediction' }>;

export interface PredictionCardProps {
  moduleId: string;
  phase: CoursePhase;
  state: LearnerState;
  client: { recordPrediction(body: { expected_revision: number; operation: PredictionOperation }): Promise<LearnerState> };
  onState(state: LearnerState): void;
  onRefresh(): Promise<void>;
}

export function PredictionCard({ moduleId, phase, state, client, onState, onRefresh }: PredictionCardProps) {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const recordId = phase.completion.type === 'prediction_recorded' ? phase.completion.record_id : null;
  const recorded = recordId !== null && hasStateRecord(state, 'predictions', moduleId, phase.id, recordId);
  if (recordId === null) return null;
  const predictionRecordId = recordId;
  async function submit() {
    try {
      const next = await client.recordPrediction({ expected_revision: state.revision, operation: { type: 'record_prediction', module_id: moduleId, phase_id: phase.id, record_id: predictionRecordId, text } });
      onState(next);
      setNotice(null);
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'revision_mismatch') {
        await onRefresh();
        setNotice('State changed; review the refreshed course state.');
      } else {
        setNotice('Prediction could not be saved. Review and try again.');
      }
    }
  }
  return <section aria-label="Prediction"><h2>Record your prediction</h2>
    {recorded ? <p>Prediction recorded</p> : <><p>Record a prediction before requesting results.</p><label>Your prediction<textarea value={text} onChange={(event) => setText(event.target.value)} /></label><Button type="button" disabled={text.trim().length === 0} onClick={() => void submit()}>Save prediction</Button></>}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
