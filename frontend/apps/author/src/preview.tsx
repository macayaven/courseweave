import { LearnerPhasePreview, type AuthorPhase } from "@courseweave/ui";
import type { ValidationIssue } from "./validation";
import { useEffect, useRef, useState } from 'react';
import type { CourseExportReceipt, DeliveryClient } from './delivery-panel';

export interface PreviewObservations { surfaces: string[]; actions: string[]; notes: string; category?: 'author_reported'; }
export interface StudentPreviewRecord {
  preview_id: string; revision: number; status: 'preparing' | 'running' | 'stopped' | 'failed';
  files: 'retained' | 'kept' | 'discarded'; home: string; package_sha256: string;
  student_version: string; provider_mode: 'off' | 'configured'; error: string;
  observations: PreviewObservations | null;
}
export interface StudentPreviewClient {
  getExports: DeliveryClient['getExports'];
  getPreviews(offset?: number, signal?: AbortSignal): Promise<{previews: StudentPreviewRecord[]; next_offset: number | null}>;
  startPreview(body: {export_id: string; student_version: string; share_provider: boolean}, signal?: AbortSignal): Promise<StudentPreviewRecord>;
  openPreview(id: string, signal?: AbortSignal): Promise<{opened: boolean}>;
  stopPreview(id: string, signal?: AbortSignal): Promise<StudentPreviewRecord>;
  savePreviewObservations(id: string, body: PreviewObservations & {revision: number}, signal?: AbortSignal): Promise<StudentPreviewRecord>;
  previewFiles(id: string, action: 'keep' | 'discard', revision: number, signal?: AbortSignal): Promise<StudentPreviewRecord>;
}

const previewSurfaces = [['markdown','Markdown'],['html','HTML'],['source','Source file'],['notebook','Notebook'],['video','Video'],['terminal','Terminal'],['external','External link']];
const previewActions = [['navigation','Navigated course'],['keyboard','Used keyboard'],['notebook_run','Ran notebook'],['notebook_save','Saved notebook'],
  ['prediction','Submitted prediction'],['hint','Revealed hint'],['native_checks','Answered native checks'],['unaided','Entered and exited unaided work'],['restart','Restarted Student'],['export_reset','Exported and reset test records']];

export function StudentPreview({ client, disabled, onDirtyChange }: {
  client: StudentPreviewClient; disabled: boolean; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [exports, setExports] = useState<CourseExportReceipt[]>([]);
  const [exportId, setExportId] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('0.2.0');
  const [shareProvider, setShareProvider] = useState(false);
  const [records, setRecords] = useState<StudentPreviewRecord[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [exportOffset, setExportOffset] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<{id: string; revision: number} | null>(null);
  const [notes, setNotes] = useState<PreviewObservations>({surfaces:[], actions:[], notes:''});
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState<{id: string; revision: number} | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy = disabled || pending;
  const active = records.some(record => record.status === 'preparing' || record.status === 'running');
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => () => request.current?.abort(), [client]);
  useEffect(() => {
    if (!active || disabled || pending) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void client.getPreviews(0, controller.signal).then(result => {
        if (!controller.signal.aborted) {
          setRecords(current => [...result.previews, ...current.filter(r => !result.previews.some(next => next.preview_id === r.preview_id))]);
        }
      }).catch(() => { if (!controller.signal.aborted) setError('Preview status could not refresh. Reload preview inputs to reconnect.'); });
    }, 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [active, client, disabled, pending, records]);
  function replace(record: StudentPreviewRecord) {
    setRecords(current => [record, ...current.filter(item => item.preview_id !== record.preview_id)]);
  }
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort();const controller = new AbortController();request.current = controller;
    setPending(true);setError('');
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Preview action failed. Reload its record before retrying.'); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  function review(record: StudentPreviewRecord) {
    setSelected({id:record.preview_id,revision:record.revision});
    setNotes(record.observations ? {surfaces:[...record.observations.surfaces], actions:[...record.observations.actions], notes:record.observations.notes} : {surfaces:[],actions:[],notes:''});
    setDirty(false);
  }
  return <section aria-label="Student practice preview" className="student-preview">
    <h2>Student practice preview</h2>
    <p>Prepare a saved course snapshot in a separate study folder. Preparation installs its dependencies. Open Student to run notebooks and try the activities yourself.</p>
    <button type="button" disabled={busy} onClick={() => void perform(async signal => {
      const [inputs, saved] = await Promise.all([client.getExports(0,signal),client.getPreviews(0,signal)]);
      if (signal.aborted) return;
      const ready=inputs.exports.filter(r => r.kind === 'student_handoff' && r.compatibility.passed);
      setExports(ready);setExportId(ready[0]?.export_id ?? '');setExportOffset(inputs.next_offset);
      setVersions(inputs.student_runtimes ?? []);setVersion(inputs.student_runtimes?.[0] ?? '0.2.0');
      setRecords(saved.previews);setNextOffset(saved.next_offset);setNotice(inputs.student_runtime_notice ?? '');
    })}>Reload preview inputs</button>
    <label>Saved course snapshot<select disabled={busy || !exports.length} value={exportId} onChange={event => setExportId(event.target.value)}>
      {!exports.length && <option value="">Export a standard Student handoff first</option>}
      {exports.map(item => <option key={item.export_id} value={item.export_id}>{item.course_id} · {item.course_version}</option>)}
    </select></label>
    {exportOffset !== null && <button type="button" disabled={busy} onClick={() => void perform(async signal => {
      const inputs=await client.getExports(exportOffset,signal);if(signal.aborted)return;
      setExports(current=>[...current,...inputs.exports.filter(r=>r.kind==='student_handoff'&&r.compatibility.passed)]);setExportOffset(inputs.next_offset);
    })}>Older course snapshots</button>}
    <label>Preview Student version<select disabled={busy || !versions.length} value={version} onChange={event => setVersion(event.target.value)}>
      {(versions.length ? versions : ['0.2.0','0.3.0']).map(v=><option key={v} value={v}>Student v{v}</option>)}
    </select></label>
    <label className="preview-checkbox"><input type="checkbox" disabled={busy} checked={shareProvider} onChange={event=>setShareProvider(event.target.checked)} />Use Author’s configured model in this preview</label>
    <p>Provider use can incur charges on your account. Student consent and unaided restrictions still apply. Author source snapshots and conversation stay private.</p>
    <button type="button" disabled={busy || active || !exportId || !versions.length} onClick={()=>void perform(async signal=>{
      const record=await client.startPreview({export_id:exportId,student_version:version,share_provider:shareProvider},signal);
      if(!signal.aborted)replace(record);
    })}>Prepare Student preview</button>
    {pending && <p role="status">Updating preview…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <p>Stopping keeps the test notebooks and records. Starting a preview records readiness; it does not record notebook or check completion.</p>
    {records.map(record=><article key={record.preview_id} className="delivery-receipt">
      <h3>Student v{record.student_version} · {record.status}</h3>
      <p>Snapshot SHA256: <code>{record.package_sha256}</code></p>
      <p>Study folder: {record.home}</p><p>Assistant: {record.provider_mode}. Files: {record.files}.</p>
      {record.files==='discarded' && <p>Files: discarded.</p>}
      {record.status==='preparing' && <p>Preparing the installed Student runtime. First setup may take several minutes.</p>}
      {record.error && <p>{record.error}</p>}
      {record.status==='running' && <button type="button" disabled={busy} onClick={()=>void perform(async signal=>{
        await client.openPreview(record.preview_id,signal);if(!signal.aborted)setNotice('Student opened in your browser. Return to this Author tab to stop the preview and record your observations.');
      })}>Open Student preview</button>}
      {(record.status==='preparing'||record.status==='running'||record.status==='failed') && record.files!=='discarded' && <button type="button" disabled={busy} onClick={()=>void perform(async signal=>{
        const stopped=await client.stopPreview(record.preview_id,signal);if(!signal.aborted)replace(stopped);
      })}>Stop Student preview</button>}
      <button type="button" disabled={busy || dirty} onClick={()=>review(record)}>Record observations</button>
      {record.observations && <p>Your recorded observations: {record.observations.notes || 'Surfaces and actions selected.'}</p>}
      {(record.status==='stopped'||record.status==='failed') && record.files!=='discarded' && <>
        <button type="button" disabled={busy} onClick={()=>void perform(async signal=>{
          const kept=await client.previewFiles(record.preview_id,'keep',record.revision,signal);if(!signal.aborted)replace(kept);
        })}>Keep preview files</button>
        <button type="button" disabled={busy || dirty} onClick={()=>setDiscard({id:record.preview_id,revision:record.revision})}>Discard preview files</button>
      </>}
      {discard?.id===record.preview_id && <div>
        <p>Discard this preview’s course copy, test notebooks, records and installed environments in {record.home}. Its observation receipt will remain.</p>
        <button type="button" disabled={busy} onClick={()=>void perform(async signal=>{
          const result=await client.previewFiles(discard.id,'discard',discard.revision,signal);
          if(!signal.aborted){replace(result);setDiscard(null);}
        })}>Confirm discard of this preview</button>
        <button type="button" disabled={busy} onClick={()=>setDiscard(null)}>Keep files instead</button>
      </div>}
    </article>)}
    {nextOffset!==null && <button type="button" disabled={busy} onClick={()=>void perform(async signal=>{
      const result=await client.getPreviews(nextOffset,signal);if(!signal.aborted){setRecords(current=>[...current,...result.previews]);setNextOffset(result.next_offset);}
    })}>Older previews</button>}
    {selected && <fieldset disabled={busy}>
      <legend>Record what you inspected</legend>
      <p>These are your observations, separate from automatic readiness checks.</p>
      {([['surfaces',previewSurfaces],['actions',previewActions]] as const).map(([key,options])=><div key={key}>
        {options.map(([value,label])=><label key={value} className="preview-checkbox"><input type="checkbox" checked={notes[key].includes(value!)} onChange={event=>{
          setNotes(current=>({...current,[key]:event.target.checked?[...current[key],value!]:current[key].filter(v=>v!==value)}));setDirty(true);
        }} />{label}</label>)}
      </div>)}
      <label>Preview observations<textarea value={notes.notes} maxLength={8000} onChange={event=>{setNotes(current=>({...current,notes:event.target.value}));setDirty(true);}} /></label>
      <button type="button" onClick={()=>void perform(async signal=>{
        const result=await client.savePreviewObservations(selected.id,{...notes,revision:selected.revision},signal);
        if(!signal.aborted){replace(result);review(result);}
      })}>Save preview observations</button>
      <button type="button" onClick={()=>{
        const record=records.find(r=>r.preview_id===selected.id);if(record)setSelected({id:selected.id,revision:record.revision});
      }}>Use reloaded preview revision</button>
      <button type="button" onClick={()=>{setSelected(null);setDirty(false);}}>{dirty?'Discard unsaved observations':'Close observation form'}</button>
    </fieldset>}
  </section>;
}

export type PreviewValidation = {
  status: "not_requested" | "checking" | "passed" | "issues";
  issues: readonly ValidationIssue[];
};

function surfaceLocation(phase: AuthorPhase): string[] {
  return phase.surfaces.flatMap((surface) => {
    if (surface.type === "video") return [surface.src];
    if (surface.type === "html" && surface.fragment)
      return [`${surface.path}#${surface.fragment}`];
    if ("path" in surface && typeof surface.path === "string")
      return [surface.path];
    if ("url" in surface && typeof surface.url === "string")
      return [surface.url];
    return [];
  });
}

/** The preview has no event, network, navigation, or mutation capability. */
export function AuthorPreview({
  phase,
  issues,
  structural = { status: "not_requested", issues: [] },
  runnable,
}: {
  phase: AuthorPhase | null;
  issues?: readonly ValidationIssue[];
  structural?: PreviewValidation;
  runnable?: PreviewValidation;
}) {
  const runnableState: PreviewValidation = runnable ?? {
    status:
      issues === undefined || issues.length === 0 ? "not_requested" : "issues",
    issues: issues ?? [],
  };
  const label = (name: string, value: PreviewValidation) =>
    `${name}: ${value.status === "not_requested" ? "not requested" : value.status}.`;
  return (
    <section aria-label="Preview">
      <h2>Preview</h2>
      {phase === null ? (
        <p>Select a phase to see its inert learner card.</p>
      ) : (
        <>
          <LearnerPhasePreview phase={phase} />
          <h3>Inert surface metadata</h3>
          <ul>
            {surfaceLocation(phase).map((location, index) => (
              <li key={`${location}:${index}`}>{location}</li>
            ))}
          </ul>
        </>
      )}
      <h3>Validation state</h3>
      <p>{label("Structural validation", structural)}</p>
      <p>{label("Runnable diagnostics", runnableState)}</p>
      {runnableState.status === "issues" ? (
        <ul>
          {runnableState.issues.map((issue, index) => (
            <li key={`${issue.path}:${issue.code}:${index}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
