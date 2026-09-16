import { useEffect, useRef, useState } from "react";

type FindingLink = { report_id: string; claim_id: string; judgment: string; human_disposition: string;
  provenance: string; status: string; explanation: string; source_ids: string[] };
export interface CoverageReport {
  course_id: string; manifest_sha256: string; total_activities: number; next_offset: number | null;
  unassigned_reviews: string[]; notice: string;
  activities: { module_id: string; module_title: string; phase_id: string; title: string; progress: string; overview: string;
    completion_prompts: { id: string; prompt: string }[]; declared_sources: { id: string; label: string; url: string }[];
    objectives: { id: string; text: string; hints: { id: string; text: string }[]; checks: { id: string; prompt: string }[];
      reviewed_support: FindingLink[]; guidance: string[] }[];
    review_ids: string[]; review_gaps: FindingLink[]; guidance: string[] }[];
}
export interface CoverageClient { getCoverage(offset?: number, signal?: AbortSignal): Promise<CoverageReport> }

export function CoveragePanel({ client, disabled, epoch = 0, onOpenReview }: {
  client: CoverageClient; disabled: boolean; epoch?: number; onOpenReview(id: string): void;
}) {
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => { active.current?.abort(); setPending(false); setReport(null); setNotice(""); return () => active.current?.abort(); }, [client, disabled, epoch]);
  const inspect = async (offset = 0) => {
    if (pending || disabled) return;
    const controller = new AbortController(); active.current = controller; setPending(true); setNotice("");
    try { const value = await client.getCoverage(offset, controller.signal); if (!controller.signal.aborted) setReport(value); }
    catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Coverage is unavailable."); }
    finally { if (active.current === controller) { active.current = null; setPending(false); } }
  };
  const link = (finding: FindingLink) => <li key={`${finding.report_id}:${finding.claim_id}`}>
    <button type="button" disabled={disabled} onClick={() => onOpenReview(finding.report_id)}>{finding.claim_id} · {finding.human_disposition} · {finding.status}</button>
    <p>{finding.explanation}</p><p>Model: {finding.judgment} · Quotation: {finding.provenance} · Sources: {finding.source_ids.join(", ") || "None"}</p>
  </li>;
  return <section aria-label="Course coverage" className="coverage-panel">
    <h2>Course coverage</h2>
    <p>Inspect the saved course's objectives, authored prompts, hints, checks and reviewed source links. Missing guidance remains an authoring suggestion.</p>
    <button type="button" disabled={disabled || pending} onClick={() => void inspect()}>Inspect coverage</button>
    {notice && <p role="status">{notice}</p>}
    {report && <>
      <p>{report.notice}</p><p>{report.total_activities} activities in the saved course.</p>
      <div className="coverage-table" role="region" aria-label="Coverage table" tabIndex={0}><table>
        <thead><tr><th scope="col">Activity and objectives</th><th scope="col">Prompts and practice</th><th scope="col">Sources and review gaps</th></tr></thead>
        <tbody>{report.activities.map(activity => <tr key={`${activity.module_id}:${activity.phase_id}`}>
          <th scope="row"><p>{activity.module_title}</p><h3>{activity.title}</h3><p>{activity.progress}</p><p>{activity.overview}</p>
            {activity.objectives.map(objective => <div key={objective.id}><h4>{objective.id}</h4><p>{objective.text}</p></div>)}
            <ul>{activity.guidance.map(note => <li key={note}>{note}</li>)}</ul></th>
          <td><h4>Activity completion prompts</h4><ul>{activity.completion_prompts.map(prompt => <li key={prompt.id}>{prompt.prompt}</li>)}</ul>
            {activity.objectives.map(objective => <div key={objective.id}><h4>{objective.id}: hints and checks</h4>
              <ul>{objective.hints.map(hint => <li key={hint.id}>{hint.text}</li>)}{objective.checks.map(check => <li key={check.id}>{check.prompt}</li>)}</ul>
              <ul>{objective.guidance.map(note => <li key={note}>{note}</li>)}</ul></div>)}</td>
          <td><h4>Activity source declarations</h4><ul>{activity.declared_sources.map(source => <li key={source.id}>{source.label} · {source.url}</li>)}</ul>
            {activity.objectives.map(objective => <div key={objective.id}><h4>{objective.id}: author accepted evidence links</h4>
              {objective.reviewed_support.length > 0 ? <ul>{objective.reviewed_support.map(link)}</ul> : <p>No current mapped evidence.</p>}</div>)}
            <h4>Findings to consider</h4><ul>{activity.review_gaps.map(link)}</ul>
            {activity.review_ids.map(id => <button type="button" key={id} disabled={disabled} onClick={() => onOpenReview(id)}>Open activity review {id}</button>)}
          </td></tr>)}</tbody>
      </table></div>
      {report.next_offset !== null && <button type="button" disabled={disabled || pending} onClick={() => void inspect(report.next_offset!)}>Next activities</button>}
      {report.unassigned_reviews.length > 0 && <details><summary>Reviews without a current activity selection</summary>
        <p>These course, module or file reviews have no explicit current activity mapping.</p>
        {report.unassigned_reviews.map(id => <button type="button" key={id} disabled={disabled} onClick={() => onOpenReview(id)}>Open unassigned review {id}</button>)}
      </details>}
    </>}
  </section>;
}
