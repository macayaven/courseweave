import { Button, consumeAguiStream, type ProviderStatus } from "@courseweave/ui";
import { useEffect, useRef, useState } from "react";

type CurriculumClient = {
  postGuide(
    body: {
      threadId: string;
      runId: string;
      messages: Array<{ id: string; role: "user"; content: string }>;
      tools: [];
      context: [];
      forwardedProps: { source_id: string };
    },
    signal?: AbortSignal,
  ): Promise<Response>;
  createProposal(candidateId: string, signal?: AbortSignal): Promise<unknown>;
};

type Transcript = {
  id: string;
  text: string;
  state: "streaming" | "finished" | "interrupted" | "failed";
};

export function CurriculumThread({
  client,
  sourceId,
  clean,
  recovery,
  onProvider,
  onProposal,
  onRefresh,
}: {
  client: CurriculumClient;
  sourceId: string;
  clean: boolean;
  recovery: boolean;
  onProvider(status: ProviderStatus): void;
  onProposal(proposal: unknown): void;
  onRefresh(): Promise<boolean>;
}) {
  const [threadId] = useState(() => crypto.randomUUID());
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
    if (!recovery) return;
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
  }, [recovery]);

  const finish = (id: string, state: Transcript["state"]) =>
    setTranscript((items) =>
      items.map((item) => (item.id === id ? { ...item, state } : item)),
    );

  const persistCandidate = async (candidateId: string) => {
    if (recovery || candidateFlights.current.has(candidateId)) return;
    const controller = new AbortController();
    candidateFlights.current.set(candidateId, controller);
    try {
      const proposal = await client.createProposal(candidateId, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onProposal(proposal);
      setCandidates((items) => items.filter((id) => id !== candidateId));
      let refreshed = false;
      try {
        refreshed = await onRefresh();
      } catch {
        refreshed = false;
      }
      if (!refreshed)
        setNotice("Suggested change saved, refresh unavailable; reconnect/review before another action.");
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
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
    } finally {
      candidateFlights.current.delete(candidateId);
    }
  };

  const send = async () => {
    if (!clean || recovery || pending || composer.trim().length === 0) return;
    const submitted = composer;
    const controller = new AbortController();
    active.current = controller;
    const runId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    setPending(true);
    setNotice(null);
    try {
      const response = await client.postGuide(
        {
          threadId,
          runId,
          messages: [{ id: messageId, role: "user", content: submitted }],
          tools: [],
          context: [],
          forwardedProps: { source_id: sourceId },
        },
        controller.signal,
      );
      if (response.body === null) throw new Error("Missing teacher response.");
      const outcome = await consumeAguiStream(
        response.body,
        { threadId, runId },
        (event) => {
          if (event.type === "TEXT_MESSAGE_START")
            setTranscript((items) => [
              ...items,
              { id: messageId, text: "", state: "streaming" },
            ]);
          if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.delta === "string")
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
      setNotice(code === "not_configured" || code === "provider_error" ? "Teacher unavailable" : "Teacher connection interrupted. Your draft is unsent.");
    } finally {
      if (alive.current && active.current === controller) {
        active.current = null;
        setPending(false);
      }
    }
  };

  const disabled = !clean || recovery || pending || composer.trim().length === 0;
  return (
    <section aria-label="Curriculum teacher">
      <h2>Curriculum teacher</h2>
      <p>
        Asking sends the saved manifest to the configured provider. Teacher suggestions
        remain proposals for your review.
      </p>
      {!clean ? (
        <p role="status">
          Save or review your local draft first: the teacher operates on the saved manifest.
        </p>
      ) : null}
      {transcript.map((item) => (
        <p key={item.id} data-state={item.state}>
          {item.text}
        </p>
      ))}
      <label>
        Ask the curriculum teacher
        <textarea value={composer} onChange={(event) => setComposer(event.target.value)} />
      </label>
      <Button type="button" disabled={disabled} onClick={() => void send()}>
        Ask teacher
      </Button>
      {candidates.map((candidateId) => (
        <section key={candidateId}>
          <p>Suggested change ready for review.</p>
          <Button
            type="button"
            disabled={recovery}
            onClick={() => void persistCandidate(candidateId)}
          >
            Save suggested change
          </Button>
        </section>
      ))}
      {notice ? <p role="status">{notice}</p> : null}
      {notice && composer.trim().length > 0 ? (
        <Button type="button" disabled={disabled} onClick={() => void send()}>
          Retry
        </Button>
      ) : null}
    </section>
  );
}
