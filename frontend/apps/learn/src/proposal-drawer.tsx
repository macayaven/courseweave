import { Button, EmptyState } from '@courseweave/ui';
import type { LearnerState, Proposal } from '@courseweave/ui/courseweave-types';
import { useEffect, useRef, useState } from 'react';

import type { ProposalEditRequest } from './api';

type ProposalClient = {
  acceptProposal(id: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
  rejectProposal(id: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
  editProposal(id: string, body: { expected_revision: number; request: ProposalEditRequest }, signal?: AbortSignal): Promise<Proposal>;
};

export function ProposalDrawer({ proposals, client, onRefresh, onProposal, onDraftChange, recovery = false }: { proposals: Proposal[]; state: LearnerState; client: ProposalClient; onRefresh(): Promise<void>; onProposal(proposal: Proposal): void; onDraftChange?(hasDraft: boolean): void; recovery?: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const alive = useRef(true);
  const flights = useRef(new Map<string, AbortController>());
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flights.current.forEach((controller) => controller.abort()); };
  }, []);
  useEffect(() => { onDraftChange?.(Object.values(drafts).some((draft) => draft.trim().length > 0)); }, [drafts, onDraftChange]);
  useEffect(() => {
    if (!recovery) return;
    flights.current.forEach((controller) => controller.abort());
    flights.current.clear();
    setPending({});
  }, [recovery]);
  async function request(proposalId: string, action: (signal: AbortSignal) => Promise<Proposal>) {
    if (pending[proposalId]) return;
    const controller = new AbortController();
    flights.current.set(proposalId, controller);
    setPending((previous) => ({ ...previous, [proposalId]: true }));
    try {
      const proposal = await action(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      onProposal(proposal);
      setNotice(null);
    } catch (error: unknown) {
      if (!alive.current || controller.signal.aborted) return;
      const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
      const conflict = (typeof error === 'object' && error !== null && (error as { status?: number }).status === 409)
        || code === 'proposal_conflict' || code === 'target_changed' || code === 'revision_mismatch';
      if (conflict) {
        await onRefresh();
        if (!alive.current || controller.signal.aborted) return;
        setNotice('Proposal changed; review refreshed proposals.');
      } else setNotice('Proposal action could not be completed. Review and try again.');
    } finally {
      flights.current.delete(proposalId);
      if (alive.current) setPending((previous) => ({ ...previous, [proposalId]: false }));
    }
  }
  if (proposals.length === 0) return <EmptyState title="No pending proposals"><p>Teacher suggestions appear here after REST persistence.</p></EmptyState>;
  return <aside aria-label="Proposals">{notice ? <p role="status">{notice}</p> : null}{proposals.map((proposal) => {
    const disabled = pending[proposal.id] === true;
    return <article key={proposal.id}><h2>{proposal.summary}</h2><p>Status: {proposal.status}</p><pre>{typeof proposal.payload.diff === 'string' ? proposal.payload.diff : JSON.stringify(proposal.payload, null, 2)}</pre>{proposal.status === 'pending' ? <><label>Edit summary<input aria-label="Edit summary" disabled={disabled} value={drafts[proposal.id] ?? ''} onChange={(event) => setDrafts((previous) => ({ ...previous, [proposal.id]: event.target.value }))} /></label><Button type="button" disabled={disabled} onClick={() => void request(proposal.id, (signal) => client.acceptProposal(proposal.id, { expected_revision: proposal.revision }, signal))}>Accept</Button><Button type="button" disabled={disabled} onClick={() => void request(proposal.id, (signal) => client.rejectProposal(proposal.id, { expected_revision: proposal.revision }, signal))}>Reject</Button><Button type="button" disabled={disabled} onClick={() => void request(proposal.id, (signal) => client.editProposal(proposal.id, { expected_revision: proposal.revision, request: drafts[proposal.id] ? { summary: drafts[proposal.id] } : {} }, signal))}>Save edit</Button></> : null}</article>;
  })}</aside>;
}
