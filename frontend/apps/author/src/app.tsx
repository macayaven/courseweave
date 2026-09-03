import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { type AuthorManifest } from '@courseweave/ui';
import { AuthorApiError, createAuthorClient, type CourseResponse } from './api';
import { createDraft, draftReducer, isDraftDirty, projectDraft, type AuthorDocumentState, type DraftAction } from './draft';
import { ImportExport } from './import-export';
import { Inspector } from './inspector';
import { Outline } from './outline';
import { AuthorPreview } from './preview';
import { useBeforeUnload } from './reconnect';
import { SaveConflict, type SavedCourse } from './save-conflict';
import { ValidationSummary, type ValidationIssue } from './validation';
import { useAuthorRuntime } from './runtime';

type Client = ReturnType<typeof createAuthorClient>;

export function AuthorShell({ state, provider = 'unknown', children }: { state: string; provider?: 'unknown' | 'not_configured'; children?: ReactNode }) {
  return <main aria-label="CourseWeave Author">
    <header><p>CourseWeave</p><h1>Author</h1><p aria-live="polite">{state}</p></header>
    {children ?? <>
      <section aria-label="Outline"><h2>Outline</h2><p>Course structure will appear here.</p></section>
      <section aria-label="Inspector"><h2>Inspector</h2><p>Select an item to edit its details.</p></section>
      <section aria-label="Preview"><h2>Preview</h2><p>Preview is inert until a draft is selected.</p></section>
      <section aria-label="Curriculum teacher"><h2>Curriculum teacher</h2><p>{provider === 'not_configured' ? 'Teacher provider unavailable. Editing and preview remain available.' : 'Teacher suggestions are unavailable until a provider is configured.'}</p></section>
    </>}
  </main>;
}

function documentState(manifest: AuthorManifest): AuthorDocumentState { return { draft: createDraft(manifest), saved: manifest, selection: { type: 'course' }, validation: 'idle' }; }
function selectedPhase(state: AuthorDocumentState) {
  const selection = state.selection;
  if (selection.type !== 'phase' && selection.type !== 'surface') return null;
  const module = state.draft.modules.find((candidate) => candidate.clientKey === selection.moduleKey);
  return module?.phases.find((candidate) => candidate.clientKey === selection.phaseKey) ?? null;
}
function isAuthorManifest(value: unknown): value is AuthorManifest { return typeof value === 'object' && value !== null && (value as { schema_version?: unknown }).schema_version === 1 && Array.isArray((value as { modules?: unknown }).modules); }
function validationIssues(error: unknown): ValidationIssue[] {
  if (!(error instanceof AuthorApiError) || !Array.isArray(error.details.issues)) return [];
  return error.details.issues.flatMap((issue): ValidationIssue[] => typeof issue === 'object' && issue !== null && typeof (issue as Record<string, unknown>).path === 'string' && typeof (issue as Record<string, unknown>).code === 'string' && typeof (issue as Record<string, unknown>).message === 'string' ? [issue as ValidationIssue] : []);
}
function asSaved(course: CourseResponse): SavedCourse { return { manifest: course.manifest, raw: course.raw, etag: course.etag }; }

function AuthorEditor({ course, client, connected }: { course: CourseResponse; client: Client; connected: boolean }) {
  const [state, setState] = useState<AuthorDocumentState>(() => documentState(course.manifest as AuthorManifest));
  const [baseline, setBaseline] = useState(course);
  const [formattedJson, setFormattedJson] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [runnableIssues, setRunnableIssues] = useState<ValidationIssue[]>([]);
  const [notice, setNotice] = useState('');
  const [remoteConflict, setRemoteConflict] = useState<SavedCourse | null>(null);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const dirty = isDraftDirty(state.draft, state.saved);
  useBeforeUnload(dirty);
  useEffect(() => {
    if (course.etag === baseline.etag) return;
    if (dirty) { setRemoteConflict(asSaved(course)); return; }
    if (!isAuthorManifest(course.manifest)) return;
    setBaseline(course); setState(documentState(course.manifest)); setFormattedJson(null); setIssues([]); setRunnableIssues([]);
  }, [baseline.etag, course, dirty]);
  const dispatch = useCallback((action: DraftAction) => {
    if (action.type !== 'select') { setFormattedJson(null); setIssues([]); setRunnableIssues([]); setDraftGeneration((current) => current + 1); }
    setState((current) => draftReducer(current, action));
  }, []);
  const validate = useCallback(async (manifest: unknown, mode: 'structural' | 'runnable', signal?: AbortSignal) => {
    try {
      const result = await client.validateCourse(manifest, mode, signal);
      if (mode === 'structural') { setIssues([]); setFormattedJson(result.formatted_json); } else setRunnableIssues([]);
      return result;
    } catch (error) {
      const next = validationIssues(error);
      if (mode === 'structural') setIssues(next); else setRunnableIssues(next);
      throw error;
    }
  }, [client]);
  const runValidation = async (mode: 'structural' | 'runnable') => {
    setNotice('Checking draft…');
    try { await validate(projectDraft(state.draft), mode); setNotice(mode === 'structural' ? 'Structural validation passed.' : 'Runnable diagnostics passed.'); }
    catch { setNotice(mode === 'structural' ? 'Structural validation found issues.' : 'Runnable diagnostics found issues.'); }
  };
  const importDraft = (manifest: unknown, canonical: string) => {
    if (!isAuthorManifest(manifest)) return;
    setState((current) => ({ ...current, draft: createDraft(manifest), validation: 'valid' }));
    setFormattedJson(canonical); setIssues([]); setRunnableIssues([]); setDraftGeneration((current) => current + 1); setNotice('Imported local draft is ready to review.');
  };
  const saved = (next: SavedCourse) => {
    if (!isAuthorManifest(next.manifest)) return;
    setBaseline({ manifest: next.manifest, raw: next.raw, etag: next.etag });
    setState(documentState(next.manifest)); setFormattedJson(next.raw); setIssues([]); setRunnableIssues([]); setRemoteConflict(null); setNotice('Saved exact canonical course bytes.');
  };
  const phase = selectedPhase(state);
  return <>
    <Outline state={state} dispatch={dispatch} />
    <Inspector state={state} dispatch={dispatch} />
    <ImportExport manifest={projectDraft(state.draft)} formattedJson={formattedJson} validate={(manifest) => validate(manifest, 'structural')} onImport={importDraft} disabled={!connected} />
    <section aria-label="Validation"><h2>Validation</h2>
      <button type="button" disabled={!connected} onClick={() => void runValidation('structural')}>Validate structure</button>
      <button type="button" disabled={!connected} onClick={() => void runValidation('runnable')}>Check runnable diagnostics</button>
      <p role="status">{notice}</p><ValidationSummary issues={issues} />
    </section>
    <AuthorPreview phase={phase} issues={runnableIssues} />
    <SaveConflict manifest={projectDraft(state.draft)} etag={baseline.etag} exists={baseline.etag !== ''} dirty={dirty}
      validate={(manifest, signal) => validate(manifest, 'structural', signal)} put={(raw, etag, signal) => client.putCourse(raw, etag, signal).then(asSaved)} getLatest={(signal) => client.getCourse(signal).then(asSaved)} onSaved={saved} onCanonical={setFormattedJson}
      onReviewed={(etag) => { setBaseline((current) => ({ ...current, etag })); setRemoteConflict(null); }} remote={remoteConflict} disabled={!connected} requestGeneration={draftGeneration} onRemoteSaved={setRemoteConflict} />
    <section aria-label="Curriculum teacher"><h2>Curriculum teacher</h2><p>Teacher provider unavailable. Editing and preview remain available.</p><p role="status">{dirty ? 'Unsaved local draft.' : 'Draft matches the loaded course.'}</p></section>
  </>;
}

export function AuthorApp() {
  const runtime = useAuthorRuntime();
  const [load, setLoad] = useState<'loading' | 'ready' | 'disconnected'>('loading');
  const [course, setCourse] = useState<CourseResponse | null>(null);
  const client = useRef<Client | null>(null);
  if (runtime.status === 'ready') client.current = createAuthorClient(runtime.runtime);
  useEffect(() => {
    if (runtime.status !== 'ready') { if (course !== null) setLoad('disconnected'); return; }
    const controller = new AbortController(); setLoad(course === null ? 'loading' : 'ready');
    void client.current!.getCourse(controller.signal).then((next) => { if (!controller.signal.aborted) { setCourse(next); setLoad('ready'); } }).catch(() => { if (!controller.signal.aborted) setLoad('disconnected'); });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime]);
  if (runtime.status === 'connecting' && course === null) return <><AuthorShell state="Connecting to the trusted CourseWeave bridge." /><button type="button" onClick={runtime.retry}>Retry connection</button></>;
  if ((runtime.status !== 'ready' || load === 'disconnected') && course === null) return <><AuthorShell state="Disconnected from CourseWeave. Your unsaved work is not stored here." /><button type="button" onClick={runtime.retry}>Reconnect</button></>;
  if (load === 'loading' || course === null || client.current === null) return <AuthorShell state="Loading saved course…" />;
  const connected = runtime.status === 'ready' && load === 'ready';
  if (!isAuthorManifest(course.manifest)) return <AuthorShell state="Ready. Curriculum teacher provider unavailable." provider="not_configured" />;
  return <AuthorShell state={connected ? 'Ready. Curriculum teacher provider unavailable.' : 'Disconnected from CourseWeave. Your unsaved work remains in this tab.'} provider="not_configured"><AuthorEditor course={course} client={client.current} connected={connected} />{!connected ? <button type="button" onClick={runtime.retry}>Reconnect</button> : null}</AuthorShell>;
}
