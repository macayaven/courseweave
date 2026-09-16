import { useEffect, useRef, useState } from 'react';
import type { CompatibilityReport } from './compatibility';

interface FileEntry {
  path: string; sha256: string; size: number; selected: boolean; blocked_reasons: string[];
}
export interface DeliveryInventory {
  course_id: string; project_revision: number; inventory_sha256: string; source_decisions_sha256: string;
  files: FileEntry[]; required_paths: string[]; directories: string[];
  omitted: { path: string; reason: string }[];
  selection_issues: { message: string }[];
  compatibility: CompatibilityReport;
  student_runtimes?: string[]; student_runtime_notice?: string;
}
export interface CourseExportRequest {
  project_revision: number; inventory_sha256: string; source_decisions_sha256: string;
  course_version: string; kind: 'draft' | 'student_handoff'; selected_paths: string[]; destination: string;
}
export interface CourseExportReceipt {
  export_id: string; course_id: string; course_version: string; destination: string; package_sha256: string;
  kind: 'draft' | 'student_handoff'; compatibility: CompatibilityReport; created_at: string;
}
export interface DeliveryClient {
  inspectDelivery(signal?: AbortSignal): Promise<DeliveryInventory>;
  exportCourse(body: CourseExportRequest, signal?: AbortSignal): Promise<CourseExportReceipt>;
  getExports(offset?: number, signal?: AbortSignal): Promise<{ exports: CourseExportReceipt[]; next_offset: number | null; student_runtimes?: string[]; student_runtime_notice?: string }>;
  buildStudentBundle(body: { export_id: string; student_version: string; destination: string }, signal?: AbortSignal): Promise<StudentBundleReceipt>;
}

export interface StudentBundleReceipt { bundle_id: string; export_id: string; destination: string; student_version: string; package_sha256: string; }

function Checks({ report }: { report: CompatibilityReport }) {
  const issues = [...report.structural, ...report.assets, ...report.links, ...report.profile_issues, ...report.not_performed];
  return <>
    <p>{report.passed ? 'Performed deterministic checks passed.' : 'Deterministic errors need attention.'}</p>
    <ul>{issues.slice(0, 20).map((issue, i) => <li key={i}>{issue.message}</li>)}</ul>
    {issues.length > 20 && <p>{issues.length - 20} further issues are recorded in the package receipt.</p>}
  </>;
}

export function DeliveryPanel({ client, disabled, epoch }: { client: DeliveryClient; disabled: boolean; epoch: number }) {
  const [plan, setPlan] = useState<DeliveryInventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [destination, setDestination] = useState('');
  const [kind, setKind] = useState<'draft' | 'student_handoff'>('student_handoff');
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<CourseExportReceipt[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [runtimes, setRuntimes] = useState<string[]>([]);
  const [studentVersion, setStudentVersion] = useState('0.2.0');
  const [bundleDestination, setBundleDestination] = useState('');
  const [bundles, setBundles] = useState<StudentBundleReceipt[]>([]);
  const [runtimeNotice, setRuntimeNotice] = useState('');
  const run = useRef<AbortController | null>(null);
  useEffect(() => {
    run.current?.abort(); setPlan(null); setPending(false); setError('');
    return () => run.current?.abort();
  }, [client, epoch, disabled]);
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    run.current?.abort(); const controller = new AbortController(); run.current = controller;
    setPending(true); setError('');
    try { await action(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'Export could not finish. Reload saved exports before retrying.');
        setPlan(null);
      }
    } finally { if (!controller.signal.aborted) setPending(false); }
  }
  const busy = disabled || pending;
  return <section aria-label="Course delivery">
    <h2>Course delivery</h2>
    <p>Review the saved files and distribution decisions before creating a new course archive. Notebook outputs are cleared in the export copy.</p>
    <button type="button" disabled={busy} onClick={() => void perform(async signal => {
      const inventory = await client.inspectDelivery(signal);
      if (signal.aborted) return;
      setPlan(inventory); setSelected(inventory.files.filter(file => file.selected && !file.blocked_reasons.length).map(file => file.path)); setPage(0);
      setRuntimes(inventory.student_runtimes ?? []);
      setStudentVersion(inventory.student_runtimes?.[0] ?? '0.2.0');
      setRuntimeNotice(inventory.student_runtime_notice ?? '');
    })}>Inspect handoff files</button>
    {plan && <>
      <p>Course {plan.course_id}, saved revision {plan.project_revision}. {selected.length} of {plan.files.length} files selected.</p>
      <Checks report={plan.compatibility} />
      {plan.selection_issues.length > 0 && <ul>{plan.selection_issues.map((issue, i) => <li key={i}>{issue.message}</li>)}</ul>}
      <div className="delivery-files" role="region" aria-label="Files to include" tabIndex={0}>
        {plan.files.slice(page * 50, (page + 1) * 50).map(file => <div key={file.path}>
          <label><input type="checkbox" checked={selected.includes(file.path)} disabled={busy || file.blocked_reasons.length > 0}
            onChange={event => setSelected(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} />
            Include {file.path}</label>
          <small>{file.size.toLocaleString()} bytes · SHA256 <code>{file.sha256}</code></small>
          {file.blocked_reasons.map(reason => <p key={reason}>{reason}</p>)}
        </div>)}
      </div>
      {plan.files.length > 50 && <nav aria-label="Export file pages">
        <button type="button" disabled={busy || page === 0} onClick={() => setPage(value => value - 1)}>Previous files</button>
        <span> Page {page + 1} of {Math.ceil(plan.files.length / 50)} </span>
        <button type="button" disabled={busy || (page + 1) * 50 >= plan.files.length} onClick={() => setPage(value => value + 1)}>Next files</button>
      </nav>}
      {plan.omitted.length > 0 && <details><summary>{plan.omitted.length} excluded paths</summary>
        <ul>{plan.omitted.slice(0, 50).map(item => <li key={item.path}>{item.path}: {item.reason}</li>)}</ul>
        {plan.omitted.length > 50 && <p>{plan.omitted.length - 50} further paths excluded.</p>}
      </details>}
    </>}
    <label>Course version<input value={version} maxLength={64} disabled={busy} onChange={event => setVersion(event.target.value)} placeholder="1.0.0" /></label>
    <label>Package kind<select value={kind} disabled={busy} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="student_handoff">Standard Student handoff</option><option value="draft">Draft with incomplete checks</option>
    </select></label>
    {kind === 'draft' && <p>DRAFT packages retain failed checks and cannot start Student practice.</p>}
    <label>New course archive (.tar)<input value={destination} maxLength={4096} disabled={busy} onChange={event => setDestination(event.target.value)} /></label>
    <p>Choose a new file in an existing nonsynced local folder outside the author project. Source approval is managed in the source library.</p>
    <button type="button" disabled={busy || !plan || !version.trim() || !destination.trim() || !selected.length}
      onClick={() => plan && void perform(async signal => {
        const result = await client.exportCourse({ project_revision: plan.project_revision, inventory_sha256: plan.inventory_sha256,
          source_decisions_sha256: plan.source_decisions_sha256, course_version: version.trim(), destination: destination.trim(), kind, selected_paths: selected }, signal);
        if (signal.aborted) return;
        setReceipts(current => [result, ...current.filter(item => item.export_id !== result.export_id)]); setPlan(null);
      })}>Export reviewed course</button>
    {pending && <p role="status">Preparing delivery…</p>}
    {error && <p role="alert">{error}</p>}
    <h3>Saved exports</h3>
    <p>A macOS Student bundle combines a saved standard export with one of this Author installation's verified Student runtimes.</p>
    {runtimeNotice && <p>{runtimeNotice}</p>}
    <label>Student bundle version<select value={studentVersion} disabled={busy || !runtimes.length} onChange={event => setStudentVersion(event.target.value)}>
      {(runtimes.length ? runtimes : ['0.2.0', '0.3.0']).map(version => <option key={version} value={version}>Student v{version}</option>)}
    </select></label>
    <label>New Student bundle folder<input value={bundleDestination} maxLength={4096} disabled={busy} onChange={event => setBundleDestination(event.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => void perform(async signal => {
      const result = await client.getExports(0, signal);
      if (!signal.aborted) {
        setReceipts(result.exports); setNextOffset(result.next_offset); setRuntimes(result.student_runtimes ?? []);
        setStudentVersion(result.student_runtimes?.[0] ?? '0.2.0'); setRuntimeNotice(result.student_runtime_notice ?? '');
      }
    })}>Reload saved exports</button>
    {receipts.map(receipt => <article key={receipt.export_id} className="delivery-receipt">
      <h4>{receipt.course_id} · {receipt.course_version} · {receipt.kind === 'draft' ? 'DRAFT' : 'Student handoff'}</h4>
      <p>{receipt.destination}</p><p>Package SHA256: <code>{receipt.package_sha256}</code></p>
      <p>Exported {receipt.created_at}. This records a saved snapshot; later author edits do not change it.</p>
      <Checks report={receipt.compatibility} />
      {receipt.kind === 'student_handoff' && <button type="button" disabled={busy || !runtimes.length || !bundleDestination.trim()}
        onClick={() => void perform(async signal => {
          const result = await client.buildStudentBundle({ export_id: receipt.export_id, student_version: studentVersion, destination: bundleDestination.trim() }, signal);
          if (!signal.aborted) setBundles(current => [...current, result]);
        })}>Build Student bundle for {receipt.course_id} {receipt.course_version}</button>}
    </article>)}
    {bundles.map(bundle => <p key={bundle.bundle_id} role="status" className="delivery-receipt">
      Student v{bundle.student_version} bundle created. Open {bundle.destination}/Start Course.command. Package SHA256: <code>{bundle.package_sha256}</code>
    </p>)}
    {nextOffset !== null && <button type="button" disabled={busy} onClick={() => void perform(async signal => {
      const result = await client.getExports(nextOffset, signal);
      if (!signal.aborted) { setReceipts(current => [...current, ...result.exports]); setNextOffset(result.next_offset); }
    })}>Older exports</button>}
  </section>;
}
