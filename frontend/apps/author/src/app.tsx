import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type AuthorManifest } from "@courseweave/ui";
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
import { AuthorPreview } from "./preview";
import { useBeforeUnload } from "./reconnect";
import { SaveConflict, type SavedCourse } from "./save-conflict";
import {
  ValidationSummary,
  pointerToControlId,
  type ValidationIssue,
} from "./validation";
import { useAuthorRuntime } from "./runtime";

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
    (value as { schema_version?: unknown }).schema_version === 1 &&
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
    /^\/(id|title|description|entry_module_id|policies\/(content_sharing|durable_mutation|terminal_execution|conversation_memory|max_shared_chars|workspace_write_globs\/\d+))$/.test(
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
  const phaseMatch = rest.match(/^phases\/(\d+)(?:\/(.*))?$/);
  if (phaseMatch === null) return null;
  const phase = module.phases[Number(phaseMatch[1])];
  const phaseRest = phaseMatch[2] ?? "";
  if (phase === undefined) return null;
  if (
    /^(id|title|kind|teacher_mode|capabilities\/(chat|share_selection|share_cell|share_output|create_profile_proposal|create_course_proposal|create_workspace_proposal|hint_level)|completion\/(type|record_id|path))$/.test(
      phaseRest,
    )
  )
    return {
      type: "phase",
      moduleKey: module.clientKey,
      phaseKey: phase.clientKey,
    };
  const surfaceMatch = phaseRest.match(
    /^surfaces\/(\d+)\/(id|type|role|path|url|label|cwd|location|start_seconds|end_seconds|argv\/\d+|match\/(cell_ids|cell_tags)\/\d+)$/,
  );
  if (surfaceMatch === null) return null;
  const surface = phase.surfaces[Number(surfaceMatch[1])];
  return surface === undefined
    ? null
    : {
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
  onCourseSaved,
}: {
  course: CourseResponse;
  client: Client;
  connected: boolean;
  connectionEpoch: number;
  onCourseSaved(course: CourseResponse): void;
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
  const currentState = useRef(state);
  currentState.current = state;
  const dirty = isDraftDirty(state.draft, state.saved);
  useBeforeUnload(dirty);
  useEffect(() => {
    checks.current.structural?.abort();
    checks.current.runnable?.abort();
  }, [epoch]);
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
        put={(raw, tag, signal) =>
          client.putCourse(raw, tag, signal).then(savedCourse)
        }
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
        disabled={!connected}
        requestGeneration={draftGeneration}
        connectionEpoch={connectionEpoch}
        onRemoteSaved={setRemote}
      />
      <section aria-label="Curriculum teacher">
        <h2>Curriculum teacher</h2>
        <p>
          Teacher provider unavailable. Editing and preview remain available.
        </p>
        <p role="status">
          {dirty ? "Unsaved local draft." : "Draft matches the loaded course."}
        </p>
      </section>
    </>
  );
}
export function AuthorApp() {
  const runtime = useAuthorRuntime();
  const [load, setLoad] = useState<"loading" | "ready" | "disconnected">(
    "loading",
  );
  const [course, setCourse] = useState<CourseResponse | null>(null);
  const client = useRef<Client | null>(null);
  const identity =
    runtime.status === "ready"
      ? `${runtime.runtime.serviceOrigin}\u0000${runtime.runtime.capabilityToken}\u0000${runtime.runtime.sourceId}`
      : runtime.status;
  const previousIdentity = useRef(identity);
  const connectionEpoch = useRef(0);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    connectionEpoch.current += 1;
  }
  if (runtime.status === "ready")
    client.current = createAuthorClient(runtime.runtime);
  useEffect(() => {
    if (runtime.status !== "ready") {
      if (course) setLoad("disconnected");
      return;
    }
    const controller = new AbortController();
    setLoad(course ? "ready" : "loading");
    void client
      .current!.getCourse(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setCourse(next);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad("disconnected");
      });
    return () => controller.abort();
  }, [runtime.status, runtime.runtime]);
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
  if (load === "loading" || !course || !client.current)
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
          ? "Ready. Curriculum teacher provider unavailable."
          : "Disconnected from CourseWeave. Your unsaved work remains in this tab."
      }
      provider="not_configured"
    >
      <AuthorEditor
        course={course}
        client={client.current}
        connected={connected}
        connectionEpoch={connectionEpoch.current}
        onCourseSaved={setCourse}
      />
      {!connected ? (
        <button type="button" onClick={runtime.retry}>
          Reconnect
        </button>
      ) : null}
    </AuthorShell>
  );
}
