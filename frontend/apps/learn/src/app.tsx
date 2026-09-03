import { Button, EmptyState, StatusBadge, useReducedMotion } from '@courseweave/ui';
import { findModule, findPhase, findSurface, hasStateRecord, type CourseManifest, type LearnerState, type Proposal, type ProviderStatus } from '@courseweave/ui/courseweave-types';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CourseweaveApiError, createCourseweaveClient, type StateOperation, type StoredContext } from './api';
import { Dashboard } from './dashboard';
import { PhaseCard } from './phase-card';
import { PredictionCard } from './prediction-card';
import { ProposalDrawer } from './proposal-drawer';
import { TeacherThread } from './teacher-thread';
import { ReconnectPanel } from './reconnect';
import { useReaderRoute } from './reader-routes';
import { useParentCapture, useRuntimeBootstrap, type TrustedRuntimeConfiguration } from './runtime';
import { SurfaceReader } from './surface-reader';

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

function UnsentDrafts({ composer, onComposer, proposalDrafts, onProposalDraft }: { composer: string; onComposer(value: string): void; proposalDrafts: Record<string, string>; onProposalDraft(id: string, value: string): void }) {
  const entries = Object.entries(proposalDrafts).filter(([, value]) => value.trim().length > 0);
  return <section aria-label="Unsent drafts"><p>Your draft is unsent.</p>{composer.trim().length > 0 ? <label>Ask the teacher<textarea value={composer} onChange={(event) => onComposer(event.target.value)} /></label> : null}{entries.map(([id, value]) => <label key={id}>Unsent edit for {id}<input value={value} onChange={(event) => onProposalDraft(id, event.target.value)} /></label>)}</section>;
}

function ReaderNavigation({ course, runtime, moduleId, phaseId, activeSurface, contextVersion }: { course: CourseManifest; runtime: TrustedRuntimeConfiguration; moduleId: string | null; phaseId: string | null; activeSurface: ReturnType<typeof findSurface>; contextVersion: number }) {
  const { route, requestNavigation } = useReaderRoute(course, runtime, moduleId !== null && phaseId !== null && activeSurface !== null ? { moduleId, phaseId, surface: activeSurface } : null, contextVersion);
  return <>{route === null ? null : <section className="cw-surface-reader" aria-label="Course reader"><SurfaceReader surface={route.surface} htmlSource={route.htmlSource} serviceOrigin={runtime.expectedParentOrigin} parentOwnsReader={route.parentOpened} /></section>}<Dashboard course={course} expectedParentOrigin={runtime.expectedParentOrigin} onOpenSurface={requestNavigation} /></>;
}

export function LearnApp() {
  const runtime = useRuntimeBootstrap();
  const [data, setData] = useState<{ course: CourseManifest; state: LearnerState; proposals: Proposal[]; context: StoredContext | null; contextVersion: number } | null>(null);
  const [provider, setProvider] = useState<ProviderStatus>('unknown');
  const [recovery, setRecovery] = useState(false);
  const [teacherComposer, setTeacherComposer] = useState('');
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>({});
  const [sharedRunPending, setSharedRunPending] = useState(false);
  const [teacherHasTranscript, setTeacherHasTranscript] = useState(false);
  const loadedSource = useRef<string | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const refreshRead = useRef<AbortController | null>(null);
  const retainedRuntime = useRef<TrustedRuntimeConfiguration | null>(null);
  if (runtime.status === 'ready') retainedRuntime.current = runtime.runtime;
  const captureShare = useParentCapture(runtime.status === 'ready' && !recovery ? runtime.runtime : null);

  const refreshDurableData = useCallback(async () => {
    if (runtime.status !== 'ready' || recovery) return;
    refreshRead.current?.abort();
    const controller = new AbortController();
    refreshRead.current = controller;
    const client = createCourseweaveClient(runtime.runtime);
    try {
      const [state, proposals] = await client.refreshLearnerData(controller.signal);
      if (!controller.signal.aborted) setData((current) => current === null ? current : { ...current, state, proposals });
    } finally { if (refreshRead.current === controller) refreshRead.current = null; }
  }, [runtime, recovery]);

  useEffect(() => {
    setProvider('unknown');
  }, [runtime.status, runtime.runtime]);

  const reconnect = useCallback(async () => {
    activeRead.current?.abort();
    refreshRead.current?.abort();
    setRecovery(true);
    runtime.retry();
  }, [runtime]);
  const enterRecovery = useCallback(() => setRecovery(true), []);

  useEffect(() => {
    if (runtime.status !== 'ready') {
      loadedSource.current = null;
      refreshRead.current?.abort();
      return;
    }
    const controller = new AbortController();
    activeRead.current?.abort();
    activeRead.current = controller;
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
          setData({ course, state, proposals, context, contextVersion: runtime.contextVersion });
        })
      : getContext().then((context) => {
        if (controller.signal.aborted) return;
        setData((current) => current === null ? current : { ...current, context, contextVersion: runtime.contextVersion });
      });
    void reads
      .then(() => { if (!controller.signal.aborted) setRecovery(false); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setRecovery(true);
        }
      });
    return () => { controller.abort(); if (activeRead.current === controller) activeRead.current = null; };
  }, [runtime.status, runtime.runtime, runtime.contextVersion]);

  const retainSession = teacherHasTranscript || teacherComposer.trim().length > 0 || Object.values(proposalDrafts).some((draft) => draft.trim().length > 0);
  if (runtime.status !== 'ready' && (data === null || retainedRuntime.current === null || !retainSession)) {
    const hasDraft = teacherComposer.trim().length > 0 || Object.values(proposalDrafts).some((draft) => draft.trim().length > 0);
    return <main className="cw-rail" data-testid="learn-rail"><EmptyState title="Connecting to CourseWeave"><p>Waiting for the trusted JupyterLab bridge.</p><Button type="button" onClick={runtime.retry}>Retry connection</Button>{data !== null && hasDraft ? <UnsentDrafts composer={teacherComposer} onComposer={setTeacherComposer} proposalDrafts={proposalDrafts} onProposalDraft={(id, value) => setProposalDrafts((drafts) => ({ ...drafts, [id]: value }))} /> : null}</EmptyState></main>;
  }
  if (recovery && data === null) {
    return <main className="cw-rail" data-testid="learn-rail"><ReconnectPanel hasDraft={false} onReconnect={reconnect} /></main>;
  }
  if (data === null) return <main className="cw-rail" data-testid="learn-rail"><p aria-live="polite">Loading course guide…</p></main>;
  const activeRuntime = runtime.status === 'ready' ? runtime.runtime : retainedRuntime.current!;
  const resolved = data.context?.resolved ?? null;
  const activeModule = resolved?.module_id === null || resolved === null ? null : findModule(data.course, resolved.module_id);
  const activePhase = activeModule === null || resolved?.phase_id === null || resolved === null ? null : findPhase(data.course, activeModule.id, resolved.phase_id);
  const activeSurface = activePhase === null || resolved?.surface_id === null || resolved === null ? null : findSurface(data.course, activeModule!.id, activePhase.id, resolved.surface_id);
  const active = activeModule !== null && activePhase !== null ? { moduleId: activeModule.id, phaseId: activePhase.id } : null;
  const client = createCourseweaveClient(activeRuntime);
  const allowedShareKinds = activePhase === null ? [] : [
    ...(activePhase.capabilities.share_selection ? ['selection', 'text'] as const : []),
    ...(activePhase.capabilities.share_cell ? ['cell'] as const : []),
    ...(activePhase.capabilities.share_output ? ['output'] as const : [])
  ];
  const applyStateOperation = async (operation: StateOperation, signal?: AbortSignal) => {
    if (recovery) return;
    const next = await client.patchState({ expected_revision: data.state.revision, operation }, signal);
    setData((current) => current === null ? current : { ...current, state: next });
  };
  const predictionRequired = activePhase?.completion.type === 'prediction_recorded'
    && !hasStateRecord(data.state, 'predictions', activeModule?.id ?? '', activePhase.id, activePhase.completion.record_id);
  const teacherEnabled = !recovery && activePhase !== null && activePhase.capabilities.chat && activePhase.kind !== 'audit' && !predictionRequired;
  const teacherLockReason = activePhase === null ? 'Teacher help is unavailable until a course phase is active.'
    : activePhase.kind === 'audit' ? 'Teacher help is locked during audit.'
      : !activePhase.capabilities.chat ? 'Teacher help is locked by this course phase.'
        : predictionRequired ? 'Record your prediction before asking the teacher.' : undefined;
  return <LearnHeader course={data.course} active={active} provider={provider} timeBudget={data.state.time_budget_minutes ?? null}>
    {activePhase !== null && activeModule !== null ? <PhaseCard key={`phase:${activeModule.id}/${activePhase.id}`} moduleId={activeModule.id} phase={activePhase} state={data.state} serviceOrigin={activeRuntime.serviceOrigin} surfaceId={activeSurface?.id ?? null} videoSeconds={data.context?.context.video_seconds} onStateOperation={applyStateOperation} onRefresh={refreshDurableData} recovery={recovery} onRecovery={enterRecovery} /> : null}
    {activePhase?.kind === 'predict' && activeModule !== null ? <PredictionCard key={`prediction:${activeModule.id}/${activePhase.id}`} moduleId={activeModule.id} phase={activePhase} state={data.state} client={client} onState={(state) => setData((current) => current === null ? current : { ...current, state })} onRefresh={refreshDurableData} recovery={recovery} onRecovery={enterRecovery} /> : null}
    <ReaderNavigation course={data.course} runtime={activeRuntime} moduleId={activeModule?.id ?? null} phaseId={activePhase?.id ?? null} activeSurface={activeSurface} contextVersion={data.contextVersion} />
    <TeacherThread client={client} sourceId={activeRuntime.sourceId} allowedShareKinds={allowedShareKinds} maxShareChars={data.course.policies?.max_shared_chars ?? 8192} captureShare={captureShare} onProvider={setProvider} onProposal={(proposal) => setData((current) => current === null ? current : { ...current, proposals: current.proposals.some((item) => item.id === proposal.id) ? current.proposals.map((item) => item.id === proposal.id ? proposal : item) : [...current.proposals, proposal] })} onRefresh={refreshDurableData} composer={teacherComposer} onComposerChange={setTeacherComposer} recovery={recovery} enabled={teacherEnabled} lockReason={teacherLockReason} onRecovery={enterRecovery} onSharedRunPending={setSharedRunPending} sharedRunPending={sharedRunPending} onTranscriptChange={setTeacherHasTranscript} />
    <ProposalDrawer proposals={data.proposals} state={data.state} client={client} onRefresh={refreshDurableData} onProposal={(proposal) => setData((current) => current === null ? current : { ...current, proposals: current.proposals.map((item) => item.id === proposal.id ? proposal : item) })} drafts={proposalDrafts} onDraftsChange={setProposalDrafts} recovery={recovery} sharedRunPending={sharedRunPending} onRecovery={enterRecovery} />
    {recovery ? <ReconnectPanel hasDraft={teacherComposer.trim().length > 0 || Object.values(proposalDrafts).some((draft) => draft.trim().length > 0)} onReconnect={reconnect} /> : null}
  </LearnHeader>;
}
