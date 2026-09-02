import { Button, EmptyState, StatusBadge, useReducedMotion } from '@courseweave/ui';
import { findModule, findPhase, findSurface, type CourseManifest, type LearnerState, type Proposal, type ProviderStatus } from '@courseweave/ui/courseweave-types';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CourseweaveApiError, createCourseweaveClient, type StateOperation, type StoredContext } from './api';
import { Dashboard } from './dashboard';
import { PhaseCard } from './phase-card';
import { PredictionCard } from './prediction-card';
import { ProposalDrawer } from './proposal-drawer';
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
      {noDocument ? <EmptyState title="No active course document"><p>Select a course surface to continue.</p></EmptyState> : null}
      {provider === 'not_configured' ? <EmptyState title="Teacher unavailable"><p>The course remains available while a provider is configured.</p></EmptyState> : null}
      {children}
    </main>
  );
}

export function LearnApp() {
  const runtime = useRuntimeBootstrap();
  const [data, setData] = useState<{ course: CourseManifest; state: LearnerState; proposals: Proposal[]; context: StoredContext | null } | null>(null);
  const [provider] = useState<ProviderStatus>('unknown');
  const [recovery, setRecovery] = useState(false);
  const loadedSource = useRef<string | null>(null);

  const refreshDurableData = useCallback(async () => {
    if (runtime.status !== 'ready') return;
    const client = createCourseweaveClient(runtime.runtime);
    const [state, proposals] = await client.refreshLearnerData();
    setData((current) => current === null ? current : { ...current, state, proposals });
  }, [runtime]);

  useEffect(() => {
    if (runtime.status !== 'ready') {
      loadedSource.current = null;
      return;
    }
    const controller = new AbortController();
    const client = createCourseweaveClient(runtime.runtime);
    const getContext = async () => {
      try {
        return await client.getContext(controller.signal);
      } catch (error) {
        if (error instanceof CourseweaveApiError && error.status === 404) return null;
        throw error;
      }
    };
    const initialRead = loadedSource.current !== runtime.runtime.sourceId;
    const reads = initialRead
      ? Promise.all([client.getCourse(controller.signal), client.getState(controller.signal), client.getProposals(controller.signal), getContext()])
        .then(([course, state, proposals, context]) => {
          if (controller.signal.aborted) return;
          loadedSource.current = runtime.runtime.sourceId;
          setData({ course, state, proposals, context });
        })
      : getContext().then((context) => {
        if (controller.signal.aborted) return;
        setData((current) => current === null ? current : { ...current, context });
      });
    void reads
      .then(() => { if (!controller.signal.aborted) setRecovery(false); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setRecovery(true);
        }
      });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime, runtime.contextVersion]);

  if (runtime.status !== 'ready') {
    return <main className="cw-rail" data-testid="learn-rail"><EmptyState title="Connecting to CourseWeave"><p>Waiting for the trusted JupyterLab bridge.</p><Button onClick={runtime.retry}>Retry connection</Button></EmptyState></main>;
  }
  if (recovery) {
    return <main className="cw-rail" data-testid="learn-rail"><EmptyState title="Reconnect to CourseWeave"><p>The authenticated connection is unavailable. No course changes were retried.</p><Button onClick={() => { setRecovery(false); runtime.retry(); }}>Reconnect</Button></EmptyState></main>;
  }
  if (data === null) return <main className="cw-rail" data-testid="learn-rail"><p aria-live="polite">Loading course guide…</p></main>;
  const resolved = data.context?.resolved ?? null;
  const activeModule = resolved?.module_id === null || resolved === null ? null : findModule(data.course, resolved.module_id);
  const activePhase = activeModule === null || resolved?.phase_id === null || resolved === null ? null : findPhase(data.course, activeModule.id, resolved.phase_id);
  const activeSurface = activePhase === null || resolved?.surface_id === null || resolved === null ? null : findSurface(data.course, activeModule!.id, activePhase.id, resolved.surface_id);
  const active = activeModule !== null && activePhase !== null ? { moduleId: activeModule.id, phaseId: activePhase.id } : null;
  const client = createCourseweaveClient(runtime.runtime);
  const applyStateOperation = async (operation: StateOperation, signal?: AbortSignal) => {
    const next = await client.patchState({ expected_revision: data.state.revision, operation }, signal);
    setData((current) => current === null ? current : { ...current, state: next });
  };
  return <LearnHeader course={data.course} active={active} provider={provider} timeBudget={data.state.time_budget_minutes ?? null}>
    {activePhase !== null && activeModule !== null ? <PhaseCard key={`phase:${activeModule.id}/${activePhase.id}`} moduleId={activeModule.id} phase={activePhase} state={data.state} serviceOrigin={runtime.runtime.serviceOrigin} surfaceId={activeSurface?.id ?? null} videoSeconds={data.context?.context.video_seconds} onStateOperation={applyStateOperation} onRefresh={refreshDurableData} /> : null}
    {activePhase?.kind === 'predict' && activeModule !== null ? <PredictionCard key={`prediction:${activeModule.id}/${activePhase.id}`} moduleId={activeModule.id} phase={activePhase} state={data.state} client={client} onState={(state) => setData((current) => current === null ? current : { ...current, state })} onRefresh={refreshDurableData} /> : null}
    <ProposalDrawer proposals={data.proposals} state={data.state} client={client} onRefresh={refreshDurableData} onProposal={(proposal) => setData((current) => current === null ? current : { ...current, proposals: current.proposals.map((item) => item.id === proposal.id ? proposal : item) })} />
    <Dashboard course={data.course} serviceOrigin={runtime.runtime.serviceOrigin} />
  </LearnHeader>;
}
