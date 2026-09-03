import { Button, type Proposal } from "@courseweave/ui";
import { useEffect, useRef, useState } from "react";

type ProposalClient = {
  validateCourse(manifest: unknown, signal?: AbortSignal): Promise<unknown>;
  editProposal(proposalId: string, body: unknown, signal?: AbortSignal): Promise<Proposal>;
  acceptProposal(proposalId: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
  rejectProposal(proposalId: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
};

function manifestOf(proposal: Proposal): unknown | null {
  const manifest = proposal.payload.manifest;
  return typeof manifest === "object" && manifest !== null ? manifest : null;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 409
  );
}

export function ProposalReview({
  proposals,
  savedManifest,
  client,
  clean,
  recovery,
  savePending,
  onRefresh,
  onConflict,
  onAcceptedCourse,
}: {
  proposals: Proposal[];
  savedManifest: unknown;
  client: ProposalClient;
  clean: boolean;
  recovery: boolean;
  savePending: boolean;
  onRefresh(): Promise<void>;
  onConflict(): void;
  onAcceptedCourse(): void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => controllers.current.forEach((controller) => controller.abort()),
    [],
  );
  useEffect(() => {
    if (!recovery) return;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setActive(null);
  }, [recovery]);

  const blockReason = !clean
    ? "Save or review your local draft first: proposal actions use the saved manifest."
    : recovery
      ? "Reconnect and review the saved course before changing a proposal."
      : savePending
        ? "Wait for the direct Save to finish before changing a proposal."
        : null;
  const disabled = blockReason !== null;

  const perform = async (
    proposal: Proposal,
    action: "edit" | "accept" | "reject",
  ) => {
    if (disabled || active !== null) return;
    const controller = new AbortController();
    const actionKey = `${proposal.id}:${action}`;
    controllers.current.set(actionKey, controller);
    setActive(actionKey);
    setNotice(null);
    try {
      let next: Proposal;
      if (action === "edit") {
        const text = drafts[proposal.id] ?? canonicalText(manifestOf(proposal));
        let manifest: unknown;
        try {
          manifest = JSON.parse(text);
        } catch {
          setNotice("Edited manifest must be valid JSON before it can be reviewed.");
          return;
        }
        await client.validateCourse(manifest, controller.signal);
        next = await client.editProposal(
          proposal.id,
          {
            expected_revision: proposal.revision,
            request: {
              payload: { manifest },
              target_hash: proposal.target_hash,
            },
          },
          controller.signal,
        );
      } else if (action === "accept") {
        next = await client.acceptProposal(
          proposal.id,
          { expected_revision: proposal.revision },
          controller.signal,
        );
      } else {
        next = await client.rejectProposal(
          proposal.id,
          { expected_revision: proposal.revision },
          controller.signal,
        );
      }
      if (controller.signal.aborted) return;
      await onRefresh();
      if (action === "accept" && next.status === "accepted") onAcceptedCourse();
      setNotice("Proposal saved from the authoritative review.");
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isConflict(error)) {
        try {
          await onRefresh();
        } finally {
          onConflict();
          setNotice("Proposal changed; review refreshed proposals before trying again.");
        }
      } else setNotice("Proposal action could not be completed.");
    } finally {
      controllers.current.delete(actionKey);
      setActive((current) => (current === actionKey ? null : current));
    }
  };

  return (
    <section aria-label="Proposal review">
      <h2>Proposal review</h2>
      {blockReason ? <p role="status">{blockReason}</p> : null}
      {proposals.map((proposal) => {
        const candidate = manifestOf(proposal);
        const pending = proposal.status === "pending" && candidate !== null;
        const actionKey = (action: string) => `${proposal.id}:${action}`;
        const editing = active !== null;
        return (
          <article key={`${proposal.id}:${proposal.revision}`}>
            <h3>{proposal.summary}</h3>
            <p>Status: {proposal.status}</p>
            <p>Pending revision: {proposal.revision}</p>
            {candidate !== null ? (
              <>
                <h4>Saved manifest</h4>
                <pre>{canonicalText(savedManifest)}</pre>
                <h4>Proposed manifest</h4>
                <pre>{canonicalText(candidate)}</pre>
                <h4>Text diff</h4>
                <pre>{typeof proposal.payload.diff === "string" ? proposal.payload.diff : "No diff provided."}</pre>
              </>
            ) : null}
            {pending ? (
              <>
                <label>
                  Edit full manifest
                  <textarea
                    value={drafts[proposal.id] ?? canonicalText(candidate)}
                    disabled={disabled || editing}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [proposal.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <Button
                  type="button"
                  disabled={disabled || editing}
                  onClick={() => void perform(proposal, "accept")}
                >
                  Accept
                </Button>
                <Button
                  type="button"
                  disabled={disabled || editing}
                  onClick={() => void perform(proposal, "reject")}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  disabled={disabled || editing}
                  onClick={() => void perform(proposal, "edit")}
                >
                  Save proposal edit
                </Button>
              </>
            ) : null}
            {active === actionKey("edit") ? <p>Saving edit…</p> : null}
          </article>
        );
      })}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
