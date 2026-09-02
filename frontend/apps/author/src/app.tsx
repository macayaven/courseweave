import { useEffect, useState } from 'react';
import { createAuthorClient } from './api';
import { useAuthorRuntime } from './runtime';

export function AuthorShell({ state, provider = 'unknown' }: { state: string; provider?: 'unknown' | 'not_configured' }) {
  return <main aria-label="CourseWeave Author">
    <header><p>CourseWeave</p><h1>Author</h1><p aria-live="polite">{state}</p></header>
    <section aria-label="Outline"><h2>Outline</h2><p>Course structure will appear here.</p></section>
    <section aria-label="Inspector"><h2>Inspector</h2><p>Select an item to edit its details.</p></section>
    <section aria-label="Preview"><h2>Preview</h2><p>Preview is inert until a draft is selected.</p></section>
    <section aria-label="Curriculum teacher"><h2>Curriculum teacher</h2>
      <p>{provider === 'not_configured' ? 'Teacher provider unavailable. Editing and preview remain available.' : 'Teacher suggestions are unavailable until a provider is configured.'}</p>
    </section>
  </main>;
}

export function AuthorApp() {
  const runtime = useAuthorRuntime();
  const [load, setLoad] = useState<'loading' | 'ready' | 'disconnected'>('loading');
  useEffect(() => {
    if (runtime.status !== 'ready') return;
    const controller = new AbortController();
    setLoad('loading');
    void createAuthorClient(runtime.runtime).getCourse(controller.signal)
      .then(() => setLoad('ready'))
      .catch(() => { if (!controller.signal.aborted) setLoad('disconnected'); });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime]);
  if (runtime.status === 'connecting') return <><AuthorShell state="Connecting to the trusted CourseWeave bridge." /><button type="button" onClick={runtime.retry}>Retry connection</button></>;
  if (runtime.status !== 'ready' || load === 'disconnected') return <><AuthorShell state="Disconnected from CourseWeave. Your unsaved work is not stored here." /><button type="button" onClick={runtime.retry}>Reconnect</button></>;
  if (load === 'loading') return <AuthorShell state="Loading saved course…" />;
  return <AuthorShell state="Ready. Curriculum teacher provider unavailable." provider="not_configured" />;
}
