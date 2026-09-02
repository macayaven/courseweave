import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { LearnerPhasePreview, type AuthorManifest } from '@courseweave/ui';
import { createAuthorClient } from './api';
import { createDraft, draftReducer, isDraftDirty, type AuthorDocumentState } from './draft';
import { Inspector } from './inspector';
import { Outline } from './outline';
import { useAuthorRuntime } from './runtime';

export function AuthorShell({ state, provider = 'unknown', children }: { state: string; provider?: 'unknown' | 'not_configured'; children?: ReactNode }) {
  return <main aria-label="CourseWeave Author">
    <header><p>CourseWeave</p><h1>Author</h1><p aria-live="polite">{state}</p></header>
    {children ?? <>
    <section aria-label="Outline"><h2>Outline</h2><p>Course structure will appear here.</p></section>
    <section aria-label="Inspector"><h2>Inspector</h2><p>Select an item to edit its details.</p></section>
    <section aria-label="Preview"><h2>Preview</h2><p>Preview is inert until a draft is selected.</p></section>
    <section aria-label="Curriculum teacher"><h2>Curriculum teacher</h2>
      <p>{provider === 'not_configured' ? 'Teacher provider unavailable. Editing and preview remain available.' : 'Teacher suggestions are unavailable until a provider is configured.'}</p>
    </section>
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
function AuthorEditor({ manifest }: { manifest: AuthorManifest }) {
  const [state, dispatch] = useReducer(draftReducer, manifest, documentState);
  const phase = selectedPhase(state);
  return <>
    <Outline state={state} dispatch={dispatch} />
    <Inspector state={state} dispatch={dispatch} />
    <section aria-label="Preview"><h2>Preview</h2>{phase === null ? <p>Preview is inert until a phase is selected.</p> : <LearnerPhasePreview phase={phase} />}</section>
    <section aria-label="Curriculum teacher"><h2>Curriculum teacher</h2><p>Teacher provider unavailable. Editing and preview remain available.</p><p role="status">{isDraftDirty(state.draft, state.saved) ? 'Unsaved local draft.' : 'Draft matches the loaded course.'}</p></section>
  </>;
}

function isAuthorManifest(value: unknown): value is AuthorManifest {
  return typeof value === 'object' && value !== null && (value as { schema_version?: unknown }).schema_version === 1 && Array.isArray((value as { modules?: unknown }).modules);
}

export function AuthorApp() {
  const runtime = useAuthorRuntime();
  const [load, setLoad] = useState<'loading' | 'ready' | 'disconnected'>('loading');
  const [manifest, setManifest] = useState<AuthorManifest | null>(null);
  useEffect(() => {
    if (runtime.status !== 'ready') return;
    const controller = new AbortController();
    setLoad('loading');
    void createAuthorClient(runtime.runtime).getCourse(controller.signal)
      .then((course) => { if (!controller.signal.aborted) { setManifest(isAuthorManifest(course.manifest) ? course.manifest : null); setLoad('ready'); } })
      .catch(() => { if (!controller.signal.aborted) setLoad('disconnected'); });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime]);
  if (runtime.status === 'connecting') return <><AuthorShell state="Connecting to the trusted CourseWeave bridge." /><button type="button" onClick={runtime.retry}>Retry connection</button></>;
  if (runtime.status !== 'ready' || load === 'disconnected') return <><AuthorShell state="Disconnected from CourseWeave. Your unsaved work is not stored here." /><button type="button" onClick={runtime.retry}>Reconnect</button></>;
  if (load === 'loading') return <AuthorShell state="Loading saved course…" />;
  return <AuthorShell state="Ready. Curriculum teacher provider unavailable." provider="not_configured">{manifest === null ? undefined : <AuthorEditor manifest={manifest} />}</AuthorShell>;
}
