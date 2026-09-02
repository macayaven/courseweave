import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PredictionCard } from '../src/prediction-card';

const phase = { id: 'predict', title: 'Predict', kind: 'predict' as const, completion: { type: 'prediction_recorded' as const, record_id: 'prediction-1' }, capabilities: { chat: true, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] };

afterEach(() => cleanup());

describe('PredictionCard', () => {
  it('locks result-seeking help until server state contains the required prediction', () => {
    const { rerender } = render(<PredictionCard moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction: vi.fn() }} onState={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText('Record a prediction before requesting results.')).toBeInTheDocument();
    rerender(<PredictionCard moduleId="s01" phase={phase} state={{ revision: 3, predictions: { 's01/predict/prediction-1': { text: 'my prediction' } } }} client={{ recordPrediction: vi.fn() }} onState={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText('Prediction recorded')).toBeInTheDocument();
  });

  it('records the exact prediction request with the server revision', async () => {
    const recordPrediction = vi.fn().mockResolvedValue({ revision: 3, predictions: { 's01/predict/prediction-1': { text: 'my prediction' } } });
    render(<PredictionCard moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction }} onState={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'my prediction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prediction' }));
    expect(recordPrediction).toHaveBeenCalledWith({ expected_revision: 2, operation: { type: 'record_prediction', module_id: 's01', phase_id: 'predict', record_id: 'prediction-1', text: 'my prediction' } }, expect.any(AbortSignal));
  });

  it('preserves typed text and explicitly refreshes after a revision mismatch', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const recordPrediction = vi.fn().mockRejectedValue({ code: 'revision_mismatch' });
    render(<PredictionCard moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction }} onState={vi.fn()} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'retain me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prediction' }));
    expect(await screen.findByText('State changed; review the refreshed course state.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your prediction')).toHaveValue('retain me');
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(recordPrediction).toHaveBeenCalledOnce();
  });

  it('disables duplicate submission while its request is in flight', () => {
    let resolve: (state: { revision: number }) => void = () => undefined;
    const recordPrediction = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<PredictionCard moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction }} onState={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'one attempt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prediction' }));
    expect(screen.getByRole('button', { name: 'Saving prediction' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Saving prediction' }));
    expect(recordPrediction).toHaveBeenCalledOnce();
    resolve({ revision: 3 });
  });

  it('continues a successful prediction lifecycle under the real StrictMode entry behavior', async () => {
    const onState = vi.fn();
    const recordPrediction = vi.fn().mockResolvedValue({ revision: 3, predictions: {} });
    render(<StrictMode><PredictionCard moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction }} onState={onState} onRefresh={vi.fn()} /></StrictMode>);
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'strict success' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prediction' }));
    await vi.waitFor(() => expect(onState).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Save prediction' })).not.toBeDisabled();
  });

  it('clears a draft when a new trusted phase identity replaces the current phase', () => {
    const { rerender } = render(<PredictionCard key="s01/predict-a" moduleId="s01" phase={phase} state={{ revision: 2, predictions: {} }} client={{ recordPrediction: vi.fn() }} onState={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'only phase A' } });
    rerender(<PredictionCard key="s01/predict-b" moduleId="s01" phase={{ ...phase, id: 'predict-b', completion: { type: 'prediction_recorded', record_id: 'prediction-b' } }} state={{ revision: 2, predictions: {} }} client={{ recordPrediction: vi.fn() }} onState={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByLabelText('Your prediction')).toHaveValue('');
  });
});
