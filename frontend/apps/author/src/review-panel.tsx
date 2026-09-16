import { useEffect, useRef, useState } from "react";
import type { AuthorRole } from "@courseweave/ui";
import type { AssistantSelection } from "./curriculum-thread";
import type { SourceRecord } from "./project-panel";
import type { CompatibilityReport } from "./compatibility";
import { useBeforeUnload } from "./reconnect";

export type HumanDisposition = "unreviewed" | "accepted" | "revised" | "dismissed";
type SourceIdentity = { source_id: string; revision: number; raw_sha256: string; text_sha256: string | null; extractor_version: string | null };
export type ReviewFinding = { claim_id: string; judgment: string; explanation: string;
  evidence: (SourceIdentity & { quote: string; start: number; end: number })[];
  provenance: "located" | "mismatch" | "missing" | "not_checked"; human_disposition: HumanDisposition;
  disposition_reason: string; objective_ids: string[] };
export interface ReviewReport {
  version: "author-review-v1"; report_id: string; project_id: string; revision: number;
  context_digest: string; project_revision: number; manifest_sha256: string; prompt_version: string;
  context_budget: { max_input_chars: number; max_output_chars: number };
  selection: AssistantSelection; target_path: string; target_sha256: string; target_exists: boolean;
  target_fully_visible: boolean; target_characters: number | null; role: AuthorRole; summary: string;
  status: "current" | "stale"; stale_reasons: string[]; saved_at: string; updated_at: string; omissions: string[];
  compatibility: { scope: "saved_course"; student_profile: string; manifest_sha256: string;
    preliminary_checks_passed: boolean; issues: CompatibilityReport["structural"]; omitted_issues: number; notice: string };
  sources: Pick<SourceRecord, "source_id" | "revision" | "raw_sha256" | "text_sha256" | "extractor_version" | "title" | "origin" | "imported_at" | "retrieved_at" | "publication_date" | "final_url" | "extraction" | "policy_decision" | "status" | "redistribution">[];
  findings: ReviewFinding[];
}
export type ReviewSummary = Pick<ReviewReport, "report_id" | "role" | "target_path" | "status" | "revision" | "saved_at" | "summary">;
export interface ReviewDecision { revision: number; human_disposition: HumanDisposition; reason: string; objective_ids: string[] }
export interface ReviewClient {
  getReviews(offset?: number, signal?: AbortSignal): Promise<{ reports: ReviewSummary[]; next_offset: number | null }>;
  getReview(id: string, signal?: AbortSignal): Promise<ReviewReport>;
  updateReviewFinding(id: string, claimId: string, decision: ReviewDecision, signal?: AbortSignal): Promise<ReviewReport>;
  deleteReview(id: string, revision: number, signal?: AbortSignal): Promise<void>;
  exportReview(id: string, revision: number, signal?: AbortSignal): Promise<Blob>;
}
type Objective = { id: string; text: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The review request could not be completed.";
const decisionOf = (finding: ReviewFinding, revision: number): ReviewDecision => ({ revision,
  human_disposition: finding.human_disposition, reason: finding.disposition_reason, objective_ids: finding.objective_ids });

function FindingEditor({ finding, report, objectives, disabled, onDirtyChange, onSave }: {
  finding: ReviewFinding; report: ReviewReport; objectives: Objective[]; disabled: boolean;
  onDirtyChange(dirty: boolean): void; onSave(decision: ReviewDecision): void;
}) {
  const [decision, setDecision] = useState(() => decisionOf(finding, report.revision));
  const dirty = JSON.stringify(decision) !== JSON.stringify(decisionOf(finding, report.revision));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const requiresReason = decision.human_disposition === "dismissed" || decision.human_disposition === "revised";
  const staleAcceptance = report.status === "stale" && (decision.human_disposition === "accepted" || decision.human_disposition === "revised");
  return <article aria-label={`Finding ${finding.claim_id}`}>
    <h3>{finding.claim_id}</h3>
    <p>Model judgment: {finding.judgment}</p><p>{finding.explanation}</p>
    <p>Quotation provenance: {finding.provenance}</p>
    <p>A located quotation matches the retained source and character range. It does not establish whether the claim follows from it.</p>
    {finding.evidence.map((evidence, index) => <blockquote key={index}>
      <p>{evidence.quote}</p><footer>{evidence.source_id} · Revision {evidence.revision} · Characters {evidence.start}–{evidence.end} (end excluded)</footer>
      <details><summary>Quotation identity</summary><p>Raw SHA-256: {evidence.raw_sha256}</p>
        <p>Text SHA-256: {evidence.text_sha256 ?? "Unavailable"}</p><p>Extractor: {evidence.extractor_version ?? "Unavailable"}</p></details>
    </blockquote>)}
    {finding.evidence.length === 0 && <p>No quoted evidence was supplied.</p>}
    <label>Your disposition<select aria-label="Your disposition" value={decision.human_disposition} disabled={disabled}
      onChange={event => setDecision(value => ({ ...value, human_disposition: event.target.value as HumanDisposition }))}>
      <option value="unreviewed">Unreviewed</option><option value="accepted" disabled={report.status === "stale"}>Accepted</option>
      <option value="revised" disabled={report.status === "stale"}>Revised — explain your correction</option><option value="dismissed">Dismissed — explain why</option>
    </select></label>
    <label>Decision reason<textarea aria-label="Decision reason" maxLength={4000} value={decision.reason} disabled={disabled}
      onChange={event => setDecision(value => ({ ...value, reason: event.target.value }))} /></label>
    <p>A disposition records your decision. Editing course content still uses a separate reviewed change.</p>
    {objectives.length ? <fieldset disabled={disabled || report.status === "stale"}><legend>Explicit objective links</legend>
      {objectives.map(objective => <label key={objective.id}><input type="checkbox" aria-label={`Link objective ${objective.id}`}
        checked={decision.objective_ids.includes(objective.id)} onChange={event => setDecision(value => ({ ...value,
          objective_ids: event.target.checked ? [...value.objective_ids, objective.id] : value.objective_ids.filter(id => id !== objective.id) }))} />
        {objective.id}: {objective.text}</label>)}</fieldset> : <p>No objective links are available in this review's selected activity.</p>}
    <button type="button" disabled={disabled || !dirty || staleAcceptance || (requiresReason && !decision.reason.trim())}
      onClick={() => onSave(decision)}>Save disposition</button>
    {dirty && <button type="button" disabled={disabled} onClick={() => setDecision(decisionOf(finding, report.revision))}>Discard decision edits</button>}
  </article>;
}

export function ReviewPanel({ client, disabled, epoch = 0, openReportId, openEpoch = 0, objectivesFor, onDirtyChange, onChanged }: {
  client: ReviewClient; disabled: boolean; epoch?: number; openReportId?: string | null; openEpoch?: number;
  objectivesFor(selection: AssistantSelection): Objective[]; onDirtyChange(dirty: boolean): void; onChanged(): void;
}) {
  const [reports, setReports] = useState<ReviewSummary[]>([]);
  const [report, setReport] = useState<ReviewReport | null>(null);
  const [claimId, setClaimId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const active = useRef<AbortController | null>(null);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const selectedRef = useRef(report?.report_id); selectedRef.current = report?.report_id;
  const consumedOpen = useRef("");
  useBeforeUnload(dirty);
  // Loading a report changes no author input. Treating that read as a dirty
  // edit makes sibling panels repeatedly cancel and restart their own reads.
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => () => active.current?.abort(), []);

  const show = (value: ReviewReport) => { setReport(value); setClaimId(value.findings[0]?.claim_id ?? ""); setDirty(false); setConfirmDelete(false); };
  useEffect(() => {
    if (disabled || dirtyRef.current) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setPending(true); setNotice("");
    void client.getReviews(0, controller.signal).then(async page => {
      if (controller.signal.aborted) return;
      setReports(page.reports); setNextOffset(page.next_offset);
      const requested = openReportId ? `${openReportId}:${openEpoch}` : "";
      const id = requested && requested !== consumedOpen.current ? openReportId : selectedRef.current ?? page.reports[0]?.report_id;
      if (id) { const value = await client.getReview(id, controller.signal);
        if (!controller.signal.aborted) { show(value); consumedOpen.current = requested; } }
      else setReport(null);
    }).catch(error => { if (!controller.signal.aborted) setNotice(errorMessage(error)); })
      .finally(() => { if (active.current === controller) { active.current = null; setPending(false); } });
    return () => controller.abort();
  }, [client, disabled, epoch, openReportId, openEpoch, reload]);

  const perform = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || pending) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setNotice("");
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setNotice(errorMessage(error)); }
    finally { if (active.current === controller) { active.current = null; setPending(false); } }
  };
  const finding = report?.findings.find(item => item.claim_id === claimId);
  return <section aria-label="Saved review reports" className="review-panel">
    <h2>Saved review reports</h2>
    <p>Reports are private author artifacts saved separately from the conversation and student course. Source and target changes make dependent reviews stale.</p>
    <button type="button" disabled={disabled || pending || dirty} onClick={() => { setConfirmDelete(false); setReload(value => value + 1); }}>Reload reviews</button>
    {notice && <p role="status">{notice}</p>}
    <label>Saved report<select aria-label="Saved report" disabled={disabled || pending || dirty} value={report?.report_id ?? ""}
      onChange={event => { const id = event.target.value; if (id) void perform(async signal => {
        const value = await client.getReview(id, signal); if (!signal.aborted) show(value);
      }); }}>
      <option value="">Choose a report</option>{reports.map(item => <option key={item.report_id} value={item.report_id}>
        {item.role.replaceAll("_", " ")} · {item.target_path} · {item.status} · {item.saved_at}</option>)}</select></label>
    {nextOffset !== null && <button type="button" disabled={disabled || pending || dirty} onClick={() => void perform(async signal => {
      const page = await client.getReviews(nextOffset, signal);
      if (!signal.aborted) { setReports(items => [...items, ...page.reports.filter(item => !items.some(old => old.report_id === item.report_id))]); setNextOffset(page.next_offset); }
    })}>Load older reviews</button>}
    {report && <>
      <p>Report revision {report.revision} · {report.status} · {report.role.replaceAll("_", " ")}</p><p>{report.summary}</p>
      <p>Target: {report.target_path}{report.target_characters !== null ? ` · Characters 0–${report.target_characters}` : ""}
        {report.target_fully_visible ? " · Entire selected unit supplied" : " · Partial or unavailable target"}</p>
      {report.selection.cell_ids.length > 0 && <p>Selected cells: {report.selection.cell_ids.join(", ")}</p>}
      <ul>{report.stale_reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      <details><summary>Saved scope and omissions</summary>
        <p>Saved {report.saved_at} · Updated {report.updated_at}</p><p>Prompt: {report.prompt_version}</p>
        <p>Context SHA-256: {report.context_digest}</p><p>Target SHA-256: {report.target_sha256}</p><p>Manifest SHA-256: {report.manifest_sha256}</p>
        <ul>{report.omissions.map(note => <li key={note}>{note}</li>)}</ul>
      </details>
      <details><summary>Deterministic checks supplied to this review</summary><p>{report.compatibility.notice}</p>
        <p>Preliminary checks: {report.compatibility.preliminary_checks_passed ? "passed" : "issues found"} · Student {report.compatibility.student_profile}</p>
        <ul>{report.compatibility.issues.map((issue, index) => <li key={index}>{issue.severity} · {issue.code} · {issue.location || "/"}: {issue.message}</li>)}</ul>
        {report.compatibility.omitted_issues > 0 && <p>{report.compatibility.omitted_issues} issues omitted from the bounded context.</p>}
      </details>
      <details><summary>Sources permitted for this review ({report.sources.length})</summary>{report.sources.map(source => <article key={source.source_id}>
        <h3>{source.title}</h3><p>{source.source_id} · Revision {source.revision} · {source.origin}</p>
        <p>Final URL: {source.final_url ?? "Local reference"}</p><p>Imported: {source.imported_at} · Retrieved: {source.retrieved_at ?? "Not recorded"}</p>
        <p>Publication date: {source.publication_date ?? "Unknown"} · Extraction: {source.extraction} · Policy: {source.policy_decision}</p>
        <p>Saved source decision: {source.status} · Redistribution: {source.redistribution}</p>
        <p>Raw SHA-256: {source.raw_sha256}</p><p>Text SHA-256: {source.text_sha256 ?? "Unavailable"} · Extractor: {source.extractor_version ?? "Unavailable"}</p>
      </article>)}</details>
      {report.findings.length > 0 ? <label>Finding<select aria-label="Finding" value={claimId} disabled={disabled || pending || dirty}
        onChange={event => setClaimId(event.target.value)}>{report.findings.map(item => <option key={item.claim_id} value={item.claim_id}>
          {item.claim_id} · {item.judgment} · {item.human_disposition}</option>)}</select></label> : <p>This reply contains no individual findings. Its summary is not a completed course audit.</p>}
      {finding && <FindingEditor key={`${report.report_id}:${report.revision}:${claimId}`} finding={finding} report={report}
        objectives={objectivesFor(report.selection)} disabled={disabled || pending} onDirtyChange={setDirty}
        onSave={decision => void perform(async signal => {
          const value = await client.updateReviewFinding(report.report_id, finding.claim_id, decision, signal);
          if (!signal.aborted) { show(value); onChanged(); setNotice("Your disposition was saved."); }
        })} />}
      <div className="review-actions">
        <button type="button" disabled={disabled || pending || dirty} onClick={() => void perform(async signal => {
          const blob = await client.exportReview(report.report_id, report.revision, signal);
          if (signal.aborted) return;
          const url = URL.createObjectURL(blob), anchor = document.createElement("a");
          anchor.href = url; anchor.download = report.report_id + ".json"; anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 0); setNotice("Review JSON download requested. It remains separate from student material.");
        })}>Export review JSON</button>
        <button type="button" disabled={disabled || pending || dirty} onClick={() => setConfirmDelete(true)}>Delete report</button>
      </div>
      {confirmDelete && <div role="group" aria-label="Confirm report deletion"><p>Delete report revision {report.revision}? Export a copy first if you want to keep it.</p>
        <button type="button" disabled={disabled || pending || dirty} onClick={() => void perform(async signal => {
          await client.deleteReview(report.report_id, report.revision, signal);
          if (!signal.aborted) { setReports(items => items.filter(item => item.report_id !== report.report_id)); setReport(null); setConfirmDelete(false); onChanged(); setNotice("Review report deleted."); }
        })}>Confirm delete report</button><button type="button" disabled={pending} onClick={() => setConfirmDelete(false)}>Keep report</button></div>}
    </>}
    {!report && !pending && reports.length === 0 && <p>No saved reviews. Request a review in the Author assistant, then choose Save review report.</p>}
  </section>;
}
