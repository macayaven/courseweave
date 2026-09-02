import { Button, EmptyState, StatusBadge, useReducedMotion } from '@courseweave/ui';
import type { CourseManifest, ProviderStatus } from '@courseweave/ui/courseweave-types';
import { useEffect, useState, type ReactNode } from 'react';

import { createCourseweaveClient } from './api';
import { Dashboard } from './dashboard';
import { useRuntimeBootstrap } from './runtime';

export interface LearnHeaderProps {
  course: CourseManifest;
  active: { moduleId: string; phaseId: string } | null;
  provider: ProviderStatus;
  timeBudget: number | null;
  children?: ReactNode;
}

function activeLabels(course: CourseManifest, active: LearnHeaderProps['active']) {
  const module = course.modules.find((item) => item.id === active?.moduleId);
  const phase = module?.phases.find((item) => item.id === active?.phaseId);
  return { module, phase };
}

function useNarrowRail(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 320);
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= 320);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return narrow;
}

export function LearnHeader({ course, active, provider, timeBudget, children }: LearnHeaderProps) {
  const reducedMotion = useReducedMotion();
  const narrowRail = useNarrowRail();
  const { module, phase } = activeLabels(course, active);
  const noDocument = active === null && course.modules.length > 0;
  return (
    <main className={`cw-rail ${narrowRail ? 'cw-rail--narrow' : ''} ${reducedMotion ? 'cw-reduced-motion' : ''}`} style={{ ...(narrowRail ? { maxWidth: '320px', overflowX: 'hidden' } : {}), ...(reducedMotion ? { transition: 'none', animation: 'none' } : {}) }} data-testid="learn-rail">
      <header>
        <p className="cw-eyebrow">CourseWeave Learn</p>
        <h1>{course.title}</h1>
        {module && phase ? <p aria-label="Current location"><span>{module.title}</span> · <span>{phase.title}</span></p> : null}
        {timeBudget !== null ? <p>Time budget: <span>{timeBudget} min</span></p> : null}
        <StatusBadge unavailable={provider !== 'ready'}>
          {provider === 'ready' ? 'Teacher ready' : provider === 'not_configured' ? 'Provider unavailable' : 'Teacher status unknown'}
        </StatusBadge>
      </header>
      <nav aria-label="Course navigation"><Button type="button">Open course dashboard</Button></nav>
      {course.modules.length === 0 ? <EmptyState title="This course has no modules yet"><p>Ask your course author to add a module.</p></EmptyState> : null}
      {noDocument ? <EmptyState title="No active course document"><p>Select a course surface to continue.</p></EmptyState> : null}
      {provider === 'not_configured' ? <EmptyState title="Teacher unavailable"><p>The course remains available while a provider is configured.</p></EmptyState> : null}
      {children}
    </main>
  );
}

export function LearnApp() {
  const runtime = useRuntimeBootstrap();
  const [data, setData] = useState<{ course: CourseManifest; timeBudget: number | null } | null>(null);
  const [provider] = useState<ProviderStatus>('unknown');
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (runtime.status !== 'ready') return;
    const controller = new AbortController();
    const client = createCourseweaveClient(runtime.runtime);
    void Promise.all([client.getCourse(controller.signal), client.getState(controller.signal), client.getProposals(controller.signal)])
      .then(([course, state]) => {
        setData({ course, timeBudget: state.time_budget_minutes ?? null });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setRecovery(true);
        }
      });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime]);

  if (runtime.status !== 'ready') {
    return <main className="cw-rail" data-testid="learn-rail"><EmptyState title="Connecting to CourseWeave"><p>Waiting for the trusted JupyterLab bridge.</p><Button onClick={runtime.retry}>Retry connection</Button></EmptyState></main>;
  }
  if (recovery) {
    return <main className="cw-rail" data-testid="learn-rail"><EmptyState title="Reconnect to CourseWeave"><p>The authenticated connection is unavailable. No course changes were retried.</p><Button onClick={() => { setRecovery(false); runtime.retry(); }}>Reconnect</Button></EmptyState></main>;
  }
  if (data === null) return <main className="cw-rail" data-testid="learn-rail"><p aria-live="polite">Loading course guide…</p></main>;
  return <LearnHeader course={data.course} active={null} provider={provider} timeBudget={data.timeBudget}><Dashboard course={data.course} serviceOrigin={runtime.runtime.serviceOrigin} /></LearnHeader>;
}
