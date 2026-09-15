import {
  Button,
  consumeAguiStream,
  isTurnContextMetadata,
  type ProviderStatus,
  type AuthorRole,
  type AuthorReplyMetadata,
} from "@courseweave/ui";
import { useEffect, useRef, useState } from "react";
import type { ContentChange, Notebook } from "./content-panel";

import type {
  AuthorActivitySelection,
  AuthorActivityConfirmation,
} from "./api";

export interface AssistantSelection {
  project_id: string; course_id: string; module_id?: string | null; phase_id?: string | null;
  file_path: string; cell_ids: string[]; manifest_unit: "course" | "module" | "phase" | "learning";
}
export interface ContextPreview {
  context_id: string; conversation_retained: boolean;
  context: { digest: string; role: AuthorRole; selection: AssistantSelection;
    content: string; sources: { source_id: string }[]; omissions: string[];
    budget: { max_input_chars: number; max_output_chars: number } };
}
export interface AuthorAssistantClient {
  getSources(signal?: AbortSignal): Promise<{ sources: { source_id: string; title: string; status: string }[] }>;
  getContentFiles(signal?: AbortSignal): Promise<{ files: { path: string }[] }>;
  getContent(path: string, signal?: AbortSignal): Promise<{ path: string; notebook?: Notebook }>;
  previewAuthorContext(body: { thread_id: string; selection: AssistantSelection; role: AuthorRole; source_ids: string[] }, signal?: AbortSignal): Promise<ContextPreview>;
  postGuide(body: unknown, signal?: AbortSignal): Promise<Response>;
  saveAuthorDraft(id: string, signal?: AbortSignal): Promise<ContentChange>;
}
const hats: [AuthorRole, string][] = [["curator", "Data curator"], ["curriculum_designer", "Curriculum designer"],
  ["source_researcher", "Source researcher"], ["fact_checker", "Fact checker"],
  ["proofreader", "Proofreader"], ["compatibility_reviewer", "Compatibility reviewer"]];

/** One conversation and permission preview for private Author projects. */
export function AuthorAssistant({ client, projectId, courseId, selected, clean, epoch = 0, onSaved }: {
  client: AuthorAssistantClient; projectId: string; courseId: string;
  selected?: { module_id: string; phase_id?: string }; clean: boolean; epoch?: number;
  onSaved(change: ContentChange): void;
}) {
  const [threadId] = useState(() => crypto.randomUUID());
  const [role, setRole] = useState<AuthorRole>("curriculum_designer");
  const [unit, setUnit] = useState<AssistantSelection["manifest_unit"] | "file">("course");
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState("");
  const [notebook, setNotebook] = useState<Notebook | undefined>();
  const [cells, setCells] = useState<string[]>([]);
  const [sources, setSources] = useState<{ source_id: string; title: string; status: string }[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [composer, setComposer] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [transcript, setTranscript] = useState<{ id: string; text: string; role: string; scope: string; state: string; reply?: AuthorReplyMetadata }[]>([]);
  const [draft, setDraft] = useState<AuthorReplyMetadata | null>(null);
  const [manualResponse, setManualResponse] = useState("");
  const active = useRef<AbortController | null>(null);
  const transcriptCount = useRef(0);
  transcriptCount.current = transcript.length;
  const chosen: AssistantSelection = { project_id: projectId, course_id: courseId,
    file_path: unit === "file" ? file : "courseweave.json", cell_ids: unit === "file" ? cells : [],
    manifest_unit: unit === "file" ? "course" : unit,
    ...(unit !== "file" && unit !== "course" && selected ? { module_id: selected.module_id } : {}),
    ...((unit === "phase" || unit === "learning") && selected?.phase_id ? { phase_id: selected.phase_id } : {}) };
  const scopeKey = JSON.stringify(chosen);
  const sourceKey = JSON.stringify(sourceIds);
  const currentRequest = useRef("");
  const identity = JSON.stringify([role, scopeKey, sourceKey, clean, epoch, previewEpoch]);
  currentRequest.current = identity;

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([client.getSources(controller.signal), client.getContentFiles(controller.signal)]).then(([catalogue, inventory]) => {
      if (controller.signal.aborted) return;
      setSources(catalogue.sources); setFiles(inventory.files.map(item => item.path).filter(path => path !== "courseweave.json"));
    }).catch(() => { if (!controller.signal.aborted) setNotice("Saved materials are unavailable. Reload when the project is ready."); });
    return () => controller.abort();
  }, [client, epoch]);
  useEffect(() => {
    const controller = new AbortController();
    setNotebook(undefined); setCells([]);
    if (file.endsWith(".ipynb")) void client.getContent(file, controller.signal).then(value => {
      if (!controller.signal.aborted) setNotebook(value.notebook);
    }).catch(() => { if (!controller.signal.aborted) setNotice("Notebook is unavailable; reopen the saved file."); });
    return () => controller.abort();
  }, [client, file, epoch]);
  useEffect(() => {
    const controller = new AbortController();
    active.current?.abort(); active.current = null; setPending(false); setPreview(null); setDraft(null);
    if (!clean) { setNotice("Save or discard unsaved edits before asking about the saved course."); return () => controller.abort(); }
    if (unit === "file" && (!file || (file.endsWith(".ipynb") && cells.length === 0))) return () => controller.abort();
    setNotice("Preparing the saved context…");
    void client.previewAuthorContext({ thread_id: threadId, role, selection: JSON.parse(scopeKey), source_ids: JSON.parse(sourceKey) }, controller.signal)
      .then(value => {
        if (controller.signal.aborted || currentRequest.current !== identity) return;
        setPreview(value);
        setNotice(!value.conversation_retained && transcriptCount.current
          ? "Earlier turns remain visible here. Changed content or source permissions removed them from future model context." : "");
      }).catch(error => {
        if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Context is unavailable. Reload before sending.");
      });
    return () => controller.abort();
  }, [client, threadId, identity]);
  useEffect(() => () => active.current?.abort(), []);

  const send = async (action: "chat" | "draft" | "review") => {
    if (!clean || !preview || pending || !composer.trim()) return;
    const context = preview, requestIdentity = identity, requestText = composer.trim();
    const controller = new AbortController(); active.current = controller;
    const runId = crypto.randomUUID();
    const scope = [role, context.context.selection.module_id, context.context.selection.phase_id,
      context.context.selection.file_path, ...context.context.selection.cell_ids].filter(Boolean).join(" · ");
    setPending(true); setNotice(""); setDraft(null); setManualResponse("");
    setTranscript(items => [...items, { id: runId + "-user", text: requestText, role: "You", scope, state: "finished" },
      { id: runId, text: "", role: hats.find(hat => hat[0] === role)![1], scope, state: "streaming" }]);
    const finish = (patch: Partial<(typeof transcript)[number]>) => setTranscript(items => items.map(item => item.id === runId ? { ...item, ...patch } : item));
    try {
      const response = await client.postGuide({ threadId, runId, messages: [{ id: crypto.randomUUID(), role: "user", content: requestText }],
        tools: [], context: [], forwardedProps: { context_id: context.context_id, action } }, controller.signal);
      if (!response.body) throw new Error("The response stream is unavailable.");
      const outcome = await consumeAguiStream(response.body, { threadId, runId, candidateTypes: [],
        authorContext: { context_id: context.context_id, digest: context.context.digest, role } }, event => {
        if (event.type === "TEXT_MESSAGE_CONTENT" && !controller.signal.aborted && currentRequest.current === requestIdentity)
          setTranscript(items => items.map(item => item.id === runId ? { ...item, text: item.text + (event.delta ?? "") } : item));
      }, controller.signal);
      if (controller.signal.aborted || currentRequest.current !== requestIdentity) { finish({ state: "interrupted" }); return; }
      if (outcome.status === "finished" && (action === "chat" || outcome.authorReply)) {
        finish({ text: outcome.authorReply?.reply.message ?? outcome.text, state: "finished", reply: outcome.authorReply });
        setDraft(outcome.authorReply ?? null);
        setComposer(current => current.trim() === requestText ? "" : current);
      } else {
        finish({ state: outcome.status === "interrupted" ? "interrupted" : "failed" });
        setManualResponse(outcome.text);
        setNotice(outcome.message ?? "The response did not finish. Your request is retained; no draft was saved.");
      }
    } catch (error) {
      finish({ state: controller.signal.aborted ? "interrupted" : "failed" });
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "The provider request failed. Your request is retained.");
    } finally {
      if (active.current === controller) { active.current = null; setPending(false); }
    }
  };
  const save = async () => {
    if (!draft || !preview || draft.context_digest !== preview.context.digest || pending || !clean) return;
    const controller = new AbortController(); active.current = controller; setPending(true);
    try {
      const saved = await client.saveAuthorDraft(draft.draft_id, controller.signal);
      if (!controller.signal.aborted) { setDraft(null); setNotice("Draft saved. Review its exact diff in Course files and pending changes."); onSaved(saved); }
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "The draft could not be saved.");
    } finally { if (active.current === controller) { active.current = null; setPending(false); } }
  };
  const ready = clean && !!preview && !pending && !!composer.trim();
  return <section aria-label="Author assistant" className="author-assistant">
    <h2>Author assistant</h2>
    <p>One session-only conversation. This local preview shows the saved context that Send shares with your configured model. Provider usage is billed to its account owner. Network research requires a separate explicit action.</p>
    <label>Author role<select aria-label="Author role" value={role} onChange={event => setRole(event.target.value as AuthorRole)}>
      {hats.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>Editable scope<select value={unit} onChange={event => setUnit(event.target.value as typeof unit)}>
      <option value="course">Course metadata</option>
      {selected && <option value="module">Selected module and activity structure</option>}
      {selected?.phase_id && <><option value="phase">Selected activity</option><option value="learning">Selected activity learning metadata</option></>}
      <option value="file">Selected saved file</option>
    </select></label>
    {unit === "file" && <><label>Assistant file<select value={file} onChange={event => setFile(event.target.value)}>
      <option value="">Choose a saved file</option>{files.map(path => <option key={path} value={path}>{path}</option>)}</select></label>
      {notebook && <fieldset><legend>Permitted notebook cells</legend>{notebook.cells.map(cell => <label key={cell.id}>
        <input type="checkbox" checked={cells.includes(cell.id)} onChange={event => setCells(items => event.target.checked ? [...items, cell.id] : items.filter(id => id !== cell.id))} />
        {cell.id} ({cell.cell_type})</label>)}</fieldset>}</>}
    <fieldset><legend>Permitted reference sources</legend>
      <p>Approval and permission for this conversation are separate choices.</p>
      {sources.filter(source => source.status === "approved").map(source => <label key={source.source_id}>
        <input type="checkbox" aria-label={"Permit " + source.title} checked={sourceIds.includes(source.source_id)}
          onChange={event => setSourceIds(ids => event.target.checked ? [...ids, source.source_id] : ids.filter(id => id !== source.source_id))} />
        {source.title}</label>)}
      <p>{sources.filter(source => source.status !== "approved").length} source(s) require approval before they can be permitted.</p>
    </fieldset>
    {preview && <div aria-label="Context preview">
      <p>Active role: {hats.find(hat => hat[0] === preview.context.role)?.[1]} · {preview.context.sources.length} permitted source(s)</p>
      <p>Scope: {[preview.context.selection.course_id, preview.context.selection.module_id, preview.context.selection.phase_id,
        preview.context.selection.file_path, ...preview.context.selection.cell_ids].filter(Boolean).join(" · ")}</p>
      <ul>{preview.context.omissions.map((text, index) => <li key={index}>{text}</li>)}</ul>
      <details><summary>Exact saved context to be sent</summary><pre>{JSON.stringify(JSON.parse(preview.context.content), null, 2)}</pre></details>
    </div>}
    <Button disabled={!clean || pending} onClick={() => setPreviewEpoch(value => value + 1)}>Reload context</Button>
    {notice && <p role="status">{notice}</p>}
    <ol aria-label="Author conversation">{transcript.map(item => <li key={item.id}>
      <h3>{item.role} · {item.state}</h3><small>{item.scope}</small><p className="assistant-text">{item.text}</p>
      {item.reply?.reply.findings.map(finding => <article key={finding.claim_id}>
        <h4>{finding.claim_id}: {finding.judgment} (model judgment; unreviewed)</h4><p>{finding.explanation}</p>
        {finding.evidence.map((citation, index) => <blockquote key={index}>
          {citation.quote}<footer>{citation.source_id} · Revision {citation.revision} · Characters {citation.start}–{citation.end}</footer>
        </blockquote>)}</article>)}
    </li>)}</ol>
    {manualResponse && <details open><summary>Response for manual editing</summary>
      <textarea aria-label="Rejected response for manual editing" value={manualResponse} onChange={event => setManualResponse(event.target.value)} />
      <p>Copy the useful text into the manual editor, then create a new reviewed change.</p></details>}
    {draft?.reply.change && <Button disabled={!clean || pending || draft.context_digest !== preview?.context.digest} onClick={() => void save()}>Save draft for review</Button>}
    <label>Message to Author assistant<textarea aria-label="Message to Author assistant" maxLength={8000} value={composer}
      onChange={event => setComposer(event.target.value)} /></label>
    <div className="assistant-actions">
      <Button disabled={!ready} onClick={() => void send("chat")}>Send message</Button>
      <Button disabled={!ready} onClick={() => void send("draft")}>Request draft</Button>
      <Button disabled={!ready} onClick={() => void send("review")}>Request review</Button>
      {pending && <Button onClick={() => { active.current?.abort(); setNotice("Request cancelled. No unfinished draft was saved."); }}>Cancel request</Button>}
    </div>
  </section>;
}

type CurriculumClient = {
  confirmActivity?(
    selection: AuthorActivityConfirmation,
    signal?: AbortSignal,
  ): Promise<void>;
  postGuide(
    body: {
      threadId: string;
      runId: string;
      messages: Array<{ id: string; role: "user"; content: string }>;
      tools: [];
      context: [];
      forwardedProps: { source_id: string; action?: "edit_learning" };
    },
    signal?: AbortSignal,
  ): Promise<Response>;
  createProposal(candidateId: string, signal?: AbortSignal): Promise<unknown>;
};

type Transcript = {
  id: string;
  text: string;
  scope?: string;
  state: "streaming" | "finished" | "interrupted" | "failed";
};

type RefreshResult = { committed: boolean };

export function CurriculumThread({
  client,
  sourceId,
  selection = null,
  clean,
  recovery,
  authorityBlocked = false,
  onProvider,
  onProposal,
  onRefresh,
  onAuthorityUnknown = () => undefined,
}: {
  client: CurriculumClient;
  sourceId: string;
  selection?: AuthorActivitySelection | null;
  clean: boolean;
  recovery: boolean;
  authorityBlocked?: boolean;
  onProvider(status: ProviderStatus): void;
  onProposal(proposal: unknown): void;
  onRefresh(signal?: AbortSignal): Promise<RefreshResult>;
  onAuthorityUnknown?(): void;
}) {
  const [threadId] = useState(() => crypto.randomUUID());
  const learningSource = `author-learning-${threadId}`;
  const selectionSequence = useRef(0);
  const lastAttempt = useRef<{
    action?: "edit_learning";
    selection: AuthorActivitySelection | null;
  } | null>(null);
  const [composer, setComposer] = useState("");
  const [transcript, setTranscript] = useState<Transcript[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const active = useRef<AbortController | null>(null);
  const candidateFlights = useRef(new Map<string, AbortController>());
  const composerValue = useRef(composer);
  const alive = useRef(true);
  composerValue.current = composer;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      active.current?.abort();
      candidateFlights.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    if (!recovery && clean && !authorityBlocked) return;
    active.current?.abort();
    candidateFlights.current.forEach((controller) => controller.abort());
    candidateFlights.current.clear();
    active.current = null;
    setPending(false);
    setCandidates([]);
    setTranscript((items) =>
      items.map((item) =>
        item.state === "streaming" ? { ...item, state: "interrupted" } : item,
      ),
    );
  }, [recovery, clean, authorityBlocked]);

  const finish = (id: string, state: Transcript["state"]) =>
    setTranscript((items) =>
      items.map((item) => (item.id === id ? { ...item, state } : item)),
    );

  const persistCandidate = async (candidateId: string) => {
    if (
      !clean ||
      recovery ||
      authorityBlocked ||
      candidateFlights.current.has(candidateId)
    )
      return;
    const controller = new AbortController();
    candidateFlights.current.set(candidateId, controller);
    try {
      const proposal = await client.createProposal(
        candidateId,
        controller.signal,
      );
      if (!alive.current) return;
      if (controller.signal.aborted) {
        onAuthorityUnknown();
        return;
      }
      // Persistence is complete. Authority refresh is owned by the editor,
      // independently of the mutation invalidation effect above.
      candidateFlights.current.delete(candidateId);
      onProposal(proposal);
      setCandidates((items) => items.filter((id) => id !== candidateId));
      let refreshed = false;
      try {
        const result = await onRefresh();
        refreshed = result.committed;
      } catch {
        refreshed = false;
      }
      if (alive.current && !refreshed) {
        setNotice(
          "Suggested change saved, refresh unavailable; reconnect/review before another action.",
        );
      }
    } catch (error) {
      if (!alive.current) return;
      if (controller.signal.aborted) {
        onAuthorityUnknown();
        return;
      }
      const status =
        typeof error === "object" && error !== null
          ? (error as { status?: number }).status
          : undefined;
      setCandidates((items) => items.filter((id) => id !== candidateId));
      setNotice(
        status === 403 || status === 404 || status === 409
          ? "Suggested change is unavailable. Ask the teacher again."
          : "Suggested change could not be saved.",
      );
      if (status !== 403 && status !== 404 && status !== 409)
        onAuthorityUnknown();
    } finally {
      if (candidateFlights.current.get(candidateId) === controller)
        candidateFlights.current.delete(candidateId);
    }
  };

  const send = async (
    action?: "edit_learning",
    target: AuthorActivitySelection | null = selection,
  ) => {
    if (
      !clean ||
      recovery ||
      authorityBlocked ||
      pending ||
      composer.trim().length === 0
    )
      return;
    const capturedSelection = action === "edit_learning" ? target : null;
    if (action === "edit_learning" && !capturedSelection) return;
    lastAttempt.current = {
      action,
      selection: capturedSelection ? { ...capturedSelection } : null,
    };
    const submitted = composer;
    const controller = new AbortController();
    active.current = controller;
    const runId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    setPending(true);
    setNotice(null);
    try {
      if (capturedSelection) {
        if (!client.confirmActivity)
          throw Object.assign(new Error("Activity confirmation unavailable."), {
            code: "context_changed",
          });
        await client.confirmActivity(
          {
            ...capturedSelection,
            source_id: learningSource,
            sequence: ++selectionSequence.current,
          },
          controller.signal,
        );
        if (!alive.current || controller.signal.aborted) return;
      }
      const response = await client.postGuide(
        {
          threadId,
          runId,
          messages: [{ id: messageId, role: "user", content: submitted }],
          tools: [],
          context: [],
          forwardedProps: capturedSelection
            ? { source_id: learningSource, action: "edit_learning" }
            : { source_id: sourceId },
        },
        controller.signal,
      );
      if (response.body === null) throw new Error("Missing teacher response.");
      let acceptedSelection = false;
      const outcome = await consumeAguiStream(
        response.body,
        { threadId, runId },
        (event) => {
          if (
            capturedSelection &&
            event.type === "CUSTOM" &&
            event.name === "courseweave.turn_context"
          ) {
            if (
              !isTurnContextMetadata(event.value) ||
              event.value.source_id !== learningSource ||
              event.value.module_id !== capturedSelection.module_id ||
              event.value.phase_id !== capturedSelection.phase_id ||
              event.value.manifest_etag !== capturedSelection.manifest_etag
            )
              throw Object.assign(new Error("The saved activity changed."), {
                code: "context_changed",
              });
            acceptedSelection = true;
          }
          if (event.type === "TEXT_MESSAGE_START")
            setTranscript((items) => [
              ...items,
              {
                id: messageId,
                text: "",
                state: "streaming",
                scope: capturedSelection
                  ? `Learning for ${capturedSelection.title}`
                  : "Course drafting",
              },
            ]);
          if (
            event.type === "TEXT_MESSAGE_CONTENT" &&
            typeof event.delta === "string"
          )
            setTranscript((items) =>
              items.map((item) =>
                item.id === messageId
                  ? { ...item, text: item.text + event.delta }
                  : item,
              ),
            );
        },
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (
        outcome.status === "finished" &&
        capturedSelection &&
        !acceptedSelection
      )
        throw Object.assign(new Error("Accepted activity context missing."), {
          code: "context_changed",
        });
      if (outcome.status === "finished") {
        finish(messageId, "finished");
        onProvider("ready");
        setCandidates((items) => [...items, ...outcome.candidates]);
        if (composerValue.current === submitted) setComposer("");
      } else if (outcome.status === "error") {
        finish(messageId, "failed");
        onProvider("provider_error");
        setNotice(outcome.message ?? "Teacher unavailable");
      } else {
        finish(messageId, "interrupted");
        setNotice("Teacher connection interrupted. Your draft is unsent.");
      }
    } catch (error) {
      if (!alive.current) return;
      if (controller.signal.aborted) {
        finish(messageId, "interrupted");
        return;
      }
      finish(messageId, "failed");
      const code =
        typeof error === "object" && error !== null
          ? (error as { code?: string }).code
          : undefined;
      if (code === "not_configured") onProvider("not_configured");
      else if (code === "provider_error") onProvider("provider_error");
      const messages: Record<string, string> = {
        context_changed:
          "The saved course changed. Reload and confirm the activity before asking again.",
        conversation_busy:
          "This conversation already has a running request. Wait for it to finish.",
        context_revoked:
          "The teaching context was reset. Confirm it before asking again.",
        lesson_changed:
          "The lesson changed. Confirm the lesson before asking again.",
        course_identity_changed:
          "The draft identity changed; reopen the course to load its current state.",
        input_limit:
          "This request and its required teaching context exceed the input limit.",
      };
      setNotice(
        code && messages[code]
          ? messages[code]
          : code === "not_configured" || code === "provider_error"
            ? "Teacher unavailable"
            : "Teacher connection interrupted. Your draft is unsent.",
      );
    } finally {
      if (alive.current && active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };

  const blocked = recovery || authorityBlocked;
  const disabled = !clean || blocked || pending || composer.trim().length === 0;
  return (
    <section aria-label="Curriculum teacher">
      <h2>Curriculum teacher</h2>
      <p>
        Asking sends the saved manifest to the configured provider. Teacher
        suggestions remain proposals for your review.
      </p>
      {!clean ? (
        <p role="status">
          Save or review your local draft first: the teacher operates on the
          saved manifest.
        </p>
      ) : null}
      {authorityBlocked ? (
        <p role="status">
          Reconnect and review authoritative course and proposals before another
          teacher action.
        </p>
      ) : null}
      {transcript.map((item) => (
        <div key={item.id}>
          <p>{item.scope}</p>
          <p data-state={item.state}>{item.text}</p>
        </div>
      ))}
      <label>
        Ask the curriculum teacher
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value)}
        />
      </label>
      <Button type="button" disabled={disabled} onClick={() => void send()}>
        Ask teacher
      </Button>
      {selection ? (
        <>
          <p>Selected saved activity: {selection.title}</p>
          <Button
            type="button"
            disabled={disabled}
            onClick={() => void send("edit_learning")}
          >
            Improve selected activity Learning
          </Button>
        </>
      ) : null}
      {candidates.map((candidateId) => (
        <section key={candidateId}>
          <p>Suggested change ready for review.</p>
          <Button
            type="button"
            disabled={blocked || !clean}
            onClick={() => void persistCandidate(candidateId)}
          >
            Save suggested change
          </Button>
        </section>
      ))}
      {notice ? <p role="status">{notice}</p> : null}
      {notice && composer.trim().length > 0 ? (
        <>
          {lastAttempt.current?.selection ? (
            <p>
              Retry will confirm Learning for{" "}
              {lastAttempt.current.selection.title}.
            </p>
          ) : null}
          <Button
            type="button"
            disabled={disabled}
            onClick={() =>
              void send(
                lastAttempt.current?.action,
                lastAttempt.current?.selection ?? null,
              )
            }
          >
            Retry
          </Button>
        </>
      ) : null}
    </section>
  );
}
