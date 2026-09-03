import { useEffect, useRef, useState } from 'react';

export interface SavedCourse { manifest: unknown; raw: string; etag: string; }
type SaveStatus = 'idle' | 'saving' | 'conflict' | 'error';

function isStale(error: unknown): boolean { return typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 409; }

/** Direct PUT is initiated only by this explicit button; it never retries itself. */
export function SaveConflict({ manifest, etag, exists: _exists, dirty: _dirty, validate, put, getLatest, onSaved, onReviewed, onCanonical, remote = null, disabled = false, requestGeneration = 0, onRemoteSaved }: {
  manifest: unknown; etag: string; exists: boolean; dirty: boolean;
  validate(manifest: unknown, signal: AbortSignal): Promise<{ manifest: unknown; formatted_json: string }>;
  put(raw: string, etag: string, signal: AbortSignal): Promise<SavedCourse>;
  getLatest(signal: AbortSignal): Promise<SavedCourse>;
  onSaved(course: SavedCourse): void;
  onReviewed?(etag: string): void;
  onCanonical?(formattedJson: string): void;
  remote?: SavedCourse | null;
  disabled?: boolean;
  requestGeneration?: number;
  onRemoteSaved?(course: SavedCourse): void;
}) {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [latest, setLatest] = useState<SavedCourse | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const draftGeneration = useRef(requestGeneration);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (remote !== null) { setLatest(remote); setStatus('conflict'); } }, [remote]);
  useEffect(() => { if (draftGeneration.current !== requestGeneration) controller.current?.abort(); draftGeneration.current = requestGeneration; }, [requestGeneration]);
  const save = async () => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const operation = ++generation.current; const draftAtStart = draftGeneration.current; setStatus('saving'); setError(''); setLatest(null);
    try {
      const checked = await validate(manifest, current.signal);
      if (current.signal.aborted || operation !== generation.current || draftAtStart !== draftGeneration.current) return;
      onCanonical?.(checked.formatted_json);
      const saved = await put(checked.formatted_json, etag, current.signal);
      if (current.signal.aborted || operation !== generation.current) return;
      if (draftAtStart !== draftGeneration.current) { onRemoteSaved?.(saved); setStatus('idle'); return; }
      onSaved(saved); setStatus('idle');
    } catch (failure) {
      if (current.signal.aborted || operation !== generation.current) return;
      if (!isStale(failure)) { setError('Save failed. Your local draft remains only in this tab.'); setStatus('error'); return; }
      try {
        const remote = await getLatest(current.signal);
        if (current.signal.aborted || operation !== generation.current) return;
        setLatest(remote); setStatus('conflict');
      } catch {
        if (!current.signal.aborted && operation === generation.current) { setError('Could not load the remote course. Your local draft remains available.'); setStatus('error'); }
      }
    }
  };
  return <section aria-label="Save and recovery"><h2>Save and recovery</h2>
    <button type="button" disabled={disabled || status === 'saving'} onClick={() => void save()}>Save course</button>
    {status === 'saving' ? <p role="status">Validating before save…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {status === 'conflict' && latest !== null ? <section aria-label="Remote conflict" role="alert"><h3>The remote version changed</h3>
      <p>Your local draft has not been overwritten. Review both canonical versions, then choose deliberately.</p>
      <h4>Remote canonical JSON</h4><pre>{latest.raw}</pre>
      <button type="button" onClick={() => { onReviewed?.(latest.etag); setStatus('idle'); }}>Keep my draft after review</button>
      <button type="button" onClick={() => { if (window.confirm('Replace your local draft with the latest saved course?')) onSaved(latest); }}>Use latest</button>
    </section> : null}
  </section>;
}
