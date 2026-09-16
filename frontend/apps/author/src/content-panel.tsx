import { useEffect, useRef, useState } from "react";
import { Button } from "@courseweave/ui";
import { ContentChangeReview } from "./proposal-review";

export interface NotebookCell {
  id: string; cell_type: "markdown" | "code" | "raw"; source: string | string[];
  metadata: Record<string, unknown>; outputs?: unknown[]; execution_count?: number | null;
}
export interface Notebook { cells: NotebookCell[]; nbformat: number; nbformat_minor: number; metadata: Record<string, unknown> }
export interface ContentSnapshot {
  path: string; exists: boolean; sha256: string; size: number; kind: "markdown" | "notebook" | "asset";
  text?: string; notebook?: Notebook; project_revision: number; manifest_sha256: string;
}
export interface ContentChange {
  change_id: string; project_id: string; target_path: string; revision: number; context_digest: string;
  before_exists: boolean; before_sha256: string; after_sha256: string;
  status: "pending" | "rejected" | "stale" | "prepared" | "applied" | "conflict" | "failed";
  issues: { code: string; location: string; message: string; severity: string }[];
}
export interface ContentReview extends ContentChange { diff: string; text?: string; notebook?: Notebook }
export interface ContentEdit {
  path: string; before_sha256: string; before_exists: boolean; project_revision: number; manifest_sha256: string;
  action: { kind: "markdown_replace"; text: string }
    | { kind: "notebook_cells"; replace_sources: Record<string, string> }
    | { kind: "notebook_scaffold"; title: string }
    | { kind: "notebook_add_cell"; cell_type: "markdown" | "code"; source: string }
    | { kind: "import_replace"; source_path: string };
}
export interface ContentApply { reviewed_revision: number; context_digest: string; operation_id: string }
export interface ContentClient {
  getContentFiles(signal?: AbortSignal): Promise<{ files: { path: string; size: number; sha256: string }[]; omitted: { path: string; reason: string }[] }>;
  getContent(path: string, signal?: AbortSignal): Promise<ContentSnapshot>;
  getChanges(offset?: number, signal?: AbortSignal): Promise<{ changes: ContentChange[]; total: number }>;
  stageContent(body: ContentEdit, signal?: AbortSignal): Promise<ContentChange>;
  getChange(id: string, signal?: AbortSignal): Promise<ContentReview>;
  applyChange(id: string, body: ContentApply, signal?: AbortSignal): Promise<unknown>;
  rejectChange(id: string, revision: number, signal?: AbortSignal): Promise<ContentChange>;
}

const cellText = (cell: NotebookCell) => typeof cell.source === "string" ? cell.source : cell.source.join("");

export function ContentPanel({ client, disabled, onDirtyChange, onChanged, openChangeId }: {
  client: ContentClient; disabled: boolean; onDirtyChange(dirty: boolean): void; onChanged(): void | Promise<void>;
  openChangeId?: string | null;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [snapshot, setSnapshot] = useState<ContentSnapshot | null>(null);
  const [text, setText] = useState("");
  const [cells, setCells] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [newCell, setNewCell] = useState("");
  const [cellType, setCellType] = useState<"markdown" | "code">("markdown");
  const [title, setTitle] = useState("New notebook");
  const [importPath, setImportPath] = useState("");
  const [changes, setChanges] = useState<ContentChange[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [review, setReview] = useState<ContentReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const controllers = useRef(new Set<AbortController>());
  const operations = useRef(new Map<string, ContentApply>());
  const openedChange = useRef<string | null>(null);
  const blocked = disabled || busy;
  const dirty = !!snapshot && (text !== (snapshot.text ?? "") || newCell !== "" || importPath !== ""
    || (!snapshot.exists && snapshot.kind === "notebook" && title !== "New notebook")
    || (snapshot.notebook?.cells.some((cell) => (cells[cell.id] ?? cellText(cell)) !== cellText(cell)) ?? false));
  useEffect(() => { onDirtyChange(dirty || busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  useEffect(() => () => controllers.current.forEach((controller) => controller.abort()), []);

  const resetEditor = (next: ContentSnapshot) => {
    setSnapshot(next); setPath(next.path); setText(next.text ?? "");
    setCells(Object.fromEntries((next.notebook?.cells ?? []).map((cell) => [cell.id, cellText(cell)])));
    setSelected((previous) => snapshot?.path === next.path
      ? previous.filter((id) => next.notebook?.cells.some((cell) => cell.id === id)) : []);
    setNewCell(""); setImportPath(""); setTitle("New notebook");
  };
  const refresh = async (signal: AbortSignal, offset = page) => {
    const [inventory, saved] = await Promise.all([client.getContentFiles(signal), client.getChanges(offset, signal)]);
    if (!signal.aborted) {
      setFiles(inventory.files.map((file) => file.path).filter((file) => file !== "courseweave.json"));
      setChanges(saved.changes); setTotal(saved.total); setPage(offset);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    if (!disabled) {
      setBusy(true);
      void refresh(controller.signal, 0).catch(() => {
        if (!controller.signal.aborted) setNotice("Saved files are unavailable. Reload when the connection is ready.");
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); controllers.current.delete(controller); });
    }
    return () => controller.abort();
  }, [client, disabled]);

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (blocked) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    setBusy(true); setNotice("");
    try { await action(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Action unavailable. Your local edit is retained.");
    } finally {
      controllers.current.delete(controller);
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const openFile = (target: string) => void run(async (signal) => {
    const next = await client.getContent(target, signal);
    if (!signal.aborted) resetEditor(next);
  });
  useEffect(() => {
    if (!openChangeId || openedChange.current === openChangeId || blocked || dirty) return;
    openedChange.current = openChangeId;
    void run(async signal => {
      const next = await client.getChange(openChangeId, signal);
      if (!signal.aborted) { setReview(next); await refresh(signal); }
    });
  }, [openChangeId, blocked, dirty, client]);
  const stage = (action: ContentEdit["action"]) => void run(async (signal) => {
    if (!snapshot) return;
    const change = await client.stageContent({ path: snapshot.path, before_sha256: snapshot.sha256,
      before_exists: snapshot.exists, project_revision: snapshot.project_revision,
      manifest_sha256: snapshot.manifest_sha256, action }, signal);
    const next = await client.getChange(change.change_id, signal);
    if (signal.aborted) return;
    // Clear only the draft that was deliberately staged. Other local edits
    // (including a deselected cell or a new-cell draft) remain in the tab.
    if (action.kind === "markdown_replace") setText(snapshot.text ?? "");
    else if (action.kind === "notebook_cells") setCells((current) => ({ ...current,
      ...Object.fromEntries((snapshot.notebook?.cells ?? []).filter((cell) => cell.id in action.replace_sources)
        .map((cell) => [cell.id, cellText(cell)])) }));
    else if (action.kind === "notebook_add_cell") setNewCell("");
    else if (action.kind === "notebook_scaffold") setTitle("New notebook");
    else setImportPath("");
    setReview(next);
    setNotice("Pending change saved. Review the diff before applying this file.");
    await refresh(signal);
    if (action.kind === "import_replace") await onChanged();
  });
  const editReview = () => void run(async (signal) => {
    if (!review) return;
    const current = await client.getContent(review.target_path, signal);
    if (current.sha256 !== review.before_sha256 || current.exists !== review.before_exists)
      throw new Error("The saved target changed. Reload it and create a new edit from the current file.");
    if (signal.aborted) return;
    resetEditor(current);
    if (review.text !== undefined) setText(review.text);
    if (review.notebook) {
      const edited = review.notebook;
      setCells(Object.fromEntries(edited.cells.map((cell) => [cell.id, cellText(cell)])));
      setSelected(edited.cells.filter((cell) => current.notebook?.cells.some(
        (before) => before.id === cell.id && cellText(before) !== cellText(cell))).map((cell) => cell.id));
    }
    setNotice("Editing a copy of this candidate. Review the new edit to save a new pending revision.");
  });
  const apply = async () => { await run(async (signal) => {
    if (!review) return;
    const key = review.change_id + ":" + review.revision;
    let operation = operations.current.get(key);
    if (!operation) {
      operation = { operation_id: crypto.randomUUID(), reviewed_revision: review.revision, context_digest: review.context_digest };
      operations.current.set(key, operation);
    }
    try {
      await client.applyChange(review.change_id, operation, signal);
    } catch (error) {
      if (!signal.aborted && typeof error === "object" && error !== null && (error as { status?: number }).status === 409) {
        try {
          const current = await client.getChange(review.change_id, signal);
          if (!signal.aborted) setReview(current);
        } catch { /* Retain the exact candidate and operation ID for explicit recovery. */ }
      }
      throw error;
    }
    if (signal.aborted) return;
    setReview({ ...review, status: "applied" });
    setNotice("Reviewed file applied. Reloading the saved project…");
    if (snapshot?.path === review.target_path) resetEditor(await client.getContent(snapshot.path, signal));
    await refresh(signal);
    await onChanged();
    if (!signal.aborted) setNotice("Reviewed file applied and saved project reloaded.");
  }); };
  const reject = async () => { await run(async (signal) => {
    if (!review) return;
    const next = await client.rejectChange(review.change_id, review.revision, signal);
    if (signal.aborted) return;
    setReview({ ...review, status: next.status });
    setNotice("Change rejected. The course file was not written.");
    await refresh(signal);
  }); };
  const editableCells = selected.filter((id) => cells[id] !== undefined);

  return <section aria-label="Lesson files" className="content-panel">
    <h2>Lesson files</h2>
    <p>Edit the private author copy, then review one file at a time. Notebook execution belongs in Student preview.</p>
    {disabled && <p role="status">Save or discard other local edits and reconnect before changing lesson files.</p>}
    <label>Saved lesson file<select aria-label="Saved lesson file" disabled={blocked || dirty} value={files.includes(path) ? path : ""}
      onChange={(event) => setPath(event.target.value)}><option value="">Choose a file</option>
      {files.map((file) => <option key={file} value={file}>{file}</option>)}</select></label>
    <label>File path<input value={path} disabled={blocked || dirty} placeholder="lessons/introduction.md"
      onChange={(event) => setPath(event.target.value)} /></label>
    <Button disabled={blocked || dirty || !path.trim()} onClick={() => openFile(path)}>Open file</Button>
    <Button disabled={blocked} onClick={() => void run((signal) => refresh(signal))}>Reload saved files</Button>
    {snapshot && <article aria-label="Selected file">
      <h3>{snapshot.path}</h3><p>{snapshot.exists ? "Saved file" : "New file"} · {snapshot.size} bytes · Project revision {snapshot.project_revision}</p>
      <Button disabled={blocked} onClick={() => openFile(snapshot.path)}>{dirty ? "Discard local edits and reload" : "Reload saved file"}</Button>
      {snapshot.kind === "markdown" && <>
        <label>Markdown source<textarea value={text} rows={12} disabled={blocked} onChange={(event) => setText(event.target.value)} /></label>
        {text.length > 64000 && <p role="status">This editor supports 64,000 characters per Markdown edit. Use an imported replacement for a larger file.</p>}
        <Button disabled={blocked || text.length > 64000 || (snapshot.exists && text === snapshot.text)}
          onClick={() => stage({ kind: "markdown_replace", text })}>Review file edit</Button>
      </>}
      {snapshot.kind === "notebook" && !snapshot.exists && <>
        <label>Notebook title<input value={title} disabled={blocked} onChange={(event) => setTitle(event.target.value)} /></label>
        <p>The scaffold contains one Markdown cell and one code cell, each with a new stable ID.</p>
        <Button disabled={blocked || !title.trim()} onClick={() => stage({ kind: "notebook_scaffold", title })}>Review notebook scaffold</Button>
      </>}
      {snapshot.notebook && <>
        <p>Choose named cells to edit. Review includes clearing source outputs and execution counts; student notebooks are preserved.</p>
        {snapshot.notebook.cells.map((cell) => <article key={cell.id} className="notebook-cell">
          <label><input type="checkbox" aria-label={"Select cell " + cell.id} checked={selected.includes(cell.id)} disabled={blocked}
            onChange={(event) => setSelected((current) => event.target.checked ? [...current, cell.id] : current.filter((id) => id !== cell.id))} />
            Cell {cell.id} · {cell.cell_type}</label>
          <p>Metadata: <code>{JSON.stringify(cell.metadata)}</code>{cell.cell_type === "code" ? " · Saved execution count: " + (cell.execution_count ?? "none") : ""}</p>
          {selected.includes(cell.id) ? <label>Source for cell {cell.id}<textarea value={cells[cell.id] ?? cellText(cell)}
            disabled={blocked} rows={5} onChange={(event) => setCells((current) => ({ ...current, [cell.id]: event.target.value }))} /></label>
            : <pre>{cellText(cell)}</pre>}
        </article>)}
        <Button disabled={blocked || !editableCells.length}
          onClick={() => stage({ kind: "notebook_cells", replace_sources: Object.fromEntries(editableCells.map((id) => [id, cells[id]!])) })}>Review cell edits</Button>
        <h4>Add a new cell</h4>
        <label>New cell type<select aria-label="New cell type" disabled={blocked} value={cellType}
          onChange={(event) => setCellType(event.target.value as "markdown" | "code")}><option value="markdown">Markdown</option><option value="code">Code</option></select></label>
        <label>New cell source<textarea value={newCell} disabled={blocked} onChange={(event) => setNewCell(event.target.value)} /></label>
        <Button disabled={blocked} onClick={() => stage({ kind: "notebook_add_cell", cell_type: cellType, source: newCell })}>Review new cell</Button>
      </>}
      <details><summary>Import a replacement file</summary>
        <p>Select an ordinary local file. Author retains its origin and snapshot as a candidate source with undecided redistribution.</p>
        <label>Replacement file location<input value={importPath} disabled={blocked} onChange={(event) => setImportPath(event.target.value)} /></label>
        <Button disabled={blocked || !importPath.trim()} onClick={() => stage({ kind: "import_replace", source_path: importPath })}>Review imported replacement</Button>
      </details>
    </article>}
    <h3>Saved changes</h3>
    <p>{total} saved changes. Pending changes survive restart; applying one can make others stale.</p>
    <ul>{changes.map((change) => <li key={change.change_id}>
      <Button disabled={blocked || dirty} onClick={() => void run(async (signal) => {
        const next = await client.getChange(change.change_id, signal); if (!signal.aborted) setReview(next);
      })}>Review {change.target_path}</Button> {change.status} · Change {change.change_id.slice(7, 15)}
    </li>)}</ul>
    {page > 0 && <Button disabled={blocked} onClick={() => void run((signal) => refresh(signal, Math.max(0, page - 20)))}>Previous changes</Button>}
    {page + changes.length < total && <Button disabled={blocked} onClick={() => void run((signal) => refresh(signal, page + 20))}>More changes</Button>}
    {review && <ContentChangeReview key={review.change_id + ":" + review.revision} review={review} disabled={blocked || dirty}
      onApply={apply} onReject={reject} onEdit={editReview} />}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
