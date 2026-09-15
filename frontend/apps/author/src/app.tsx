import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type AuthorManifest,
  type Proposal,
  type ProviderStatus,
} from "@courseweave/ui";
import { AuthorApiError, createAuthorClient, type CourseResponse } from "./api";
import {
  createDraft,
  draftReducer,
  isDraftDirty,
  projectDraft,
  type AuthorDocumentState,
  type DraftAction,
} from "./draft";
import { ImportExport } from "./import-export";
import { Inspector } from "./inspector";
import { Outline } from "./outline";
import { AuthorPreview, StudentPreview } from "./preview";
import { useBeforeUnload } from "./reconnect";
import { SaveConflict, type SavedCourse } from "./save-conflict";
import {
  ValidationSummary,
  pointerToControlId,
  type ValidationIssue,
} from "./validation";
import { useAuthorRuntime } from "./runtime";
import { CurriculumThread, AuthorAssistant } from "./curriculum-thread";
import { ProposalReview } from "./proposal-review";
import { CompatibilityPanel } from "./compatibility";
import { ProjectPanel, SourceLibrary, type ProjectList } from "./project-panel";
import { SourcePanel } from "./source-panel";
import { ContentPanel, type ContentChange } from "./content-panel";
import { ReviewPanel } from "./review-panel";
import { CoveragePanel } from "./coverage-panel";
import { DeliveryPanel } from "./delivery-panel";

type Client = ReturnType<typeof createAuthorClient>;
type CheckState = {
  status: "not_requested" | "checking" | "passed" | "issues";
  issues: ValidationIssue[];
};
export function AuthorShell({
  state,
  provider = "unknown",
  children,
}: {
  state: string;
  provider?: "unknown" | "not_configured";
  children?: ReactNode;
}) {
  return (
    <main aria-label="CourseWeave Author">
      <header>
        <p>CourseWeave</p>
        <h1>Author</h1>
        <p aria-live="polite">{state}</p>
      </header>
      {children ?? (
        <>
          <section aria-label="Outline">
            <h2>Outline</h2>
            <p>Course structure will appear here.</p>
          </section>
          <section aria-label="Inspector">
            <h2>Inspector</h2>
            <p>Select an item to edit its details.</p>
          </section>
          <section aria-label="Preview">
            <h2>Preview</h2>
            <p>Preview is inert until a draft is selected.</p>
          </section>
          <section aria-label="Curriculum teacher">
            <h2>Curriculum teacher</h2>
            <p>
              {provider === "not_configured"
                ? "Teacher provider unavailable. Editing and preview remain available."
                : "Teacher suggestions are unavailable until a provider is configured."}
            </p>
          </section>
        </>
      )}
    </main>
  );
}
function documentState(manifest: AuthorManifest): AuthorDocumentState {
  return {
    draft: createDraft(manifest),
    saved: manifest,
    selection: { type: "course" },
    validation: "idle",
  };
}
function isAuthorManifest(value: unknown): value is AuthorManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { schema_version?: unknown }).schema_version === 2 &&
    Array.isArray((value as { modules?: unknown }).modules)
  );
}
function selectedPhase(state: AuthorDocumentState) {
  const s = state.selection;
  if (s.type !== "phase" && s.type !== "surface") return null;
  return (
    state.draft.modules
      .find((m) => m.clientKey === s.moduleKey)
      ?.phases.find((p) => p.clientKey === s.phaseKey) ?? null
  );
}
function issues(error: unknown): ValidationIssue[] {
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
  return typeof details === "object" &&
    details !== null &&
    Array.isArray((details as { issues?: unknown }).issues)
    ? (details as { issues: unknown[] }).issues.flatMap(
        (i): ValidationIssue[] =>
          typeof i === "object" &&
          i !== null &&
          typeof (i as Record<string, unknown>).path === "string" &&
          typeof (i as Record<string, unknown>).code === "string" &&
          typeof (i as Record<string, unknown>).message === "string"
            ? [i as ValidationIssue]
            : [],
      )
    : [];
}
function savedCourse(course: CourseResponse): SavedCourse {
  return { manifest: course.manifest, raw: course.raw, etag: course.etag };
}
function preserveSelection(
  manifest: AuthorManifest,
  previous: AuthorDocumentState,
): AuthorDocumentState {
  const next = documentState(manifest);
  const s = previous.selection;
  if (s.type === "course") return next;
  const om = previous.draft.modules.find((m) => m.clientKey === s.moduleKey);
  const m = next.draft.modules.find((x) => x.id === om?.id);
  if (!m) return next;
  if (s.type === "module")
    return { ...next, selection: { type: "module", moduleKey: m.clientKey } };
  const op = om?.phases.find((p) => p.clientKey === s.phaseKey);
  const p = m.phases.find((x) => x.id === op?.id);
  if (!p)
    return { ...next, selection: { type: "module", moduleKey: m.clientKey } };
  if (s.type === "phase")
    return {
      ...next,
      selection: {
        type: "phase",
        moduleKey: m.clientKey,
        phaseKey: p.clientKey,
      },
    };
  const os = op?.surfaces.find((x) => x.clientKey === s.surfaceKey);
  const surface = p.surfaces.find((x) => x.id === os?.id);
  return surface
    ? {
        ...next,
        selection: {
          type: "surface",
          moduleKey: m.clientKey,
          phaseKey: p.clientKey,
          surfaceKey: surface.clientKey,
        },
      }
    : {
        ...next,
        selection: {
          type: "phase",
          moduleKey: m.clientKey,
          phaseKey: p.clientKey,
        },
      };
}

function selectionForPointer(
  state: AuthorDocumentState,
  pointer: string,
): AuthorDocumentState["selection"] | null {
  if (
    /^\/(id|title|description|entry_module_id|runtime|policies\/(content_sharing|durable_mutation|terminal_execution|conversation_memory|max_shared_chars|allowed_share_kinds|allowed_proposal_types|workspace_write_globs\/\d+))$/.test(
      pointer,
    )
  )
    return { type: "course" };
  const moduleMatch = pointer.match(/^\/modules\/(\d+)(?:\/(.*))?$/);
  if (moduleMatch === null) return null;
  const module = state.draft.modules[Number(moduleMatch[1])];
  const rest = moduleMatch[2] ?? "";
  if (module === undefined) return null;
  if (/^(id|title|description)$/.test(rest))
    return { type: "module", moduleKey: module.clientKey };
  if (rest === "phases") return { type: "module", moduleKey: module.clientKey };
  const phaseMatch = rest.match(/^phases\/(\d+)(?:\/(.*))?$/);
  if (phaseMatch === null) return null;
  const phase = module.phases[Number(phaseMatch[1])];
  const phaseRest = phaseMatch[2] ?? "";
  if (phase === undefined) return null;
  if (phaseRest === "" || phaseRest === "surfaces")
    return {
      type: "phase",
      moduleKey: module.clientKey,
      phaseKey: phase.clientKey,
    };
  if (
    /^(id|title|progress|experience\/(type|id)|teacher(?:\/.*)?|completion(?:\/.*)?|learning(?:\/.*)?)$/.test(
      phaseRest,
    )
  )
    return {
      type: "phase",
      moduleKey: module.clientKey,
      phaseKey: phase.clientKey,
    };
  const surfaceMatch = phaseRest.match(/^surfaces\/(\d+)(?:\/(.*))?$/);
  if (surfaceMatch === null) return null;
  const surface = phase.surfaces[Number(surfaceMatch[1])];
  const surfaceRest = surfaceMatch[2] ?? "";
  if (
    surfaceRest !== "" &&
    !/^(id|type|purpose|path|fragment|src|url|label|cwd|start_seconds|end_seconds|command(?:\/\d+)?|selector\/(type|match|values)(?:\/\d+)?)$/.test(
      surfaceRest,
    )
  )
    return null;
  if (surface === undefined) return null;
  if (
    (surfaceRest === "command" &&
      (surface.type !== "terminal" || surface.command.length !== 0)) ||
    (surfaceRest === "selector/values" &&
      (surface.type !== "notebook" ||
        surface.selector.type === "whole_notebook" ||
        surface.selector.values.length !== 0))
  )
    return null;
  return {
    type: "surface",
    moduleKey: module.clientKey,
    phaseKey: phase.clientKey,
    surfaceKey: surface.clientKey,
  };
}

function AuthorEditor({
  course,
  client,
  connected,
  connectionEpoch,
  courseAuthorityEpoch,
  sourceId,
  onCourseSaved,
  onDirtyChange,
  externalDirty = false,
  privateProjectId,
  authorEpoch = 0,
  onAuthorSaved = () => undefined,
  onReviewSaved,
}: {
  course: CourseResponse;
  client: Client;
  connected: boolean;
  connectionEpoch: number;
  courseAuthorityEpoch: number;
  sourceId: string;
  onCourseSaved(course: CourseResponse): void;
  onDirtyChange(dirty: boolean): void;
  externalDirty?: boolean;
  privateProjectId?: string;
  authorEpoch?: number;
  onAuthorSaved?(change: ContentChange): void;
  onReviewSaved?(id: string): void;
}) {
  const [state, setState] = useState<AuthorDocumentState>(() =>
    documentState(course.manifest as AuthorManifest),
  );
  const [baseline, setBaseline] = useState(course);
  const [formatted, setFormatted] = useState<string | null>(null);
  const [structural, setStructural] = useState<CheckState>({
    status: "not_requested",
    issues: [],
  });
  const [runnable, setRunnable] = useState<CheckState>({
    status: "not_requested",
    issues: [],
  });
  const [notice, setNotice] = useState("");
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [provider, setProvider] = useState<ProviderStatus>("unknown");
  const [proposalSavePending, setProposalSavePending] = useState(false);
  const [authorityState, setAuthorityState] = useState<
    "fresh" | "refreshing" | "blocked"
  >("fresh");
  const refreshBlocked = authorityState !== "fresh";
  const [remote, setRemote] = useState<SavedCourse | null>(null);
  const [reconnectCanonical, setReconnectCanonical] = useState<{
    generation: number;
    raw: string;
  } | null>(null);
  const [draftGeneration, setDraftGeneration] = useState(0);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const checks = useRef<{
    structural: AbortController | null;
    runnable: AbortController | null;
  }>({ structural: null, runnable: null });
  const epoch = `${draftGeneration}:${connectionEpoch}`;
  const latestEpoch = useRef(epoch);
  latestEpoch.current = epoch;
  const latestConnectionEpoch = useRef(connectionEpoch);
  latestConnectionEpoch.current = connectionEpoch;
  const currentState = useRef(state);
  currentState.current = state;
  const dirty = isDraftDirty(state.draft, state.saved);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useBeforeUnload(dirty);
  useEffect(() => {
    checks.current.structural?.abort();
    checks.current.runnable?.abort();
  }, [epoch]);
  const initialProposalsLoaded = useRef(false);
  const observedConnectionEpoch = useRef(connectionEpoch);
  const reconnectEpoch = useRef<number | null>(null);
  const proposalsEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!connected) {
      setAuthorityState("blocked");
      return;
    }
    const reconnecting = observedConnectionEpoch.current !== connectionEpoch;
    if (reconnecting) {
      observedConnectionEpoch.current = connectionEpoch;
      reconnectEpoch.current = connectionEpoch;
      setAuthorityState("refreshing");
    }
    if (initialProposalsLoaded.current && !reconnecting) return;
    const getProposals = client.getProposals;
    if (typeof getProposals !== "function") {
      setAuthorityState("blocked");
      return;
    }
    setAuthorityState("refreshing");
    const controller = new AbortController();
    const started = connectionEpoch;
    void Promise.resolve(getProposals(controller.signal))
      .then((items) => {
        if (
          controller.signal.aborted ||
          started !== latestConnectionEpoch.current
        )
          return;
        if (!Array.isArray(items)) {
          setAuthorityState("blocked");
          return;
        }
        initialProposalsLoaded.current = true;
        proposalsEpoch.current = started;
        setProposals(items as Proposal[]);
        if (courseAuthorityEpoch === started) {
          reconnectEpoch.current = null;
          setAuthorityState("fresh");
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          started === latestConnectionEpoch.current
        )
          setAuthorityState("blocked");
      });
    return () => controller.abort();
  }, [client, connected, connectionEpoch, courseAuthorityEpoch]);
  useEffect(() => {
    if (
      reconnectEpoch.current === connectionEpoch &&
      proposalsEpoch.current === connectionEpoch &&
      courseAuthorityEpoch === connectionEpoch
    ) {
      reconnectEpoch.current = null;
      setAuthorityState("fresh");
    }
  }, [connectionEpoch, courseAuthorityEpoch]);
  useEffect(() => {
    if (course.etag === baseline.etag) return;
    if (dirty) {
      const controller = new AbortController();
      const started = latestEpoch.current;
      setRemote(savedCourse(course));
      void client
        .validateCourse(
          projectDraft(state.draft),
          "structural",
          controller.signal,
        )
        .then((result) => {
          if (controller.signal.aborted || started !== latestEpoch.current)
            return;
          setReconnectCanonical({
            generation: draftGeneration,
            raw: result.formatted_json,
          });
        })
        .catch(() => undefined);
      return () => controller.abort();
    }
    if (isAuthorManifest(course.manifest)) {
      setBaseline(course);
      setState(documentState(course.manifest));
      setFormatted(null);
      setStructural({ status: "not_requested", issues: [] });
      setRunnable({ status: "not_requested", issues: [] });
    }
  }, [baseline.etag, course, dirty, draftGeneration]);
  const dispatch = useCallback((action: DraftAction) => {
    if (action.type !== "select") {
      setFormatted(null);
      setStructural({ status: "not_requested", issues: [] });
      setRunnable({ status: "not_requested", issues: [] });
      setDraftGeneration((x) => x + 1);
    }
    setState((current) => draftReducer(current, action));
  }, []);
  const focusIssues = useCallback((all: readonly ValidationIssue[]) => {
    const issue = all.find(
      (candidate) =>
        selectionForPointer(currentState.current, candidate.path) !== null,
    );
    if (!issue) return false;
    const selection = selectionForPointer(currentState.current, issue.path);
    if (selection === null) return false;
    setState((current) => {
      const next = selectionForPointer(current, issue.path);
      return next === null ? current : { ...current, selection: next };
    });
    setFocusPath(issue.path);
    return true;
  }, []);
  useEffect(() => {
    if (focusPath === null) return;
    const control = document.getElementById(pointerToControlId(focusPath));
    if (control instanceof HTMLElement) {
      control.setAttribute(
        "aria-describedby",
        pointerToControlId(focusPath, "issue"),
      );
      control.focus();
    }
  }, [focusPath, state.selection]);
  const validate = useCallback(
    (
      manifest: unknown,
      mode: "structural" | "runnable",
      signal?: AbortSignal,
    ) => client.validateCourse(manifest, mode, signal),
    [client],
  );
  const check = async (mode: "structural" | "runnable") => {
    checks.current[mode]?.abort();
    const controller = new AbortController();
    checks.current[mode] = controller;
    const started = latestEpoch.current;
    mode === "structural"
      ? setStructural({ status: "checking", issues: [] })
      : setRunnable({ status: "checking", issues: [] });
    setNotice("Checking draft…");
    try {
      const result = await validate(
        projectDraft(state.draft),
        mode,
        controller.signal,
      );
      if (controller.signal.aborted || started !== latestEpoch.current) return;
      if (mode === "structural") {
        setStructural({ status: "passed", issues: [] });
        setFormatted(result.formatted_json);
      } else setRunnable({ status: "passed", issues: [] });
      setNotice(
        mode === "structural"
          ? "Structural validation passed."
          : "Runnable diagnostics passed.",
      );
    } catch (error) {
      if (controller.signal.aborted || started !== latestEpoch.current) return;
      const next = issues(error);
      mode === "structural"
        ? setStructural({ status: "issues", issues: next })
        : setRunnable({ status: "issues", issues: next });
      setNotice(
        mode === "structural"
          ? "Structural validation found issues."
          : "Runnable diagnostics found issues.",
      );
    }
  };
  const imported = (manifest: unknown, canonical: string) => {
    if (!isAuthorManifest(manifest)) return;
    setState((current) => ({
      ...current,
      draft: createDraft(manifest),
      validation: "valid",
    }));
    setFormatted(canonical);
    setStructural({ status: "passed", issues: [] });
    setRunnable({ status: "not_requested", issues: [] });
    setDraftGeneration((x) => x + 1);
    setNotice("Imported local draft is ready to review.");
  };
  const saved = (next: SavedCourse) => {
    if (!isAuthorManifest(next.manifest)) return;
    setBaseline({ manifest: next.manifest, raw: next.raw, etag: next.etag });
    setState((current) =>
      preserveSelection(next.manifest as AuthorManifest, current),
    );
    setFormatted(next.raw);
    setStructural({ status: "passed", issues: [] });
    setRunnable({ status: "not_requested", issues: [] });
    setRemote(null);
    onCourseSaved(next);
    setNotice("Saved exact canonical course bytes.");
  };
  const recordProposal = useCallback((next: Proposal) => {
    setProposals((current) => {
      const other = current.filter((proposal) => proposal.id !== next.id);
      return [...other, next];
    });
  }, []);
  const authorityRead = useRef<AbortController | null>(null);
  const authorityAlive = useRef(true);
  useEffect(() => {
    authorityAlive.current = true;
    return () => {
      authorityAlive.current = false;
      authorityRead.current?.abort();
    };
  }, []);
  useEffect(() => () => authorityRead.current?.abort(), [epoch, connected]);
  const refreshAuthorData = useCallback(
    async (signal?: AbortSignal) => {
      const started = connectionEpoch;
      const draftEpoch = latestEpoch.current;
      const controller = new AbortController();
      const previous = authorityRead.current;
      authorityRead.current = controller;
      previous?.abort();
      const ownsRefresh = () =>
        authorityAlive.current &&
        authorityRead.current === controller &&
        started === latestConnectionEpoch.current;
      const cancelled = () => {
        // A cancelled current read must offer Retry even if one transport takes
        // longer to settle. A replaced/old-epoch read cannot change new authority.
        if (ownsRefresh()) setAuthorityState("blocked");
      };
      const cancelFromCaller = () => controller.abort();
      controller.signal.addEventListener("abort", cancelled, { once: true });
      signal?.addEventListener("abort", cancelFromCaller, { once: true });
      setAuthorityState("refreshing");
      try {
        if (signal?.aborted) controller.abort();
        if (controller.signal.aborted) return { committed: false };
        const [courseResult, proposalsResult] = await Promise.allSettled([
          client.getCourse(controller.signal),
          client.getProposals(controller.signal),
        ]);
        if (!ownsRefresh()) return { committed: false };
        const complete =
          !controller.signal.aborted &&
          draftEpoch === latestEpoch.current &&
          courseResult.status === "fulfilled" &&
          proposalsResult.status === "fulfilled" &&
          Array.isArray(proposalsResult.value);
        if (!complete) {
          setAuthorityState("blocked");
          return { committed: false };
        }
        if (
          courseResult.status === "fulfilled" &&
          proposalsResult.status === "fulfilled"
        ) {
          onCourseSaved(courseResult.value);
          setProposals(proposalsResult.value as Proposal[]);
        }
        initialProposalsLoaded.current = true;
        proposalsEpoch.current = started;
        reconnectEpoch.current = null;
        setAuthorityState("fresh");
        return { committed: true };
      } catch {
        if (ownsRefresh()) setAuthorityState("blocked");
        return { committed: false };
      } finally {
        signal?.removeEventListener("abort", cancelFromCaller);
        controller.signal.removeEventListener("abort", cancelled);
        if (authorityRead.current === controller) authorityRead.current = null;
      }
    },
    [client, connectionEpoch, onCourseSaved],
  );
  const retryAuthority = useCallback(() => {
    void refreshAuthorData();
  }, [refreshAuthorData]);
  const phase = selectedPhase(state);
  return (
    <>
      <Outline state={state} dispatch={dispatch} />
      <Inspector state={state} dispatch={dispatch} />
      <ImportExport
        manifest={projectDraft(state.draft)}
        formattedJson={formatted}
        validate={(m, signal) => validate(m, "structural", signal)}
        onImport={imported}
        disabled={!connected}
        operationEpoch={epoch}
      />
      <section aria-label="Validation">
        <h2>Validation</h2>
        <button
          type="button"
          disabled={!connected}
          onClick={() => void check("structural")}
        >
          Validate structure
        </button>
        <button
          type="button"
          disabled={!connected}
          onClick={() => void check("runnable")}
        >
          Check runnable diagnostics
        </button>
        <p role="status">{notice}</p>
        <ValidationSummary
          issues={structural.issues}
          onFocusIssues={focusIssues}
          linkVersion={state.selection}
        />
      </section>
      <CompatibilityPanel manifest={projectDraft(state.draft)} check={client.checkCompatibility}
        disabled={!connected} epoch={epoch} onFocusIssues={focusIssues} />
      <AuthorPreview
        phase={phase}
        structural={structural}
        runnable={runnable}
      />
      <SaveConflict
        manifest={projectDraft(state.draft)}
        etag={baseline.etag}
        exists={baseline.etag !== ""}
        dirty={dirty}
        validate={(m, signal) => validate(m, "structural", signal)}
        put={(raw, tag, signal) => {
          setProposalSavePending(true);
          return client
            .putCourse(raw, tag, signal)
            .then(savedCourse)
            .finally(() => setProposalSavePending(false));
        }}
        getLatest={(signal) => client.getCourse(signal).then(savedCourse)}
        onSaved={saved}
        onCanonical={setFormatted}
        onReviewed={(reviewed) => {
          setBaseline((x) => ({ ...x, etag: reviewed.etag }));
          onCourseSaved(reviewed);
          setRemote(null);
        }}
        remote={remote}
        canonicalFromDraft={reconnectCanonical}
        disabled={!connected || refreshBlocked}
        requestGeneration={draftGeneration}
        connectionEpoch={connectionEpoch}
        onRemoteSaved={setRemote}
      />
      {refreshBlocked && connected ? (
        <section aria-label="Authority recovery">
          <p role="status">
            {authorityState === "refreshing"
              ? "Refreshing authoritative course and proposals…"
              : "Authoritative course and proposals must be reviewed before another mutation."}
          </p>
          <button
            type="button"
            onClick={retryAuthority}
            disabled={authorityState === "refreshing"}
          >
            Retry authoritative refresh
          </button>
        </section>
      ) : null}
      {privateProjectId ? <AuthorAssistant client={client} projectId={privateProjectId} courseId={state.draft.id}
        selected={(() => {
          const selected = state.selection;
          if (!("moduleKey" in selected)) return undefined;
          const module = state.draft.modules.find(item => item.clientKey === selected.moduleKey);
          const phase = module && "phaseKey" in selected ? module.phases.find(item => item.clientKey === selected.phaseKey) : undefined;
          return module ? { module_id: module.id, ...(phase ? { phase_id: phase.id } : {}) } : undefined;
        })()}
        clean={!dirty && !externalDirty && !proposalSavePending && !refreshBlocked && connected}
        epoch={authorEpoch + connectionEpoch + courseAuthorityEpoch} onSaved={onAuthorSaved} onReviewSaved={onReviewSaved} /> : <CurriculumThread
        client={client}
        sourceId={sourceId}
        selection={(() => {
          const selected = state.selection;
          if (selected.type !== "phase" && selected.type !== "surface")
            return null;
          const module = state.draft.modules.find(
            (item) => item.clientKey === selected.moduleKey,
          );
          const phase = module?.phases.find(
            (item) => item.clientKey === selected.phaseKey,
          );
          return module && phase
            ? {
                module_id: module.id,
                phase_id: phase.id,
                title: phase.title,
                manifest_etag: baseline.etag,
              }
            : null;
        })()}
        clean={!dirty && !externalDirty && !proposalSavePending && !refreshBlocked}
        recovery={!connected}
        authorityBlocked={refreshBlocked}
        onProvider={setProvider}
        onProposal={recordProposal}
        onRefresh={refreshAuthorData}
        onAuthorityUnknown={() => setAuthorityState("blocked")}
      />}
      <ProposalReview
        proposals={proposals}
        savedRaw={baseline.raw}
        savedEtag={baseline.etag}
        client={{
          validateCourse: (manifest, signal) =>
            client.validateCourse(manifest, "structural", signal),
          editProposal: (id, body, signal) =>
            client.editProposal(id, body, signal) as Promise<Proposal>,
          acceptProposal: (id, body, signal) =>
            client.acceptProposal(id, body, signal) as Promise<Proposal>,
          rejectProposal: (id, body, signal) =>
            client.rejectProposal(id, body, signal) as Promise<Proposal>,
        }}
        clean={!dirty && !externalDirty}
        recovery={!connected}
        authorityBlocked={refreshBlocked}
        savePending={proposalSavePending}
        onRefresh={refreshAuthorData}
        onProposal={recordProposal}
        onConflict={() =>
          setNotice(
            "Proposal changed; review the saved course before continuing.",
          )
        }
        onAcceptedCourse={() =>
          setNotice("Accepted proposal refreshed from the saved course.")
        }
        onAuthorityUnknown={() => setAuthorityState("blocked")}
      />
      <p role="status">
        {provider === "not_configured" || provider === "provider_error"
          ? "Teacher provider unavailable. Editing and preview remain available."
          : dirty
            ? "Unsaved local draft."
            : "Draft matches the loaded course."}
      </p>
    </>
  );
}
export function AuthorApp() {
  const runtime = useAuthorRuntime();
  const [load, setLoad] = useState<"loading" | "ready" | "disconnected">(
    "loading",
  );
  const [course, setCourse] = useState<CourseResponse | null>(null);
  const [projects, setProjects] = useState<ProjectList | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sourcesDirty, setSourcesDirty] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [researchBusy, setResearchBusy] = useState(false);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [reviewEpoch, setReviewEpoch] = useState(0);
  const [coverageEpoch, setCoverageEpoch] = useState(0);
  const [openReportId, setOpenReportId] = useState<string | null>(null);
  const [sourcesEpoch, setSourcesEpoch] = useState(0);
  const [openChangeId, setOpenChangeId] = useState<string | null>(null);
  const [courseAuthorityEpoch, setCourseAuthorityEpoch] = useState(-1);
  const retainedConnection = useRef(false);
  const client = useRef<Client | null>(null);
  const currentClient = useMemo(() => runtime.status === "ready"
    ? createAuthorClient(runtime.runtime, projectId) : null, [runtime.status, runtime.runtime, projectId]);
  const identity =
    runtime.status === "ready"
      ? `${runtime.runtime.serviceOrigin}\u0000${runtime.runtime.capabilityToken}\u0000${runtime.runtime.sourceId}\u0000${projectId ?? ""}`
      : runtime.status;
  const previousIdentity = useRef(identity);
  const connectionEpoch = useRef(0);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    connectionEpoch.current += 1;
  }
  if (currentClient) client.current = currentClient;
  useEffect(() => {
    if (runtime.status !== "ready") {
      if (course) setLoad("disconnected");
      return;
    }
    retainedConnection.current = course !== null;
    const controller = new AbortController();
    setLoad("loading");
    // The course read also serves the legacy single-course launch. The home
    // response determines whether a project must be selected before editing.
    const courseRequest = client.current!.getCourse(controller.signal);
    const projectsRequest = client.current!.getProjects(controller.signal);
    void Promise.allSettled([courseRequest, projectsRequest])
      .then(([courseResult, projectResult]) => {
        if (!controller.signal.aborted) {
          if (projectResult.status !== "fulfilled") { setLoad("disconnected"); return; }
          setProjects(projectResult.value);
          if (projectResult.value.enabled && !projectId) {
            setCourse(null); setLoad("ready"); return;
          }
          if (courseResult.status !== "fulfilled") { setLoad("disconnected"); return; }
          setCourse(courseResult.value);
          setCourseAuthorityEpoch(connectionEpoch.current);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad("disconnected");
      });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime, projectId]);
  const selectProject = (id: string) => {
    if (dirty || sourcesDirty || contentDirty || researchBusy || reviewDirty || previewDirty || id === projectId) return;
    setCourse(null); setLoad("loading"); setProjectId(id);
    setOpenChangeId(null);
    setOpenReportId(null);
  };
  const projectPanel = projects?.enabled && client.current ? <ProjectPanel client={client.current}
    projects={projects.projects ?? []} unavailable={projects.unavailable ?? []} selected={projectId}
    disabled={dirty || sourcesDirty || contentDirty || researchBusy || reviewDirty || previewDirty || runtime.status !== "ready" || load !== "ready"} onSelect={selectProject} /> : null;
  if (projects?.enabled && !projectId && load === "ready")
    return <AuthorShell state="Choose or create a private author project.">{projectPanel}</AuthorShell>;
  if (runtime.status === "connecting" && !course)
    return (
      <>
        <AuthorShell state="Connecting to the trusted CourseWeave bridge." />
        <button type="button" onClick={runtime.retry}>
          Retry connection
        </button>
      </>
    );
  if ((runtime.status !== "ready" || load === "disconnected") && !course)
    return (
      <>
        <AuthorShell state="Disconnected from CourseWeave. Your unsaved work is not stored here." />
        <button type="button" onClick={runtime.retry}>
          Reconnect
        </button>
      </>
    );
  if (
    (load === "loading" && !retainedConnection.current) ||
    !course ||
    !client.current
  )
    return <AuthorShell state="Loading saved course…" />;
  const connected = runtime.status === "ready" && load === "ready";
  if (!isAuthorManifest(course.manifest))
    return (
      <AuthorShell
        state="Ready. Curriculum teacher provider unavailable."
        provider="not_configured"
      />
    );
  return (
    <AuthorShell
      state={
        connected
          ? projectId ? "Ready. Select saved content for the Author assistant." : "Ready. Curriculum teacher provider unavailable."
          : "Disconnected from CourseWeave. Your unsaved work remains in this tab."
      }
      provider="not_configured"
    >
      {projectPanel}
      <AuthorEditor
        key={`editor-${projectId ?? "single-course"}`}
        course={course}
        client={client.current}
        connected={connected}
        connectionEpoch={connectionEpoch.current}
        courseAuthorityEpoch={courseAuthorityEpoch}
        sourceId={runtime.runtime?.sourceId ?? ""}
        onCourseSaved={(next) => {
          setCourse(next);
          setCourseAuthorityEpoch(connectionEpoch.current);
          setSourcesEpoch(value => value + 1);
        }}
        onDirtyChange={setDirty}
        externalDirty={contentDirty || sourcesDirty || researchBusy}
        privateProjectId={projectId ?? undefined} authorEpoch={sourcesEpoch}
        onAuthorSaved={change => setOpenChangeId(change.change_id)}
        onReviewSaved={id => { setOpenReportId(id); setReviewEpoch(value => value + 1); setCoverageEpoch(value => value + 1); }}
      />
      {projectId && <ContentPanel key={"content-" + projectId} client={client.current}
        openChangeId={openChangeId}
        disabled={!connected || dirty || sourcesDirty || researchBusy || reviewDirty} onDirtyChange={setContentDirty} onChanged={async () => {
          const originClient = client.current!;
          const next = await originClient.getCourse();
          if (client.current !== originClient) return;
          setCourse(next); setCourseAuthorityEpoch(connectionEpoch.current); setSourcesEpoch((current) => current + 1);
        }} />}
      {projectId && <SourcePanel key={"research-" + projectId} client={client.current}
        disabled={!connected || dirty || sourcesDirty || contentDirty || reviewDirty} onBusyChange={setResearchBusy} onChanged={() => setSourcesEpoch(value => value + 1)} />}
      {projectId && <SourceLibrary key={"sources-" + projectId + ":" + sourcesEpoch} client={client.current} projectId={projectId} disabled={!connected || contentDirty || researchBusy || reviewDirty} onDirtyChange={setSourcesDirty} onChanged={() => setSourcesEpoch(value => value + 1)} />}
      {projectId && <ReviewPanel key={"reviews-" + projectId} client={client.current}
        disabled={!connected || dirty || sourcesDirty || contentDirty || researchBusy}
        epoch={sourcesEpoch + connectionEpoch.current} openReportId={openReportId} openEpoch={reviewEpoch} onDirtyChange={setReviewDirty}
        onChanged={() => setCoverageEpoch(value => value + 1)} objectivesFor={selection =>
          (course.manifest as AuthorManifest).modules.find(module => module.id === selection.module_id)?.phases
            .find(phase => phase.id === selection.phase_id)?.learning?.objectives ?? []} />}
      {projectId && <CoveragePanel key={"coverage-" + projectId} client={client.current}
        disabled={!connected || dirty || sourcesDirty || contentDirty || researchBusy || reviewDirty}
        epoch={sourcesEpoch + coverageEpoch + connectionEpoch.current} onOpenReview={id => {
          setOpenReportId(id); setReviewEpoch(value => value + 1);
          document.querySelector('[aria-label="Saved review reports"]')?.scrollIntoView({ block: "start" });
        }} />}
      {projectId && <DeliveryPanel key={"delivery-" + projectId} client={client.current}
        disabled={!connected || dirty || sourcesDirty || contentDirty || researchBusy || reviewDirty}
        epoch={sourcesEpoch + connectionEpoch.current} />}
      {projectId && <StudentPreview key={"student-preview-" + projectId} client={client.current}
        disabled={!connected} onDirtyChange={setPreviewDirty} />}
      {!connected ? (
        <button type="button" onClick={runtime.retry}>
          Reconnect
        </button>
      ) : null}
    </AuthorShell>
  );
}
