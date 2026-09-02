import { Button, EmptyState } from '@courseweave/ui';
import type { LearnerState, Proposal } from '@courseweave/ui/courseweave-types';
import { useState } from 'react';

import type { ProposalEditRequest } from './api';

type ProposalClient = {
  acceptProposal(id: string, body: { expected_revision: number }): Promise<Proposal>;
  rejectProposal(id: string, body: { expected_revision: number }): Promise<Proposal>;
  editProposal(id: string, body: { expected_revision: number; request: ProposalEditRequest }): Promise<Proposal>;
};

export function ProposalDrawer({ proposals, state, client, onRefresh }: { proposals: Proposal[]; state: LearnerState; client: ProposalClient; onRefresh(): Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  async function request(action: () => Promise<Proposal>) {
    try { await action(); setNotice(null); }
    catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'revision_mismatch') {
        await onRefresh();
        setNotice('Proposal changed; review refreshed proposals.');
      } else setNotice('Proposal action could not be completed. Review and try again.');
    }
  }
  if (proposals.length === 0) return <EmptyState title="No pending proposals"><p>Teacher suggestions appear here after REST persistence.</p></EmptyState>;
  return <aside aria-label="Proposals">{notice ? <p role="status">{notice}</p> : null}{proposals.map((proposal) => <article key={proposal.id}><h2>{proposal.summary}</h2><p>Status: {proposal.status}</p><pre>{typeof proposal.payload.diff === 'string' ? proposal.payload.diff : JSON.stringify(proposal.payload, null, 2)}</pre>{proposal.status === 'pending' ? <><label>Edit summary<input aria-label="Edit summary" value={drafts[proposal.id] ?? ''} onChange={(event) => setDrafts((previous) => ({ ...previous, [proposal.id]: event.target.value }))} /></label><Button type="button" onClick={() => void request(() => client.acceptProposal(proposal.id, { expected_revision: proposal.revision }))}>Accept</Button><Button type="button" onClick={() => void request(() => client.rejectProposal(proposal.id, { expected_revision: proposal.revision }))}>Reject</Button><Button type="button" onClick={() => void request(() => client.editProposal(proposal.id, { expected_revision: proposal.revision, request: drafts[proposal.id] ? { summary: drafts[proposal.id] } : {} }))}>Save edit</Button></> : null}</article>)}</aside>;
}
