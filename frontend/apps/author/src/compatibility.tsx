import { useEffect, useRef, useState } from "react";
import type { ValidationIssue } from "./validation";

interface Issue {
  code: string;
  location: string;
  message: string;
  severity: string;
}
export interface CompatibilityReport {
  passed: boolean;
  profile: { application_version: string; schema_version: number };
  structural: Issue[];
  assets: Issue[];
  links: Issue[];
  profile_issues: Issue[];
  not_performed: Issue[];
}

export function CompatibilityPanel({ manifest, check, disabled, epoch, onFocusIssues }: {
  manifest: unknown;
  check(manifest: unknown, version: "0.2.0" | "0.3.0", signal?: AbortSignal): Promise<CompatibilityReport>;
  disabled: boolean;
  epoch: string;
  onFocusIssues?(issues: readonly ValidationIssue[]): boolean | void;
}) {
  const [version, setVersion] = useState<"0.2.0" | "0.3.0">("0.2.0");
  const [report, setReport] = useState<CompatibilityReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = useRef<AbortController | null>(null);
  useEffect(() => {
    run.current?.abort();
    setPending(false);
    setReport(null);
    setError("");
    return () => run.current?.abort();
  }, [epoch, disabled, version]);
  const start = async () => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setPending(true);
    setReport(null);
    setError("");
    try {
      const result = await check(manifest, version, controller.signal);
      if (!controller.signal.aborted) setReport(result);
    } catch {
      if (!controller.signal.aborted) setError("Compatibility could not be checked. Your draft is retained; try again.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return <section aria-label="Student compatibility">
    <h2>Student compatibility</h2>
    <p>Draft structure, local assets and declared Student capabilities. Export and installed checks have separate evidence.</p>
    <label>Student target
      <select value={version} onChange={e => setVersion(e.currentTarget.value as "0.2.0" | "0.3.0")}>
        <option value="0.2.0">Released Student v0.2.0</option>
        <option value="0.3.0">Candidate Student v0.3.0</option>
      </select>
    </label>
    <button type="button" disabled={disabled || pending} onClick={() => void start()}>Check student compatibility</button>
    {pending ? <p role="status">Checking this draft…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {report ? <>
      <p role="status">{report.passed ? "Performed checks passed." : "Compatibility errors need attention."}</p>
      <p>Student {report.profile.application_version}, schema {report.profile.schema_version}. A passing check does not certify mastery or factual accuracy.</p>
      {([
        ["Structure", report.structural], ["Local assets", report.assets],
        ["Links", report.links], ["Student profile", report.profile_issues],
        ["Checks not performed", report.not_performed],
      ] as const).map(([title, issues]) => <section aria-label={title} key={title}>
        <h3>{title}</h3>
        {issues.length ? <ul>{issues.map((issue, index) => <li key={`${issue.code}:${index}`}>
          {issue.message} {issue.location && onFocusIssues ? <button type="button" onClick={() => onFocusIssues([
            { path: issue.location, code: issue.code, message: issue.message },
          ])}>Review {issue.location}</button> : null}
        </li>)}</ul> : <p>No issues reported in this section.</p>}
      </section>)}
    </> : null}
  </section>;
}
