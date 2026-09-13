import { Button } from "@courseweave/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  consumeAguiStream,
  isTurnContextMetadata,
  isProviderOutcomeMetadata,
  type LessonScopeMetadata,
  type TurnContextMetadata,
  type AguiEvent,
} from "./agui-stream";
import type {
  Proposal,
  ProviderStatus,
} from "@courseweave/ui/courseweave-types";
import {
  ShareDialog,
  type CapturedShare,
  type ShareKind,
} from "./share-dialog";

type TeacherClient = {
  postGuide(
    body: {
      threadId: string;
      runId: string;
      messages: Array<{ id: string; role: "user"; content: string }>;
      tools: [];
      context: [];
      forwardedProps: { source_id?: string };
    },
    signal?: AbortSignal,
  ): Promise<Response>;
  share(
    body: {
      run_id: string;
      kind: ShareKind;
      content: string;
      label?: string;
      source_id?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown>;
  guideAction?(
    body: {
      thread_id: string;
      source_id: string;
      action: "hint" | "decline_revisit";
    },
    signal?: AbortSignal,
  ): Promise<{
    module_id: string;
    phase_id: string;
    status: string;
    message: string;
    hint?: { text: string } | null;
  }>;
  guideLesson?(
    body: {
      thread_id: string;
      source_id?: string;
      action: "use_lesson" | "reset_lesson";
    },
    signal?: AbortSignal,
  ): Promise<{ scope: LessonScopeMetadata | null; message?: string }>;
  createProposal(candidateId: string, signal?: AbortSignal): Promise<Proposal>;
};

type TranscriptItem = {
  id: string;
  text: string;
  question: string;
  attribution: string;
  context?: TurnContextMetadata;
  state: "streaming" | "finished" | "interrupted" | "failed";
};

export function TeacherThread({
  client,
  sourceId,
  allowedShareKinds,
  maxShareChars,
  captureShare,
  onProvider,
  onProposal,
  onRefresh,
  composer: controlledComposer,
  onComposerChange,
  onDraftChange,
  recovery = false,
  enabled = true,
  lockReason,
  onRecovery,
  onSharedRunPending,
  sharedRunPending = false,
  onTranscriptChange,
  activityLabel = "Course",
  activityKey,
  contextReady = true,
  privacyReset = 0,
}: {
  activityLabel?: string;
  activityKey?: string;
  contextReady?: boolean;
  privacyReset?: number;
  client: TeacherClient;
  sourceId: string;
  allowedShareKinds: ShareKind[];
  maxShareChars: number;
  captureShare?(
    kind: Exclude<ShareKind, "text">,
    maxChars: number,
  ): Promise<CapturedShare>;
  onProvider(status: ProviderStatus): void;
  onProposal(proposal: Proposal): void;
  onRefresh(): Promise<void>;
  composer?: string;
  onComposerChange?(value: string): void;
  onDraftChange?(hasDraft: boolean): void;
  recovery?: boolean;
  enabled?: boolean;
  lockReason?: string;
  onRecovery?(): void;
  onSharedRunPending?(pending: boolean): void;
  sharedRunPending?: boolean;
  onTranscriptChange?(hasTranscript: boolean): void;
}) {
  useEffect(() => {
    setShareOpen(false);
  }, [activityKey, sourceId]);
  useEffect(() => {
    if (privacyReset > 0) {
      setLesson(null);
      setCandidates([]);
      active.current?.abort();
      candidateFlights.current.forEach((controller) => controller.abort());
      candidateFlights.current.clear();
    }
  }, [privacyReset]);
  const [threadId] = useState(() => crypto.randomUUID());
  const [internalComposer, setInternalComposer] = useState("");
  const composer = controlledComposer ?? internalComposer;
  const setComposer = onComposerChange ?? setInternalComposer;
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const transcriptNode = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useLayoutEffect(() => {
    if (followLatest.current && transcriptNode.current)
      transcriptNode.current.scrollTop = transcriptNode.current.scrollHeight;
  }, [transcript]);
  const [lesson, setLesson] = useState<LessonScopeMetadata | null>(null);
  const retryTurn = useRef<{
    id: string;
    question: string;
    activityKey?: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [candidates, setCandidates] = useState<
    Array<{ id: string; pending: boolean }>
  >([]);
  const active = useRef<AbortController | null>(null);
  const candidateFlights = useRef(new Map<string, AbortController>());
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const composerTextarea = useRef<HTMLTextAreaElement>(null);
  const composerValue = useRef(composer);
  composerValue.current = composer;
  const pendingShareFocus = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pendingShareFocus.current = false;
      active.current?.abort();
      candidateFlights.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    onDraftChange?.(composer.trim().length > 0);
  }, [composer, onDraftChange]);
  useEffect(() => {
    onTranscriptChange?.(transcript.length > 0);
  }, [transcript, onTranscriptChange]);
  useEffect(() => {
    if (!recovery) return;
    active.current?.abort();
    candidateFlights.current.forEach((controller) => controller.abort());
    candidateFlights.current.clear();
    pendingShareFocus.current = false;
    setPending(false);
    setShareOpen(false);
    setCandidates([]);
    setTranscript((items) =>
      items.map((item) =>
        item.state === "streaming"
          ? { ...item, state: "interrupted" as const }
          : item,
      ),
    );
  }, [recovery]);
  const restoreShareFocus = () => {
    if (shareTrigger.current?.disabled) {
      pendingShareFocus.current = true;
      return;
    }
    pendingShareFocus.current = false;
    shareTrigger.current?.focus();
  };
  useEffect(() => {
    if (pending || !pendingShareFocus.current) return;
    pendingShareFocus.current = false;
    if (recovery || sharedRunPending) return;
    if (!shareTrigger.current?.disabled) {
      shareTrigger.current?.focus();
      return;
    }
    if (!composerTextarea.current?.disabled) composerTextarea.current?.focus();
  }, [pending, recovery]);

  function finishPartial(id: string, state: TranscriptItem["state"]) {
    setAnnouncement(
      state === "finished"
        ? "Answer complete. Read the reply in the conversation."
        : state === "interrupted"
          ? "Answer interrupted. Your question and any partial reply are retained."
          : "Answer failed. Your question remains available to retry.",
    );
    setTranscript((items) =>
      items.map((item) => (item.id === id ? { ...item, state } : item)),
    );
  }

  async function persistCandidate(id: string) {
    if (recovery) return;
    if (candidateFlights.current.has(id)) return;
    const controller = new AbortController();
    candidateFlights.current.set(id, controller);
    setCandidates((items) =>
      items.map((item) => (item.id === id ? { ...item, pending: true } : item)),
    );
    try {
      const proposal = await client.createProposal(id, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onProposal(proposal);
      setCandidates((items) => items.filter((item) => item.id !== id));
      try {
        await onRefresh();
      } catch {
        if (alive.current && !controller.signal.aborted)
          setNotice("Suggested change saved, refresh unavailable.");
      }
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const status =
        typeof error === "object" && error !== null
          ? (error as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) onRecovery?.();
      setCandidates((items) => items.filter((item) => item.id !== id));
      setNotice(
        status === 403 || status === 404 || status === 409
          ? "Suggested change is unavailable. Ask a question again."
          : "Suggested change could not be saved.",
      );
    } finally {
      candidateFlights.current.delete(id);
    }
  }

  async function send(
    shared?: { kind: ShareKind; content: string; label?: string },
    retry = false,
  ) {
    if (recovery || !enabled || pending || composer.trim().length === 0) return;
    followLatest.current = true;
    setAnnouncement("");
    const submittedComposer = composer;
    const controller = new AbortController();
    active.current = controller;
    const runId = crypto.randomUUID();
    const previous =
      retry &&
      retryTurn.current?.question === submittedComposer &&
      retryTurn.current.activityKey === activityKey
        ? retryTurn.current
        : null;
    const messageKey = previous?.id ?? crypto.randomUUID();
    retryTurn.current = {
      id: messageKey,
      question: submittedComposer,
      activityKey,
    };
    setTranscript((items) =>
      previous
        ? items.map((item) =>
            item.id === messageKey
              ? { ...item, text: "", state: "streaming" }
              : item,
          )
        : [
            ...items,
            {
              id: messageKey,
              question: submittedComposer,
              text: "",
              state: "streaming",
              attribution: activityLabel,
            },
          ],
    );
    const sharedRun = shared !== undefined;
    setPending(true);
    if (sharedRun) onSharedRunPending?.(true);
    setNotice(null);
    try {
      if (shared !== undefined) {
        await client.share(
          {
            run_id: runId,
            kind: shared.kind,
            content: shared.content,
            label: shared.label,
            source_id: sourceId,
          },
          controller.signal,
        );
        shared = undefined;
        if (!alive.current || controller.signal.aborted) return;
        setShareOpen(false);
      }
      const body = {
        threadId,
        runId,
        messages: [
          {
            id: messageKey,
            role: "user" as const,
            content: submittedComposer,
          },
        ],
        tools: [] as [],
        context: [] as [],
        forwardedProps: { source_id: sourceId },
      };
      let contextAccepted = false;
      let providerAccepted = false;
      const response = await client.postGuide(body, controller.signal);
      const outcome = await consumeAguiStream(
        response.body!,
        {
          threadId,
          runId,
          candidateTypes: ["profile_patch", "manifest_replace"],
        },
        (event: AguiEvent) => {
          if (
            event.type === "CUSTOM" &&
            event.name === "courseweave.provider_outcome" &&
            isProviderOutcomeMetadata(event.value)
          )
            providerAccepted = true;
          if (
            event.type === "CUSTOM" &&
            event.name === "courseweave.turn_context" &&
            isTurnContextMetadata(event.value)
          ) {
            const accepted = event.value;
            if (
              activityKey &&
              (accepted.source_id !== sourceId ||
                `${accepted.module_id}/${accepted.phase_id}` !== activityKey)
            )
              throw new Error(
                "The active activity changed before this request was accepted.",
              );
            contextAccepted = true;
            setTranscript((items) =>
              items.map((item) =>
                item.id === messageKey ? { ...item, context: accepted } : item,
              ),
            );
          }
          if (
            activityKey &&
            event.type === "TEXT_MESSAGE_START" &&
            !contextAccepted
          )
            throw new Error("The accepted activity was not confirmed.");
          if (
            event.type === "TEXT_MESSAGE_CONTENT" &&
            typeof event.delta === "string"
          )
            setTranscript((items) =>
              items.map((item) =>
                item.id === messageKey
                  ? { ...item, text: item.text + event.delta }
                  : item,
              ),
            );
        },
        controller.signal,
      );
      if (!alive.current) return;
      if (controller.signal.aborted) {
        finishPartial(messageKey, "interrupted");
        return;
      }
      if (outcome.status === "finished") {
        finishPartial(messageKey, "finished");
        if (providerAccepted && outcome.text.trim()) onProvider("ready");
        retryTurn.current = null;
        setCandidates((items) => [
          ...items,
          ...outcome.candidates.map((id) => ({ id, pending: false })),
        ]);
        if (composerValue.current === submittedComposer) {
          setComposer("");
          const container = composerTextarea.current?.closest(".cw-composer");
          if (container) container.scrollTop = 0;
        }
      } else if (outcome.status === "error") {
        finishPartial(messageKey, "failed");
        onProvider("provider_error");
        setNotice(
          outcome.message ??
            "The teacher run failed. Try again with a new request.",
        );
      } else {
        finishPartial(messageKey, "interrupted");
        setNotice(
          "Answer interrupted. Your question and partial answer are kept; retry when ready.",
        );
      }
    } catch (error: unknown) {
      if (!alive.current) return;
      if (controller.signal.aborted) {
        finishPartial(messageKey, "interrupted");
        return;
      }
      finishPartial(messageKey, "failed");
      if (sharedRun) setShareOpen(false);
      const code =
        typeof error === "object" && error !== null
          ? (error as { code?: string }).code
          : undefined;
      const status =
        typeof error === "object" && error !== null
          ? (error as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) {
        onRecovery?.();
        setNotice("Course assistant access expired. Reconnect to continue.");
      } else if (code === "not_configured") {
        onProvider("not_configured");
        setNotice("Course assistant unavailable");
      } else if (code === "provider_error") {
        onProvider("provider_error");
        setNotice("Course assistant unavailable");
      } else
        setNotice(
          "Answer interrupted. Your question and partial answer are kept; retry when ready.",
        );
    } finally {
      shared = undefined;
      if (alive.current && active.current === controller) {
        active.current = null;
        setPending(false);
      }
      if (sharedRun) onSharedRunPending?.(false);
    }
  }

  async function direct(
    action: "hint" | "decline_revisit" | "use_lesson" | "reset_lesson",
  ) {
    if (pending || recovery || !contextReady) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setNotice(null);
    try {
      if (action === "use_lesson" || action === "reset_lesson") {
        const result = await client.guideLesson?.(
          { thread_id: threadId, source_id: sourceId, action },
          controller.signal,
        );
        if (result && !controller.signal.aborted) {
          setLesson(result.scope);
          setNotice(
            result.scope ? "Lesson scope active." : "Lesson scope cleared.",
          );
        }
      } else {
        const result = await client.guideAction?.(
          { thread_id: threadId, source_id: sourceId, action },
          controller.signal,
        );
        if (result && !controller.signal.aborted)
          setTranscript((items) => [
            ...items,
            {
              id: crypto.randomUUID(),
              question:
                action === "hint"
                  ? "Show the next authored hint"
                  : "Continue without revisiting",
              text: result.hint?.text ?? result.message,
              attribution:
                activityKey === `${result.module_id}/${result.phase_id}`
                  ? activityLabel
                  : `${result.module_id} · ${result.phase_id}`,
              state: "finished",
            },
          ]);
      }
    } catch {
      if (!controller.signal.aborted)
        setNotice("That action could not be completed. Please try again.");
    } finally {
      if (alive.current && active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  }
  return (
    <section className="cw-conversation" aria-label="Course assistant">
      <h2>Course assistant</h2>
      <div
        ref={transcriptNode}
        className="cw-transcript"
        tabIndex={0}
        role="log"
        aria-live="off"
        aria-label="Conversation"
        onScroll={(event) => {
          const node = event.currentTarget;
          followLatest.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
      >
        {transcript.map((item) => (
          <article key={item.id} data-state={item.state}>
            <small>{item.attribution}</small>
            {item.context?.lesson && "label" in item.context.lesson ? (
              <small>Lesson: {item.context.lesson.label}</small>
            ) : null}
            {item.context?.workspace_share ? (
              <small>
                One-answer Share:{" "}
                {item.context.workspace_share.label ??
                  item.context.workspace_share.kind}
              </small>
            ) : null}
            <p className="cw-user">
              <strong>You</strong>
              <span>{item.question}</span>
            </p>
            <p
              className="cw-assistant"
              data-testid={
                item.state === "interrupted" ? "interrupted-stream" : undefined
              }
            >
              <strong>Course assistant</strong>
              <span>{item.text}</span>
            </p>
            <small>
              {item.state === "finished"
                ? "Answered"
                : item.state === "streaming"
                  ? "Answering…"
                  : item.state === "failed"
                    ? "Failed"
                    : "Interrupted"}
            </small>
          </article>
        ))}
      </div>
      <p
        className="cw-visually-hidden"
        role="status"
        aria-label="Answer updates"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      <div className="cw-composer">
        <label>
          Ask a question
          <textarea
            ref={composerTextarea}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
          />
        </label>
        {!enabled && lockReason ? <p role="status">{lockReason}</p> : null}
        <Button
          type="button"
          disabled={
            recovery || !enabled || pending || composer.trim().length === 0
          }
          onClick={() => void send()}
        >
          Send
        </Button>
        {client.guideAction ? (
          <Button
            type="button"
            disabled={recovery || pending || !contextReady}
            onClick={() => void direct("hint")}
          >
            Next authored hint
          </Button>
        ) : null}
        <details>
          <summary>Lesson &amp; sharing scope</summary>
          <p>
            Lesson text stays available to this conversation until cleared.
            Workspace Share applies to one answer. CourseWeave keeps chat only
            in this session; provider retention follows the provider’s policy.
          </p>
          {lesson ? (
            <p>
              Using: {lesson.label}
              {lesson.truncated ? " (bounded excerpt)" : ""}
              {lesson.omitted_sections ? " · solutions omitted" : ""}
            </p>
          ) : (
            <p>No lesson text selected.</p>
          )}
          {client.guideLesson ? (
            <>
              <Button
                type="button"
                disabled={recovery || pending || !contextReady}
                onClick={() => void direct("use_lesson")}
              >
                Use this lesson
              </Button>
              <Button
                type="button"
                disabled={recovery || pending || !lesson}
                onClick={() => void direct("reset_lesson")}
              >
                Clear lesson scope
              </Button>
            </>
          ) : null}
        <details>
          <summary>Optional learning choices</summary>
          <p>Keep working here without another revisit suggestion for this activity in this conversation.</p>
          {client.guideAction ? (
            <Button type="button" disabled={recovery || pending || !contextReady}
              onClick={() => void direct("decline_revisit")}>
              Continue without revisiting
            </Button>
          ) : null}
        </details>
        </details>
        {allowedShareKinds.length > 0 ? (
          <button
            ref={shareTrigger}
            type="button"
            className="cw-button"
            disabled={
              recovery || !enabled || pending || composer.trim().length === 0
            }
            onClick={() => setShareOpen(true)}
          >
            Share before asking
          </button>
        ) : null}
        {shareOpen ? (
          <ShareDialog
            maxChars={maxShareChars}
            allowedKinds={allowedShareKinds}
            onCancel={() => setShareOpen(false)}
            onConfirm={send}
            onCapture={captureShare}
            restoreFocus={restoreShareFocus}
          />
        ) : null}
        {candidates.map((candidate) => (
          <section key={candidate.id}>
            <p>Suggested change ready for review.</p>
            <Button
              type="button"
              disabled={recovery || sharedRunPending || candidate.pending}
              onClick={() => void persistCandidate(candidate.id)}
            >
              Save suggested change
            </Button>
          </section>
        ))}
        {notice ? <p role="status">{notice}</p> : null}
        {notice && composer.trim().length > 0 ? (
          <Button
            type="button"
            disabled={recovery || !enabled || pending}
            onClick={() => void send(undefined, true)}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </section>
  );
}
