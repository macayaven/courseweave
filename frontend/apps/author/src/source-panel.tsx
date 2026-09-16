import { useEffect, useRef, useState } from "react";
import type { SourceRecord } from "./project-panel";
import { useBeforeUnload } from "./reconnect";

type Rule = { origin: string; path_prefix?: string };
type Policy = { mode: "allow_only" | "public_web"; allow: Rule[]; deny: Rule[] };
export type ResearchRequest = { network_enabled: true; policy: Policy; queries: string[]; urls: string[] };
export type ResearchReport = { report_id: string; started_at: string; finished_at: string; status: string; request: ResearchRequest;
  results: { url: string; title: string; snippet: string; query: string; retrieved_at: string; publication_date: string | null; policy_decision: string }[];
  fetches: { url: string; final_url: string | null; status: string; message: string; retrieved_at: string; media_type: string | null;
    redirects: string[]; source: { source_id: string; revision: number; raw_sha256: string; text_sha256: string | null; extractor_version: string | null } | null }[];
  source_ids: string[]; notices: string[] };
type ReportSummary = Pick<ResearchReport, "report_id" | "started_at" | "finished_at" | "status">;
export type ResearchStatus = { network_enabled: false; brave_configured: boolean; active: boolean; busy: boolean; notice: string };
export type SourceText = { source: SourceRecord; text: string; start: number; end: number; total_characters: number; notice: string };
export interface ResearchClient {
  getResearchStatus(signal?: AbortSignal): Promise<ResearchStatus>;
  getResearchReports(offset?: number, signal?: AbortSignal): Promise<{ reports: ReportSummary[]; next_offset: number | null }>;
  getResearchReport(id: string, signal?: AbortSignal): Promise<ResearchReport>;
  runResearch(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchReport>;
  cancelResearch(signal?: AbortSignal): Promise<unknown>;
  importReference(path: string, signal?: AbortSignal): Promise<SourceRecord>;
  getSourceText(id: string, revision: number, start?: number, signal?: AbortSignal): Promise<SourceText>;
}

const message = (error: unknown) => error instanceof Error ? error.message : "The research request could not finish. Reload saved reports before another explicit request.";
const lines = (value: string) => value.split("\n").map(line => line.trim()).filter(Boolean);
function rules(value: string): Rule[] {
  const entries = lines(value);
  if (entries.length > 32) throw new Error("Use at most 32 rules in each policy list.");
  return entries.map(entry => {
    const parsed = new URL(entry);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== "443")) {
      throw new Error("Policy rules require HTTPS origins, optional paths, and no query, fragment or credentials.");
    }
    return { origin: parsed.origin, path_prefix: parsed.pathname };
  });
}

export function SourcePanel({ client, disabled, onBusyChange, onChanged }: {
  client: ResearchClient; disabled: boolean; onBusyChange(busy: boolean): void; onChanged(): void;
}) {
  const [configuration, setConfiguration] = useState<ResearchStatus | null>(null);
  const [network, setNetwork] = useState(false);
  const [mode, setMode] = useState<Policy["mode"]>("allow_only");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [queries, setQueries] = useState("");
  const [urls, setUrls] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [busy, setBusy] = useState<"research" | "import" | null>(null);
  const [notice, setNotice] = useState("");
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const active = useRef<AbortController | null>(null);
  const reads = useRef<AbortController | null>(null);
  useBeforeUnload(busy !== null);
  useEffect(() => { onBusyChange(busy !== null); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    if (disabled) {
      active.current?.abort(); setBusy(null); setNetwork(false);
      return () => controller.abort();
    }
    void loadReports(controller, 0, true);
    return () => { controller.abort(); active.current?.abort(); };
  }, [client, disabled]);
  async function loadReports(controller: AbortController, offset = 0, openFirst = false) {
    const results = await Promise.allSettled([client.getResearchStatus(controller.signal), client.getResearchReports(offset, controller.signal)]);
    if (controller.signal.aborted) return;
    const [status, listing] = results;
    if (status.status === "fulfilled") setConfiguration(status.value);
    else setNotice(message(status.reason));
    if (listing.status === "fulfilled") {
      setReports(current => offset ? [...current, ...listing.value.reports] : listing.value.reports);
      setNextOffset(listing.value.next_offset);
      if (openFirst && listing.value.reports[0]) await openReport(listing.value.reports[0].report_id, controller);
    } else setNotice(message(listing.reason));
  }
  async function openReport(id: string, controller?: AbortController) {
    if (!id) return;
    if (!controller) { reads.current?.abort(); controller = new AbortController(); reads.current = controller; }
    try {
      const found = await client.getResearchReport(id, controller.signal);
      if (!controller.signal.aborted) { setReport(found); setSelected([]); }
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
  }
  let policy: Policy | null = null;
  let policyError = "";
  try {
    policy = { mode, allow: rules(allow), deny: rules(deny) };
    if (mode === "allow_only" && !policy.allow.length) { policy = null; policyError = "Add an allowed HTTPS origin/path before researching."; }
  } catch (error) { policyError = message(error); }
  const queryLines = lines(queries), urlLines = lines(urls);
  const queryValid = queryLines.length > 0 && queryLines.length <= 2 && queryLines.every(query => query.length <= 600 && query.split(/\s+/).length <= 75);
  const urlsValid = urlLines.length > 0 && urlLines.length <= 5 && urlLines.every(url => url.length <= 4096);
  const locked = disabled || busy !== null;
  async function run(kind: "discover" | "fetch") {
    if (locked || !network || !policy || (kind === "discover" ? !queryValid || !configuration?.brave_configured : !urlsValid)) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setBusy("research"); setNotice("Research is running. Each request is bounded; you can cancel subsequent work.");
    try {
      const found = await client.runResearch({ network_enabled: true, policy,
        queries: kind === "discover" ? queryLines : [], urls: kind === "fetch" ? urlLines : [] }, controller.signal);
      if (controller.signal.aborted) return;
      setReport(found); setSelected([]); setNetwork(false); setNotice(`Research run recorded: ${found.status}.`);
      if (found.source_ids.length) onChanged();
      await loadReports(controller);
    } catch (error) { if (!controller.signal.aborted) { setNotice(message(error)); setNetwork(false); } }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  async function cancel() {
    try { await client.cancelResearch(); setNotice("Cancellation requested. Waiting for the actual saved outcome…"); }
    catch (error) { setNotice(message(error)); }
  }
  async function importFile() {
    if (locked || !localPath.trim()) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setBusy("import"); setNotice("Importing the explicitly selected local reference…");
    try {
      const source = await client.importReference(localPath.trim(), controller.signal);
      if (!controller.signal.aborted) {
        setNotice(`Local reference imported: ${source.title}. Review its source decision below.`); onChanged();
      }
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
    finally { if (!controller.signal.aborted) setBusy(null); }
  }
  function reload(offset = 0) {
    const controller = new AbortController(); reads.current?.abort(); reads.current = controller;
    void loadReports(controller, offset, false);
  }
  return <section aria-label="Research and references" className="source-panel">
    <h2>Research and references</h2>
    <p>Sources stay private until you deliberately incorporate material into a lesson. Approval, assistant permission, and redistribution are separate decisions.</p>
    <fieldset disabled={locked}><legend>Local reference</legend>
      <label>Local reference file<input value={localPath} maxLength={4096} placeholder="/local/path/reference.md" onChange={e => setLocalPath(e.target.value)} /></label>
      <p>Import one nonsynced file, up to 8 MiB. Text/HTML/Markdown extraction supports up to 2 MiB. Other formats remain attachment metadata; you can supply an attributed text extract.</p>
      <button type="button" disabled={!localPath.trim()} onClick={() => void importFile()}>Import reference file</button>
    </fieldset>
    <p>Brave discovery: {configuration ? configuration.brave_configured ? "configured" : "unavailable — explicit URLs and local references still work" : "checking configuration…"}.</p>
    <p>{configuration?.notice}</p>
    <fieldset disabled={locked}><legend>Explicit public research</legend>
      <label><input type="checkbox" checked={network} onChange={e => setNetwork(e.target.checked)} />Enable network for this research run</label>
      <label>Research policy<select value={mode} onChange={e => setMode(e.target.value as Policy["mode"])}>
        <option value="allow_only">Allowed sources only</option><option value="public_web">Public web</option>
      </select></label>
      <label>Allowed origins and paths<textarea value={allow} maxLength={65536} placeholder="https://docs.python.org/3/library" onChange={e => setAllow(e.target.value)} /></label>
      <label>Denied origins and paths<textarea value={deny} maxLength={65536} onChange={e => setDeny(e.target.value)} /></label>
      <p>One HTTPS origin with an optional path prefix per line. Deny rules take precedence. The server checks every destination and redirect; only public HTTPS on port 443 is supported.</p>
      {policyError && <p>{policyError}</p>}
      {policy && <details><summary>Review exact source policy</summary><pre>{JSON.stringify(policy, null, 2)}</pre></details>}
      <label>Search queries<textarea value={queries} maxLength={2001} onChange={e => setQueries(e.target.value)} /></label>
      <p>Up to two queries, one per line; each allows 600 characters and 75 words. Discovery shows at most ten temporary results and does not fetch those pages. Results are not saved in reports or backups.</p>
      <button type="button" disabled={!network || !policy || !queryValid || !configuration?.brave_configured} onClick={() => void run("discover")}>Discover sources</button>
      <label>Public URLs<textarea value={urls} maxLength={20484} onChange={e => setUrls(e.target.value)} /></label>
      <p>Up to five explicitly chosen URLs, one per line. Fetching these URLs does not repeat the search queries.</p>
      <button type="button" disabled={!network || !policy || !urlsValid} onClick={() => void run("fetch")}>Fetch entered URLs</button>
    </fieldset>
    <p>Each run allows 60 seconds. Each fetch allows 10 seconds, 3 redirects, and 2 MiB of decompressed content. No automatic retry, refresh, login or browser cookies.</p>
    {(busy === "research" || configuration?.active) && <button type="button" disabled={disabled} onClick={() => void cancel()}>Cancel research</button>}
    <p role="status">{notice}</p>
    <details open={report !== null}><summary>Research results and saved reports</summary>
      <button type="button" disabled={locked} onClick={() => reload()}>Reload research status and reports</button>
      <label>Saved research run<select value={reports.some(r => r.report_id === report?.report_id) ? report?.report_id : ""} disabled={locked} onChange={e => void openReport(e.target.value)}>
        <option value="">Choose a saved report</option>{reports.map(r => <option key={r.report_id} value={r.report_id}>{r.finished_at} · {r.status}</option>)}
      </select></label>
      {nextOffset !== null && <button type="button" disabled={locked} onClick={() => reload(nextOffset)}>Load older research reports</button>}
      {report && <article aria-label="Research report">
        <h3>Research outcome: {report.status}</h3><p>Run started: {report.started_at}. Finished: {report.finished_at}.</p>
        <details><summary>Request and policy used for this report</summary><pre>{JSON.stringify(report.request, null, 2)}</pre></details>
        {report.notices.map((notice, index) => <p key={index}>{notice}</p>)}
        {report.results.length > 0 && <><h4>Discovery results</h4><p>These results are temporary and disappear when you reopen a report or leave this session. Select at most five URLs and review the current policy before fetching their source pages. Snippets are not substantive source evidence.</p>
          {report.results.map((result, index) => <div className="source-result" key={result.url + index}>
            <label><input aria-label={`Select ${result.title}`} type="checkbox" checked={selected.includes(result.url)}
              disabled={locked || result.policy_decision !== "allowed" || (!selected.includes(result.url) && selected.length >= 5)}
              onChange={e => setSelected(current => e.target.checked ? [...current, result.url] : current.filter(url => url !== result.url))} />{result.title}</label>
            <p>{result.url}</p><p>Policy at discovery: {result.policy_decision}. Discovery recorded: {result.retrieved_at}. Publication date: {result.publication_date ?? "unknown"}.</p>
            {result.policy_decision === "allowed" && <p>{result.snippet}</p>}
          </div>)}
          <button type="button" disabled={locked || !selected.length} onClick={() => setUrls(selected.join("\n"))}>Use selected URLs</button>
        </>}
        {report.fetches.length > 0 && <><h4>Fetch outcomes</h4>{report.fetches.map((fetch, index) => <div className="source-result" key={index}>
          <p>{fetch.url}</p><p>{fetch.status}: {fetch.message}</p>
          {fetch.final_url && <p>Final URL: {fetch.final_url}</p>}<p>Outcome recorded: {fetch.retrieved_at}. Media: {fetch.media_type ?? "unknown"}.</p>
          {fetch.source && <p>Saved source: {fetch.source.source_id}, revision {fetch.source.revision}. Review the current source decision below.</p>}
          {fetch.redirects.length > 0 && <details><summary>Redirect destinations</summary><ul>{fetch.redirects.map((url, i) => <li key={i}>{url}</li>)}</ul></details>}
        </div>)}</>}
        {!report.results.length && report.request.queries.length > 0 && <p>No discovery results are retained in this saved report. Run a new search explicitly to view results again.</p>}
        {!report.fetches.length && <p>No source pages were fetched in this run.</p>}
      </article>}
    </details>
  </section>;
}

export function SourceExcerpt({ client, source, disabled }: {
  client: Pick<ResearchClient, "getSourceText">; source: SourceRecord; disabled: boolean;
}) {
  const [excerpt, setExcerpt] = useState<SourceText | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [client, source.source_id, source.revision]);
  async function load(start = 0) {
    const controller = new AbortController(); active.current?.abort(); active.current = controller; setBusy(true);
    try {
      const found = await client.getSourceText(source.source_id, source.revision, start, controller.signal);
      if (!controller.signal.aborted) { setExcerpt(found); setNotice(""); }
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <div className="source-excerpt">
    <button type="button" disabled={disabled || busy} onClick={() => void load()}>Read extracted text for {source.title}</button>
    {notice && <p role="status">{notice}</p>}
    {excerpt && <><p>{excerpt.notice}</p><p>Characters {excerpt.start}–{excerpt.end} of {excerpt.total_characters}; end offset is exclusive.</p>
      <pre>{excerpt.text || "No model-readable text is available for this source."}</pre>
      <p>Extractor: {excerpt.source.extractor_version ?? "unavailable"}. Text SHA-256: {excerpt.source.text_sha256 ?? "unavailable"}.</p>
      <button type="button" disabled={disabled || busy || excerpt.start === 0} onClick={() => void load(Math.max(0, excerpt.start - 8000))}>Previous excerpt</button>
      <button type="button" disabled={disabled || busy || excerpt.end >= excerpt.total_characters} onClick={() => void load(excerpt.end)}>Next excerpt</button>
    </>}
  </div>;
}
