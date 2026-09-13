import {
  Button,
  EmptyState,
  StatusBadge,
  useReducedMotion,
} from "@courseweave/ui";
import {
  findModule,
  findPhase,
  findSurface,
  type CourseManifest,
  type LearnerState,
  type Proposal,
  type ProviderStatus,
} from "@courseweave/ui/courseweave-types";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CourseweaveApiError,
  createCourseweaveClient,
  type StateOperation,
  type StoredContext,
} from "./api";
import { Dashboard } from "./dashboard";
import { PhaseCard } from "./phase-card";
import { LearningMemory } from "./learning-memory";
import { ProposalDrawer } from "./proposal-drawer";
import { TeacherThread } from "./teacher-thread";
import { ReconnectPanel } from "./reconnect";
import { useReaderRoute } from "./reader-routes";
import {
  useParentCapture,
  useRuntimeBootstrap,
  type TrustedRuntimeConfiguration,
} from "./runtime";
import { SurfaceReader } from "./surface-reader";

export interface LearnHeaderProps {
  course: CourseManifest;
  active: { moduleId: string; phaseId: string } | null;
  provider: ProviderStatus;
  timeBudget: number | null;
  children?: ReactNode;
}

function activeLabels(
  course: CourseManifest,
  active: LearnHeaderProps["active"],
) {
  const module = course.modules.find((item) => item.id === active?.moduleId);
  const phase = module?.phases.find((item) => item.id === active?.phaseId);
  return { module, phase };
}

function useNarrowRail(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 320);
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= 320);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

export function LearnHeader({
  course,
  active,
  provider,
  timeBudget,
  children,
}: LearnHeaderProps) {
  const reducedMotion = useReducedMotion();
  const narrowRail = useNarrowRail();
  const { module, phase } = activeLabels(course, active);
  return (
    <main
      className={`cw-rail ${narrowRail ? "cw-rail--narrow" : ""} ${reducedMotion ? "cw-reduced-motion" : ""}`}
      style={{
        ...(narrowRail ? { maxWidth: "320px", overflowX: "hidden" } : {}),
        ...(reducedMotion ? { transition: "none", animation: "none" } : {}),
      }}
      data-testid="learn-rail"
    >
      <header>
        <p className="cw-eyebrow">CourseWeave</p>
        <h1>{course.title}</h1>
        {module && phase ? (
          <p aria-label="Current location">
            <span>{module.title}</span> · <span>{phase.title}</span>
          </p>
        ) : null}
        {timeBudget !== null ? (
          <p>
            Time budget: <span>{timeBudget} min</span>
          </p>
        ) : null}
        <StatusBadge unavailable={provider !== "ready"}>
          {provider === "ready"
            ? "Ready"
            : provider === "not_configured" || provider === "provider_error"
              ? "Unavailable"
              : "Connection not checked"}
        </StatusBadge>
      </header>

      {provider === "not_configured" ? (
        <details className="cw-provider-detail">
          <summary>Assistant connection unavailable</summary>
          <p>
            Reading, records and authored hints remain available. Configure a
            provider to discuss the course.
          </p>
        </details>
      ) : null}
      {children}
    </main>
  );
}

function UnsentDrafts({
  composer,
  onComposer,
  proposalDrafts,
  onProposalDraft,
}: {
  composer: string;
  onComposer(value: string): void;
  proposalDrafts: Record<string, string>;
  onProposalDraft(id: string, value: string): void;
}) {
  const entries = Object.entries(proposalDrafts).filter(
    ([, value]) => value.trim().length > 0,
  );
  return (
    <section aria-label="Unsent drafts">
      <p>Your draft is unsent.</p>
      {composer.trim().length > 0 ? (
        <label>
          Ask a question
          <textarea
            value={composer}
            onChange={(event) => onComposer(event.target.value)}
          />
        </label>
      ) : null}
      {entries.map(([id, value]) => (
        <label key={id}>
          Unsent edit for {id}
          <input
            value={value}
            onChange={(event) => onProposalDraft(id, event.target.value)}
          />
        </label>
      ))}
    </section>
  );
}

function ReaderNavigation({
  course,
  runtime,
  moduleId,
  phaseId,
  activeSurface,
  contextVersion,
  state,
}: {
  course: CourseManifest;
  runtime: TrustedRuntimeConfiguration;
  moduleId: string | null;
  phaseId: string | null;
  activeSurface: ReturnType<typeof findSurface>;
  contextVersion: number;
  state: LearnerState;
}) {
  const { route, requestNavigation } = useReaderRoute(
    course,
    runtime,
    moduleId !== null && phaseId !== null && activeSurface !== null
      ? { moduleId, phaseId, surface: activeSurface }
      : null,
    contextVersion,
  );
  return (
    <>
      {route === null || !route.parentOpened ? null : (
        <section className="cw-surface-reader" aria-label="Course reader">
          <SurfaceReader
            surface={route.surface}
            htmlSource={route.htmlSource}
            serviceOrigin={runtime.expectedParentOrigin}
            parentOwnsReader={route.parentOpened}
          />
        </section>
      )}
      <Dashboard
        course={course}
        state={state}
        active={moduleId && phaseId ? { moduleId, phaseId } : null}
        expectedParentOrigin={runtime.expectedParentOrigin}
        onOpenSurface={requestNavigation}
      />
    </>
  );
}

export function LearnApp() {
  const runtime = useRuntimeBootstrap();
  const [data, setData] = useState<{
    course: CourseManifest;
    state: LearnerState;
    proposals: Proposal[];
    context: StoredContext | null;
    contextVersion: number;
  } | null>(null);
  const [privacyReset, setPrivacyReset] = useState(0);
  const proposalGeneration = useRef(0);
  const [provider, setProvider] = useState<ProviderStatus>("unknown");
  const [recovery, setRecovery] = useState(false);
  const [teacherComposer, setTeacherComposer] = useState("");
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [sharedRunPending, setSharedRunPending] = useState(false);
  const [teacherHasTranscript, setTeacherHasTranscript] = useState(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const durableEpoch = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const refreshRead = useRef<AbortController | null>(null);
  const retainedRuntime = useRef<TrustedRuntimeConfiguration | null>(null);
  if (runtime.status === "ready") retainedRuntime.current = runtime.runtime;
  const captureShare = useParentCapture(
    runtime.status === "ready" && !recovery ? runtime.runtime : null,
  );

  const refreshDurableData = useCallback(async () => {
    if (runtime.status !== "ready" || recovery) return;
    refreshRead.current?.abort();
    const controller = new AbortController();
    refreshRead.current = controller;
    const client = createCourseweaveClient(runtime.runtime);
    try {
      const epoch = durableEpoch.current;
      const [snapshot, proposals] = await Promise.all([
        client.getBootstrap(controller.signal),
        client.getProposals(controller.signal),
      ]);
      if (
        !controller.signal.aborted &&
        refreshRead.current === controller &&
        epoch === durableEpoch.current
      )
        setData((current) =>
          current === null || snapshot.revision < current.state.revision
            ? current
            : {
                ...current,
                course: snapshot.manifest,
                state: snapshot,
                proposals,
              },
        );
    } finally {
      if (refreshRead.current === controller) refreshRead.current = null;
    }
  }, [runtime, recovery]);

  useEffect(() => {
    setProvider("unknown");
  }, [runtime.status, runtime.runtime]);

  const reconnect = useCallback(async () => {
    activeRead.current?.abort();
    refreshRead.current?.abort();
    setRecovery(true);
    runtime.retry();
  }, [runtime]);
  const enterRecovery = useCallback(() => setRecovery(true), []);

  useEffect(() => {
    if (runtime.status !== "ready") {
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
        if (error instanceof CourseweaveApiError && error.status === 404)
          return null;
        throw error;
      }
    };
    const epoch = durableEpoch.current;
    const reads = Promise.all([
      client.getBootstrap(controller.signal),
      client.getProposals(controller.signal),
      getContext(),
    ]).then(([snapshot, proposals, context]) => {
      if (controller.signal.aborted || activeRead.current !== controller)
        return;
      setData((current) => {
        if (
          current &&
          (snapshot.revision < current.state.revision ||
            epoch !== durableEpoch.current)
        )
          return {
            ...current,
            context,
            contextVersion: runtime.contextVersion,
          };
        return {
          course: snapshot.manifest,
          state: snapshot,
          proposals,
          context,
          contextVersion: runtime.contextVersion,
        };
      });
    });
    void reads
      .then(() => {
        if (!controller.signal.aborted) setRecovery(false);
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setRecovery(true);
        }
      });
    return () => {
      controller.abort();
      if (activeRead.current === controller) activeRead.current = null;
    };
  }, [runtime.status, runtime.runtime, runtime.contextVersion, privacyReset]);

  const retainSession =
    teacherHasTranscript ||
    teacherComposer.trim().length > 0 ||
    Object.values(proposalDrafts).some((draft) => draft.trim().length > 0);
  if (
    runtime.status !== "ready" &&
    (data === null || retainedRuntime.current === null || !retainSession)
  ) {
    const hasDraft =
      teacherComposer.trim().length > 0 ||
      Object.values(proposalDrafts).some((draft) => draft.trim().length > 0);
    return (
      <main className="cw-rail" data-testid="learn-rail">
        <EmptyState title="Connecting to CourseWeave">
          <p>Waiting for the trusted JupyterLab bridge.</p>
          <Button type="button" onClick={runtime.retry}>
            Retry connection
          </Button>
          {data !== null && hasDraft ? (
            <UnsentDrafts
              composer={teacherComposer}
              onComposer={setTeacherComposer}
              proposalDrafts={proposalDrafts}
              onProposalDraft={(id, value) =>
                setProposalDrafts((drafts) => ({ ...drafts, [id]: value }))
              }
            />
          ) : null}
        </EmptyState>
      </main>
    );
  }
  if (recovery && data === null) {
    return (
      <main className="cw-rail" data-testid="learn-rail">
        <ReconnectPanel hasDraft={false} onReconnect={reconnect} />
      </main>
    );
  }
  if (data === null)
    return (
      <main className="cw-rail" data-testid="learn-rail">
        <p aria-live="polite">Loading course guide…</p>
      </main>
    );
  const activeRuntime =
    runtime.status === "ready" ? runtime.runtime : retainedRuntime.current!;
  const resolved = data.context?.resolved ?? null;
  const activeModule =
    resolved?.module_id === null || resolved === null
      ? null
      : findModule(data.course, resolved.module_id);
  const activePhase =
    activeModule === null || resolved?.phase_id === null || resolved === null
      ? null
      : findPhase(data.course, activeModule.id, resolved.phase_id);
  const activeSurface =
    activePhase === null || resolved?.surface_id === null || resolved === null
      ? null
      : findSurface(
          data.course,
          activeModule!.id,
          activePhase.id,
          resolved.surface_id,
        );
  const active =
    activeModule !== null && activePhase !== null
      ? { moduleId: activeModule.id, phaseId: activePhase.id }
      : null;
  const client = createCourseweaveClient(activeRuntime);
  const availability =
    activeModule && activePhase
      ? data.state.teacher_availability[`${activeModule.id}/${activePhase.id}`]
      : undefined;
  const allowedShareKinds = availability?.allowed_share_kinds ?? [];
  const applyStateOperation = async (
    operation: StateOperation,
    signal?: AbortSignal,
  ) => {
    if (recovery) throw new Error("Reconnect before saving.");
    const current = dataRef.current;
    if (!current) throw new Error("Course state unavailable.");
    durableEpoch.current += 1;
    refreshRead.current?.abort();
    const ownership = proposalGeneration.current;
    const next = await client.patchState(
      { expected_revision: current.state.revision, operation },
      signal,
    );
    if (signal?.aborted || ownership !== proposalGeneration.current) return;
    durableEpoch.current += 1;
    const removed =
      operation.type === "reset_state" || operation.type === "delete_state";
    if (removed) {
      proposalGeneration.current += 1;
      setPrivacyReset(proposalGeneration.current);
      activeRead.current?.abort();
      refreshRead.current?.abort();
      setData((previous) =>
        previous === null
          ? previous
          : { ...previous, state: next, proposals: [] },
      );
    }
    if (next.curriculum_digest !== current.state.curriculum_digest) {
      await refreshDurableData();
      return;
    }
    setData((previous) =>
      previous === null || next.revision < previous.state.revision
        ? previous
        : {
            ...previous,
            state: next,
            ...(removed ? { proposals: [] } : {}),
          },
    );
  };
  const teacherEnabled =
    !recovery &&
    availability?.provider_callable === true &&
    !runtime.contextPending &&
    data.contextVersion === runtime.contextVersion;
  const unmet =
    activePhase?.completion?.requirements.filter((requirement) =>
      availability?.unmet_requirement_ids.includes(requirement.id),
    ) ?? [];
  const teacherLockReason =
    runtime.contextPending || data.contextVersion !== runtime.contextVersion
      ? "Confirming your current activity…"
      : activePhase === null
        ? "Open a course activity to begin discussion."
        : unmet.length
          ? `Before discussion: ${unmet.map((requirement) => requirement.prompt).join(" ")}`
          : availability?.mode === "observer_only"
            ? "Discussion is not enabled for this activity."
            : availability?.mode === "disabled"
              ? "Assistant discussion is disabled for this activity."
              : "Discussion is unavailable until the activity is confirmed.";
  const discuss = (prompt: string) => {
    setTeacherComposer(prompt);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(".cw-composer textarea")
        ?.focus(),
    );
  };
  return (
    <LearnHeader
      course={data.course}
      active={active}
      provider={provider}
      timeBudget={data.state.time_budget_minutes ?? null}
    >
      <div className="cw-course-panel">
        <ReaderNavigation
          course={data.course}
          runtime={activeRuntime}
          moduleId={activeModule?.id ?? null}
          phaseId={activePhase?.id ?? null}
          activeSurface={activeSurface}
          contextVersion={data.contextVersion}
          state={data.state}
        />
        {activePhase !== null && activeModule !== null ? (
          <PhaseCard
            showOpen={false}
            showHeading={false}
            key={`phase:${activeModule.id}/${activePhase.id}:${privacyReset}`}
            moduleId={activeModule.id}
            phase={activePhase}
            state={data.state}
            serviceOrigin={activeRuntime.serviceOrigin}
            surfaceId={activeSurface?.id ?? null}
            videoSeconds={data.context?.context.video_seconds}
            onStateOperation={applyStateOperation}
            onRefresh={refreshDurableData}
            recovery={recovery}
            onRecovery={enterRecovery}
            onDiscuss={discuss}
          />
        ) : null}
        <LearningMemory
          state={data.state}
          onStateOperation={applyStateOperation}
          onRefresh={refreshDurableData}
          recovery={recovery}
          onRecovery={enterRecovery}
        />
      </div>
      <TeacherThread
        contextReady={
          !runtime.contextPending &&
          data.contextVersion === runtime.contextVersion &&
          activePhase !== null
        }
        privacyReset={privacyReset}
        activityLabel={
          activePhase
            ? `${activeModule!.title} · ${activePhase.title}`
            : data.course.title
        }
        activityKey={
          active ? `${active.moduleId}/${active.phaseId}` : undefined
        }
        client={client}
        sourceId={activeRuntime.sourceId}
        allowedShareKinds={allowedShareKinds}
        maxShareChars={
          availability?.max_shared_chars ??
          data.course.policies.max_shared_chars
        }
        captureShare={captureShare}
        onProvider={setProvider}
        onProposal={(proposal) =>
          setData((current) =>
            current === null || privacyReset !== proposalGeneration.current
              ? current
              : {
                  ...current,
                  proposals: current.proposals.some(
                    (item) => item.id === proposal.id,
                  )
                    ? current.proposals.map((item) =>
                        item.id === proposal.id ? proposal : item,
                      )
                    : [...current.proposals, proposal],
                },
          )
        }
        onRefresh={refreshDurableData}
        composer={teacherComposer}
        onComposerChange={setTeacherComposer}
        recovery={recovery}
        enabled={teacherEnabled}
        lockReason={teacherLockReason}
        onRecovery={enterRecovery}
        onSharedRunPending={setSharedRunPending}
        sharedRunPending={sharedRunPending}
        onTranscriptChange={setTeacherHasTranscript}
      />
      {data.proposals.length > 0 ||
      Object.values(proposalDrafts).some((draft) => draft.trim()) ? (
        <details className="cw-proposals">
          <summary>Suggested changes ({data.proposals.length})</summary>
          <ProposalDrawer
            key={`proposals:${privacyReset}`}
            proposals={data.proposals}
            state={data.state}
            client={client}
            onRefresh={refreshDurableData}
            onProposal={(proposal) =>
              setData((current) =>
                current === null || privacyReset !== proposalGeneration.current
                  ? current
                  : {
                      ...current,
                      proposals: current.proposals.map((item) =>
                        item.id === proposal.id ? proposal : item,
                      ),
                    },
              )
            }
            drafts={proposalDrafts}
            onDraftsChange={setProposalDrafts}
            recovery={recovery}
            sharedRunPending={sharedRunPending}
            onRecovery={enterRecovery}
          />
        </details>
      ) : null}
      {recovery ? (
        <ReconnectPanel
          hasDraft={
            teacherComposer.trim().length > 0 ||
            Object.values(proposalDrafts).some(
              (draft) => draft.trim().length > 0,
            )
          }
          onReconnect={reconnect}
        />
      ) : null}
    </LearnHeader>
  );
}
