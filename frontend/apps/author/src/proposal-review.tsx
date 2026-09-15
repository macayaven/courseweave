import { Button, type Proposal } from "@courseweave/ui";
import { useEffect, useRef, useState } from "react";
import type { ContentReview } from "./content-panel";

type ProposalClient = {
  validateCourse(manifest: unknown, signal?: AbortSignal): Promise<{ formatted_json?: unknown }>;
  editProposal(proposalId: string, body: unknown, signal?: AbortSignal): Promise<Proposal>;
  acceptProposal(proposalId: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
  rejectProposal(proposalId: string, body: { expected_revision: number }, signal?: AbortSignal): Promise<Proposal>;
};
type RefreshResult = { committed: boolean };

/** The server returns the immutable diff; the UI never composes write authority. */
export function ContentChangeReview({ review, disabled, onApply, onReject, onEdit }: {
  review: ContentReview; disabled: boolean; onApply(): Promise<void>; onReject(): Promise<void>; onEdit(): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => { heading.current?.focus(); }, [review.change_id]);
  useEffect(() => {
    setAcknowledged(false);
    if (restoreFocus.current) { heading.current?.focus(); restoreFocus.current = false; }
  }, [review.status, review.change_id, review.revision]);
  const pending = review.status === "pending";
  return <article aria-label="File change review">
    <h3 ref={heading} tabIndex={-1}>Review {review.target_path}</h3>
    <p>Status: {review.status} · Revision: {review.revision}</p>
    <details><summary>{review.before_exists ? "Replacement file hashes" : "New file hash"}</summary>
      <p>Before: {review.before_exists ? review.before_sha256 : "file absent"}<br />After: {review.after_sha256}</p>
    </details>
    <h4>Exact file diff</h4><pre>{review.diff}</pre>
    <p>Candidate file checks passed. Export readiness is checked separately.</p>
    {review.issues.map((issue, index) => <p key={issue.code + ":" + index}>{issue.message}</p>)}
    {pending && <>
      <label><input type="checkbox" checked={acknowledged} disabled={disabled}
        onChange={(event) => setAcknowledged(event.target.checked)} />I reviewed this exact diff</label>
      <Button disabled={disabled || !acknowledged} onClick={(event) => {
        restoreFocus.current = document.activeElement === event.currentTarget; void onApply();
      }}>Apply reviewed change</Button>
      {(review.text !== undefined || review.notebook) && <Button disabled={disabled} onClick={onEdit}>Edit this change</Button>}
    </>}
    {["pending", "stale", "conflict", "failed"].includes(review.status) && <Button disabled={disabled} onClick={(event) => {
      restoreFocus.current = document.activeElement === event.currentTarget; void onReject();
    }}>Reject change</Button>}
    {["stale", "conflict", "failed"].includes(review.status) && <p role="status">Inspect the saved file, then create and review a new edit. This candidate cannot apply.</p>}
  </article>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestPayload(proposal: Proposal): Record<string, unknown> | null {
  const manifest = proposal.payload.manifest;
  return isRecord(manifest) && manifest.schema_version === 2 && Array.isArray(manifest.modules) ? manifest : null;
}

function validHash(hash: unknown): hash is string | null {
  return hash === null || (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
}

/** Author deliberately exposes only curriculum manifest proposals, never global proposals. */
function isAuthorManifestProposal(proposal: Proposal): boolean {
  return proposal.type === "manifest_replace" && proposal.origin === "teacher_suggested" && proposal.target === "courseweave.json" && manifestPayload(proposal) !== null && validHash(proposal.target_hash);
}

function etagHash(etag: string): string | null | undefined {
  if (etag === '""') return null;
  return etag.match(/^"([a-f0-9]{64})"$/)?.[1];
}

function textDiff(before: string, after: string): string {
  if (before === after) return "No textual changes.";
  const lines = (prefix: string, value: string) => value.split("\n").map((line) => `${prefix}${line}`).join("\n");
  return `--- saved target\n+++ proposed replacement\n${lines("- ", before)}\n${lines("+ ", after)}`;
}

export function ProposalReview({ proposals, savedRaw, savedEtag, client, clean, recovery, authorityBlocked = false, savePending, onRefresh, onProposal, onConflict, onAcceptedCourse, onAuthorityUnknown = () => undefined }: {
  proposals: Proposal[];
  savedRaw: string;
  savedEtag: string;
  client: ProposalClient;
  clean: boolean;
  recovery: boolean;
  authorityBlocked?: boolean;
  savePending: boolean;
  onRefresh(signal?: AbortSignal): Promise<RefreshResult>;
  onProposal(proposal: Proposal): void;
  onConflict(): void;
  onAcceptedCourse(): void;
  onAuthorityUnknown?(): void;
}) {
  const authorProposals = proposals.filter(isAuthorManifestProposal);
  const [canonical, setCanonical] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const proposalHeadings = useRef(new Map<string, HTMLHeadingElement>());
  const key = (proposal: Proposal) => `${proposal.id}:${proposal.revision}`;
  useEffect(() => () => controllers.current.forEach((controller) => controller.abort()), []);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(authorProposals.map(async (proposal) => {
      const result = await client.validateCourse(manifestPayload(proposal), controller.signal);
      return [key(proposal), result.formatted_json] as const;
    })).then((entries) => {
      if (controller.signal.aborted) return;
      setCanonical((current) => ({ ...current, ...Object.fromEntries(entries.flatMap(([proposalKey, raw]) => typeof raw === "string" ? [[proposalKey, raw]] : [])) }));
    }).catch(() => undefined);
    return () => controller.abort();
  }, [client, proposals]);
  useEffect(() => {
    if (!recovery) return;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    setActive(null);
  }, [recovery]);

  const blockReason = !clean ? "Save or review your local draft first: proposal actions use the saved manifest."
    : recovery ? "Reconnect and review the saved course before changing a proposal."
    : authorityBlocked ? "Reconnect and review authoritative course and proposals before changing a proposal."
    : savePending ? "Wait for the direct Save to finish before changing a proposal." : null;
  const savedHash = etagHash(savedEtag);

  const perform = async (proposal: Proposal, action: "edit" | "accept" | "reject", trigger: HTMLButtonElement) => {
    const proposalKey = key(proposal);
    if (blockReason !== null || active !== null || proposal.target_hash !== savedHash || canonical[proposalKey] === undefined) return;
    const restoreFocus = document.activeElement === trigger;
    const controller = new AbortController();
    const actionKey = `${proposalKey}:${action}`;
    controllers.current.set(actionKey, controller);
    setActive(actionKey);
    setNotice(null);
    try {
      let next: Proposal;
      if (action === "edit") {
        const text = drafts[proposal.id] ?? canonical[proposalKey];
        let manifest: unknown;
        try { manifest = JSON.parse(text); } catch { setNotice("Edited manifest must be valid JSON before it can be reviewed."); return; }
        await client.validateCourse(manifest, controller.signal);
        next = await client.editProposal(proposal.id, { expected_revision: proposal.revision, request: { payload: { manifest }, target_hash: proposal.target_hash } }, controller.signal);
      } else if (action === "accept") {
        next = await client.acceptProposal(proposal.id, { expected_revision: proposal.revision }, controller.signal);
      } else {
        next = await client.rejectProposal(proposal.id, { expected_revision: proposal.revision }, controller.signal);
      }
      if (controller.signal.aborted) {
        onAuthorityUnknown();
        return;
      }
      onProposal(next);
      let committed = false;
      try { committed = (await onRefresh(controller.signal)).committed; } catch { /* Parent remains blocked. */ }
      if (action === "accept" && next.status === "accepted" && committed) onAcceptedCourse();
      if (committed && restoreFocus && !trigger.isConnected && document.activeElement === document.body) {
        proposalHeadings.current.get(proposal.id)?.focus();
      }
      setNotice(committed ? "Proposal saved from the authoritative review." : "Proposal saved, refresh unavailable; reconnect/review before another action.");
    } catch (error) {
      if (controller.signal.aborted) {
        onAuthorityUnknown();
        return;
      }
      const conflict = typeof error === "object" && error !== null && (error as { status?: unknown }).status === 409;
      if (conflict) {
        let refreshed = false;
        try {
          refreshed = (await onRefresh(controller.signal)).committed;
        } catch { /* Retain the local draft for review. */ }
        onConflict();
        setNotice(refreshed ? "Proposal changed; review refreshed proposals before trying again." : "Proposal changed, refresh unavailable; reconnect/review before trying again.");
      } else {
        onAuthorityUnknown();
        setNotice("Proposal action could not be completed. Reconnect/review before another action.");
      }
    } finally {
      controllers.current.delete(actionKey);
      setActive((current) => current === actionKey ? null : current);
    }
  };

  return <section aria-label="Proposal review"><h2>Proposal review</h2>{blockReason ? <p role="status">{blockReason}</p> : null}{authorProposals.map((proposal) => {
    const proposalKey = key(proposal);
    const proposed = canonical[proposalKey];
    const targetCurrent = proposal.target_hash === savedHash;
    const actionable = proposal.status === "pending" && targetCurrent && proposed !== undefined && blockReason === null && active === null;
    return <article key={proposalKey}><h3 tabIndex={-1} ref={(node) => { if (node) proposalHeadings.current.set(proposal.id, node); else proposalHeadings.current.delete(proposal.id); }}>{proposal.summary}</h3><p>Status: {proposal.status}</p><p>Pending revision: {proposal.revision}</p><p>Target hash: {proposal.target_hash ?? "missing manifest"}</p>{targetCurrent ? <><h4>Target manifest</h4><pre>{savedRaw}</pre></> : <><p role="status">Proposal target no longer matches the saved course. It cannot be applied.</p><h4>Current saved manifest (not the proposal target)</h4><pre>{savedRaw}</pre></>}<h4>Proposed manifest</h4><pre>{proposed ?? "Validating proposed manifest…"}</pre><h4>Text diff</h4><pre>{proposed === undefined ? "Diff unavailable until validation succeeds." : textDiff(savedRaw, proposed)}</pre>{proposal.status === "pending" && proposed !== undefined && targetCurrent ? <><label>Edit full manifest<textarea value={drafts[proposal.id] ?? proposed} disabled={!actionable} onChange={(event) => setDrafts((current) => ({ ...current, [proposal.id]: event.target.value }))} /></label><Button type="button" disabled={!actionable} onClick={(event) => void perform(proposal, "accept", event.currentTarget)}>Accept</Button><Button type="button" disabled={!actionable} onClick={(event) => void perform(proposal, "reject", event.currentTarget)}>Reject</Button><Button type="button" disabled={!actionable} onClick={(event) => void perform(proposal, "edit", event.currentTarget)}>Save proposal edit</Button></> : null}</article>;
  })}{notice ? <p role="status">{notice}</p> : null}</section>;
}
