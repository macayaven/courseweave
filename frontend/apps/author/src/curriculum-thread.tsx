import {
  Button,
  consumeAguiStream,
  isTurnContextMetadata,
  type ProviderStatus,
} from "@courseweave/ui";
import { useEffect, useRef, useState } from "react";

import type {
  AuthorActivitySelection,
  AuthorActivityConfirmation,
} from "./api";

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
