import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload } from "./reconnect";

export type Project = { project_id: string; course_root?: string; state_root?: string; revision?: number };
export type ProjectList = { enabled: boolean; projects?: Project[]; unavailable?: string[] };
export type Inventory = { digest: string; total_bytes: number;
  files: { path: string; size: number; sha256: string }[];
  omitted: { path: string; reason: string }[] };
export type ProjectRequest = { project_id: string; selected_paths: string[];
  source_root?: string; expected_inventory?: string };
export type SourceRecord = { source_id: string; revision: number; title: string; origin: string;
  imported_at: string; publication_date: string | null; raw_sha256: string; extraction: string;
  status: string; intended_use: string; redistribution: string; review_note: string; policy_decision: string };
export type SourceDecision = Pick<SourceRecord, "revision" | "title" | "publication_date" | "status" | "intended_use" | "redistribution" | "review_note">;
type ProjectClient = { inspectSource(path: string, signal?: AbortSignal): Promise<Inventory>;
  createProject(request: ProjectRequest, signal?: AbortSignal): Promise<Project> };
type SourceClient = { getSources(signal?: AbortSignal): Promise<{ sources: SourceRecord[] }>;
  updateSource(id: string, value: SourceDecision, signal?: AbortSignal): Promise<SourceRecord> };
const message = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";

export function ProjectPanel({ client, projects, unavailable, selected, disabled, onSelect }: {
  client: ProjectClient; projects: Project[]; unavailable: string[]; selected: string | null;
  disabled: boolean; onSelect(id: string): void;
}) {
  const [projectId, setProjectId] = useState("");
  const [mode, setMode] = useState("new");
  const [source, setSource] = useState("");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const invalidate = () => { active.current?.abort(); setInventory(null); setSelection([]); setBusy(false); setNotice(""); };
  useEffect(() => {
    if (disabled) invalidate();
    return () => active.current?.abort();
  }, [disabled]);
  async function inspect() {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setInventory(null); setSelection([]); setNotice("Inspecting selected source…");
    try {
      const result = await client.inspectSource(source, controller.signal);
      if (controller.signal.aborted) return;
      setInventory(result); setNotice("Select the files to copy. Original files stay in their source directory.");
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function create() {
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setBusy(true); setNotice("Creating private project…");
    try {
      const result = await client.createProject({ project_id: projectId, selected_paths: mode === "import" ? selection : [],
        ...(mode === "import" && inventory ? { source_root: source, expected_inventory: inventory.digest } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      setNotice("Project created."); onSelect(result.project_id);
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="Projects" className="project-panel">
    <h2>Projects</h2>
    {projects.length ? <label>Open project <select aria-label="Open project" value={selected ?? ""} disabled={disabled || busy}
      onChange={e => e.target.value && onSelect(e.target.value)}>
      <option value="">Choose a project</option>{projects.map(p => <option key={p.project_id}>{p.project_id}</option>)}
    </select></label> : <p>Create a private project to start authoring.</p>}
    {disabled && <p>Save or discard unsaved work and connect before switching projects.</p>}
    {unavailable.length > 0 && <p role="status">Incomplete or unavailable projects: {unavailable.join(", ")}. Restore or import a verified copy.</p>}
    <details open={selected === null}><summary>New or imported project</summary>
      <fieldset disabled={disabled || busy}>
        <legend>Project source</legend>
        <label><input type="radio" name="project-mode" checked={mode === "new"}
          onChange={() => { invalidate(); setMode("new"); }} />New empty project</label>
        <label><input type="radio" name="project-mode" checked={mode === "import"}
          onChange={() => { invalidate(); setMode("import"); }} />Import selected files</label>
        <label>Project ID <input value={projectId} maxLength={80} placeholder="my-course"
          onChange={e => setProjectId(e.target.value)} /></label>
        {mode === "import" && <>
          <label>Source directory <input value={source} placeholder="/local/path/to/material"
            onChange={e => { invalidate(); setSource(e.target.value); }} /></label>
          <p>Use a nonsynced local directory. Inventory supports up to 10,000 files and 1 GiB. Hidden files, private state, runtimes, symlinks and special files are omitted.</p>
          <button type="button" disabled={!source.trim()} onClick={() => void inspect()}>Inspect source</button>
          {inventory && <div>
            <p>{inventory.files.length} files, {inventory.total_bytes.toLocaleString()} bytes available. {selection.length} selected.</p>
            <button type="button" onClick={() => setSelection(inventory.files.map(f => f.path))}>Select all listed files</button>
            <button type="button" onClick={() => setSelection([])}>Clear selection</button>
            <ul className="inventory-files">{inventory.files.map(f => <li key={f.path}>
              <label><input type="checkbox" checked={selection.includes(f.path)} onChange={e => setSelection(current => e.target.checked ? [...current, f.path] : current.filter(p => p !== f.path))} />{f.path}</label>
              <small>{f.size.toLocaleString()} bytes{inventory.files.some(other => other.path !== f.path && other.sha256 === f.sha256) ? " · Duplicate content; separate source identity" : ""}</small>
            </li>)}</ul>
            {inventory.omitted.length > 0 && <details><summary>{inventory.omitted.length} omitted paths</summary>
              <ul>{inventory.omitted.map(o => <li key={o.path}>{o.path}: {o.reason}</li>)}</ul>
            </details>}
          </div>}
        </>}
        <button type="button" disabled={!projectId.trim() || (mode === "import" && !inventory)} onClick={() => void create()}>Create project</button>
      </fieldset>
    </details>
    <p role="status">{notice}</p>
  </section>;
}

function SourceCard({ source, duplicate, disabled, save, onDirtyChange }: { source: SourceRecord; duplicate: boolean;
  disabled: boolean; save(id: string, value: SourceDecision): Promise<void>; onDirtyChange(id: string, dirty: boolean): void }) {
  const [decision, setDecision] = useState<SourceDecision>({ revision: source.revision, title: source.title,
    publication_date: source.publication_date, status: source.status, intended_use: source.intended_use,
    redistribution: source.redistribution, review_note: source.review_note });
  const dirty = Object.entries(decision).some(([key, value]) => source[key as keyof SourceRecord] !== value);
  useEffect(() => { onDirtyChange(source.source_id, dirty); }, [dirty, source.source_id, onDirtyChange]);
  useEffect(() => () => onDirtyChange(source.source_id, false), [source.source_id, onDirtyChange]);
  return <article className="source-card">
    <h3>{source.title}</h3>
    <p>Origin: {source.origin}</p><p>Imported/retrieved: {source.imported_at}. Publication date: {source.publication_date ?? "unknown"}.</p>
    <p>Source: {source.source_id} · Revision {source.revision}</p><p className="source-hash">SHA-256: {source.raw_sha256}</p>
    <p>Extraction: {source.extraction}{source.extraction !== "text" ? ". Original bytes preserved. Model-readable extraction is unavailable." : ". UTF-8 text is available for explicit selection."}</p>
    <p>Origin policy: {source.policy_decision}</p>{duplicate && <p>Duplicate content; this source retains its own identity and decision.</p>}
    <fieldset disabled={disabled}><legend>Human source decision</legend>
      <label>Title for {source.title}<input value={decision.title} maxLength={500} onChange={e => setDecision({ ...decision, title: e.target.value })} /></label>
      <label>Publication date for {source.title}<input type="date" value={decision.publication_date ?? ""} onChange={e => setDecision({ ...decision, publication_date: e.target.value || null })} /></label>
      {([['status', 'Review status', ['candidate', 'approved', 'rejected', 'stale']],
        ['intended_use', 'Intended use', ['author_reference', 'student_material']],
        ['redistribution', 'Redistribution', ['undecided', 'include', 'exclude']]] as const).map(([key, label, options]) =>
          <label key={key}>{label} for {source.title}<select aria-label={`${label} for ${source.title}`} value={decision[key]} onChange={e => setDecision({ ...decision, [key]: e.target.value })}>{options.map(o => <option key={o}>{o}</option>)}</select></label>)}
      <label>Review note for {source.title}<textarea value={decision.review_note} maxLength={4000} onChange={e => setDecision({ ...decision, review_note: e.target.value })} /></label>
      <button type="button" onClick={() => void save(source.source_id, decision)}>Save decision for {source.title}</button>
    </fieldset>
  </article>;
}

export function SourceLibrary({ client, projectId, disabled, onDirtyChange }: { client: SourceClient; projectId: string; disabled: boolean; onDirtyChange?(dirty: boolean): void }) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [notice, setNotice] = useState("Loading source inventory…");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [dirtySources, setDirtySources] = useState<string[]>([]);
  const recordDirty = useCallback((id: string, dirty: boolean) => setDirtySources(current => {
    if (current.includes(id) === dirty) return current;
    return dirty ? [...current, id] : current.filter(value => value !== id);
  }), []);
  useBeforeUnload(dirtySources.length > 0);
  useEffect(() => { onDirtyChange?.(dirtySources.length > 0); }, [dirtySources, onDirtyChange]);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    if (disabled) { setBusy(false); return; }
    void client.getSources(controller.signal).then(result => {
      if (!controller.signal.aborted) { setSources(result.sources); setNotice(result.sources.length ? "Select sources deliberately for each assistant request." : "No imported sources yet."); }
    }).catch(error => { if (!controller.signal.aborted) setNotice(message(error)); });
    return () => active.current?.abort();
  }, [client, projectId, disabled, reload]);
  async function save(id: string, value: SourceDecision) {
    const controller = new AbortController(); active.current?.abort(); active.current = controller; setBusy(true);
    try {
      const updated = await client.updateSource(id, value, controller.signal);
      if (!controller.signal.aborted) { setSources(current => current.map(s => s.source_id === id ? updated : s)); setNotice("Source decision saved."); }
    } catch (error) { if (!controller.signal.aborted) setNotice(message(error)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section aria-label="Sources"><h2>Sources</h2>
    <p>Approval and redistribution are human decisions. Imported sources begin as candidate references with redistribution undecided.</p>
    <button type="button" disabled={disabled || busy} onClick={() => setReload(n => n + 1)}>{dirtySources.length ? "Discard source edits and reload" : "Reload source decisions"}</button>
    <p role="status">{notice}</p>
    {sources.map(source => <SourceCard key={`${source.source_id}:${source.revision}:${reload}`} source={source}
      duplicate={sources.some(other => other.source_id !== source.source_id && other.raw_sha256 === source.raw_sha256)} disabled={disabled || busy} save={save} onDirtyChange={recordDirty} />)}
  </section>;
}
