import { Button, EmptyState } from "@courseweave/ui";
import type { LearnerState, Proposal } from "@courseweave/ui/courseweave-types";
import { useEffect, useRef, useState } from "react";

import type { ProposalEditRequest } from "./api";

type ProposalClient = {
  acceptProposal(
    id: string,
    body: { expected_revision: number },
    signal?: AbortSignal,
  ): Promise<Proposal>;
  rejectProposal(
    id: string,
    body: { expected_revision: number },
    signal?: AbortSignal,
  ): Promise<Proposal>;
  editProposal(
    id: string,
    body: { expected_revision: number; request: ProposalEditRequest },
    signal?: AbortSignal,
  ): Promise<Proposal>;
};

export function ProposalDrawer({
  proposals,
  state,
  client,
  onRefresh,
  onProposal,
  drafts: controlledDrafts,
  onDraftsChange,
  onDraftChange,
  recovery = false,
  sharedRunPending = false,
  onRecovery,
}: {
  proposals: Proposal[];
  state: LearnerState;
  client: ProposalClient;
  onRefresh(): Promise<void>;
  onProposal(proposal: Proposal): void;
  drafts?: Record<string, string>;
  onDraftsChange?(drafts: Record<string, string>): void;
  onDraftChange?(hasDraft: boolean): void;
  recovery?: boolean;
  sharedRunPending?: boolean;
  onRecovery?(): void;
}) {
  const [internalDrafts, setInternalDrafts] = useState<Record<string, string>>(
    {},
  );
  const drafts = controlledDrafts ?? internalDrafts;
  const setDrafts = onDraftsChange ?? setInternalDrafts;
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  const flights = useRef(new Map<string, AbortController>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      flights.current.forEach((controller) => controller.abort());
    };
  }, []);
  useEffect(() => {
    onDraftChange?.(
      Object.values(drafts).some((draft) => draft.trim().length > 0),
    );
  }, [drafts, onDraftChange]);
  useEffect(() => {
    if (!recovery) return;
    flights.current.forEach((controller) => controller.abort());
    flights.current.clear();
    setPending({});
  }, [recovery]);
  async function request(
    proposalId: string,
    action: (signal: AbortSignal) => Promise<Proposal>,
  ) {
    if (recovery || sharedRunPending || pending[proposalId]) return;
    const controller = new AbortController();
    flights.current.set(proposalId, controller);
    setPending((previous) => ({ ...previous, [proposalId]: true }));
    try {
      const proposal = await action(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      try {
        await onRefresh();
        if (!alive.current || controller.signal.aborted) return;
        onProposal(proposal);
        setNotice(null);
      } catch (error: unknown) {
        if (!alive.current || controller.signal.aborted) return;
        const status =
          typeof error === "object" && error !== null
            ? (error as { status?: number }).status
            : undefined;
        if (status === 401 || status === 403) onRecovery?.();
        setNotice("Proposal saved, refresh unavailable.");
      }
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const code =
        typeof error === "object" && error !== null
          ? (error as { code?: string }).code
          : undefined;
      const conflict =
        (typeof error === "object" &&
          error !== null &&
          (error as { status?: number }).status === 409) ||
        code === "proposal_conflict" ||
        code === "target_changed" ||
        code === "revision_mismatch";
      if (conflict) {
        try {
          await onRefresh();
          if (!alive.current || controller.signal.aborted) return;
          setNotice("Proposal changed; review refreshed proposals.");
        } catch (refreshError: unknown) {
          if (!alive.current || controller.signal.aborted) return;
          onRecovery?.();
          setNotice("Proposal refresh failed. Reconnect to continue.");
        }
      } else {
        const status =
          typeof error === "object" && error !== null
            ? (error as { status?: number }).status
            : undefined;
        if (status === 401 || status === 403) onRecovery?.();
        setNotice(
          "Proposal action could not be completed. Review and try again.",
        );
      }
    } finally {
      flights.current.delete(proposalId);
      if (alive.current)
        setPending((previous) => ({ ...previous, [proposalId]: false }));
    }
  }
  const orphanDrafts = Object.entries(drafts).filter(
    ([id, value]) =>
      value.trim().length > 0 &&
      !proposals.some(
        (proposal) => proposal.id === id && proposal.status === "pending",
      ),
  );
  if (proposals.length === 0 && orphanDrafts.length === 0) return null;
  return (
    <aside aria-label="Proposals">
      {notice ? <p role="status">{notice}</p> : null}
      {proposals.map((proposal) => {
        const disabled =
          recovery || sharedRunPending || pending[proposal.id] === true;
        return (
          <article key={proposal.id}>
            <h2>{proposal.summary}</h2>
            <p>Status: {proposal.status}</p>
            {proposal.type === "profile_patch" && !state.preferences.enabled ? (
              <p>
                Enable optional adaptation to accept this preference suggestion.
              </p>
            ) : null}
            <pre className="cw-proposal-diff">
              {typeof proposal.payload.diff === "string"
                ? proposal.payload.diff
                : JSON.stringify(proposal.payload, null, 2)}
            </pre>
            {proposal.status === "pending" ? (
              <>
                <label>
                  Edit summary
                  <input
                    aria-label="Edit summary"
                    disabled={sharedRunPending}
                    value={drafts[proposal.id] ?? ""}
                    onChange={(event) =>
                      setDrafts({
                        ...drafts,
                        [proposal.id]: event.target.value,
                      })
                    }
                  />
                </label>
                <Button
                  type="button"
                  disabled={
                    disabled ||
                    (proposal.type === "profile_patch" &&
                      !state.preferences.enabled)
                  }
                  onClick={() =>
                    void request(proposal.id, (signal) =>
                      client.acceptProposal(
                        proposal.id,
                        { expected_revision: proposal.revision },
                        signal,
                      ),
                    )
                  }
                >
                  Accept
                </Button>
                <Button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void request(proposal.id, (signal) =>
                      client.rejectProposal(
                        proposal.id,
                        { expected_revision: proposal.revision },
                        signal,
                      ),
                    )
                  }
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void request(proposal.id, (signal) =>
                      client.editProposal(
                        proposal.id,
                        {
                          expected_revision: proposal.revision,
                          request: drafts[proposal.id]
                            ? { summary: drafts[proposal.id] }
                            : {},
                        },
                        signal,
                      ),
                    )
                  }
                >
                  Save edit
                </Button>
              </>
            ) : null}
          </article>
        );
      })}
      {orphanDrafts.length > 0 ? (
        <section aria-label="Unsent proposal edits">
          <h2>Unsent proposal edits</h2>
          {orphanDrafts.map(([id, value]) => (
            <label key={id}>
              Unsent edit for {id}
              <input
                value={value}
                onChange={(event) =>
                  setDrafts({ ...drafts, [id]: event.target.value })
                }
              />
            </label>
          ))}
        </section>
      ) : null}
    </aside>
  );
}
