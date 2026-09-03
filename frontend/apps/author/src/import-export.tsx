import { useEffect, useRef, useState, type ChangeEvent } from 'react';

const MAX_IMPORT_BYTES = 1024 * 1024;

function bytesFrom(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read import file.'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

/** Reads an import without silently repairing bytes, text, or schema version. */
export async function readImportFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('Import files must be 1 MiB or smaller.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await bytesFrom(file)); }
  catch { throw new Error('Import file is not valid UTF-8.'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Import file is not valid JSON.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Imported course must be an object.');
  if ((value as { schema_version?: unknown }).schema_version !== 1) throw new Error('Imported course must use schema version 1.');
  return value;
}

function download(formattedJson: string) {
  const blob = new Blob([formattedJson], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = 'courseweave.json';
  anchor.click();
  URL.revokeObjectURL(href);
}

export function ImportExport({ manifest: _manifest, formattedJson, validate, onImport, disabled = false, operationEpoch = '0' }: {
  manifest: unknown;
  formattedJson: string | null;
  validate(manifest: unknown, signal?: AbortSignal): Promise<{ manifest: unknown; formatted_json: string }>;
  onImport(manifest: unknown, formattedJson: string): void;
  disabled?: boolean;
  operationEpoch?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(operationEpoch);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current?.abort(); epoch.current = operationEpoch; }, [operationEpoch]);
  useEffect(() => () => controller.current?.abort(), []);
  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file === undefined) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const started = epoch.current;
    setBusy(true);
    try {
      const imported = await readImportFile(file);
      const result = await validate(imported, current.signal);
      if (current.signal.aborted || started !== epoch.current) return;
      onImport(result.manifest, result.formatted_json);
      setNotice('Imported into the local draft. Save explicitly to write it.');
    } catch (error) {
      if (!current.signal.aborted && started === epoch.current) setNotice(error instanceof Error ? error.message : 'Import failed.');
    } finally { if (!current.signal.aborted && started === epoch.current) setBusy(false); }
  };
  return <section aria-label="Import and export">
    <h2>Import and export</h2>
    <label>Import course file<input ref={input} disabled={disabled} type="file" accept="application/json,.json" onChange={change} /></label>
    <button type="button" disabled={formattedJson === null} onClick={() => { if (formattedJson !== null) download(formattedJson); }}>Export courseweave.json</button>
    {busy ? <p role="status">Checking import…</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
