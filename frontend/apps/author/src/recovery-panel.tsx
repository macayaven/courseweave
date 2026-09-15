import { useEffect, useRef, useState } from 'react';
import type { Project } from './project-panel';

export type BackupCategory = 'changes' | 'reviews' | 'research';
export type BackupInventory = { inventory_sha256: string; total_bytes: number;
  files: {path: string; size: number}[]; notice: string };
export type RestoreInventory = { archive_sha256: string; original_project_id: string;
  file_count: number; total_bytes: number; notice: string };
export type RecoveryStatus = { exports: {export_id: string; destination: string; status: string;
  staging: string; staging_present: boolean}[] };
export type RecoveryClient = {
  inspectBackup(categories: BackupCategory[], signal?: AbortSignal): Promise<BackupInventory>;
  createBackup(body: {categories: BackupCategory[]; destination: string; inventory_sha256: string}, signal?: AbortSignal): Promise<{destination: string; archive_sha256: string}>;
  inspectRestore(archive: string, signal?: AbortSignal): Promise<RestoreInventory>;
  restoreBackup(body: {archive: string; project_id: string; archive_sha256: string}, signal?: AbortSignal): Promise<Project>;
  getRecovery(signal?: AbortSignal): Promise<RecoveryStatus>;
  discardExportStaging(exportId: string, signal?: AbortSignal): Promise<unknown>;
};

export function RecoveryPanel({client, projectId, disabled, onRestore, onBusyChange}: {
  client: RecoveryClient; projectId: string | null; disabled: boolean;
  onRestore(id: string): void; onBusyChange?(busy: boolean): void;
}) {
  const [categories, setCategories] = useState<BackupCategory[]>([]);
  const [destination, setDestination] = useState('');
  const [inventory, setInventory] = useState<BackupInventory | null>(null);
  const [saved, setSaved] = useState<{destination: string; archive_sha256: string} | null>(null);
  const [archive, setArchive] = useState('');
  const [restoredId, setRestoredId] = useState('');
  const [restore, setRestore] = useState<RestoreInventory | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [operation, setOperation] = useState<'backup' | 'restore' | 'recovery'>('backup');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); onBusyChange?.(false); }, [onBusyChange]);
  async function run(kind: typeof operation, action: (signal: AbortSignal) => Promise<() => void>) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setOperation(kind); setBusy(true); onBusyChange?.(true); setNotice('Checking saved files…');
    try {
      const done = await action(controller.signal);
      if (!controller.signal.aborted) { setNotice(''); done(); }
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'The operation could not finish. Inspect the saved files before trying again.');
    } finally {
      if (!controller.signal.aborted) { setBusy(false); onBusyChange?.(false); }
    }
  }
  return <section className="recovery-panel" aria-label="Project backup and recovery">
    <details><summary>Backup and recovery</summary>
      <p>Backups are private author files. A restore creates a new project with saved content and source decisions. Recovered drafts and reports need a fresh review.</p>
      {disabled && <p>Save or discard unsaved work and reconnect before using backup and restore.</p>}
      {projectId && <fieldset disabled={disabled || busy}>
        <legend>Back up {projectId}</legend>
        <p>The saved course, current source snapshots and applied changes for provenance are included. Select additional saved artifacts:</p>
        {([['changes','Pending and rejected drafts'],['reviews','Saved review reports'],['research','Saved research reports']] as const).map(([category,label]) =>
          <label key={category}><input type="checkbox" checked={categories.includes(category)} onChange={event => {
            setCategories(current => event.target.checked ? [...current, category] : current.filter(value => value !== category)); setInventory(null); setSaved(null);
          }} />{label}</label>)}
        <button type="button" onClick={() => void run('backup', async signal => {
          const result = await client.inspectBackup(categories, signal); return () => setInventory(result);
        })}>Inspect backup selection</button>
        {inventory && <div><p>{inventory.notice}</p><p>{inventory.files.length} files · {inventory.total_bytes.toLocaleString()} bytes</p>
          <details><summary>Included files{inventory.files.length > 100 ? ' (first 100)' : ''}</summary><ul>
            {inventory.files.slice(0,100).map(file => <li key={file.path}>{file.path} · {file.size.toLocaleString()} bytes</li>)}
          </ul></details></div>}
        <label>New backup file <input value={destination} placeholder="/local/path/author-backup.tar" onChange={event => setDestination(event.target.value)} /></label>
        <button type="button" disabled={!inventory || !destination.trim()} onClick={() => inventory && void run('backup', async signal => {
          const result = await client.createBackup({categories, destination, inventory_sha256: inventory.inventory_sha256}, signal);
          return () => { setSaved(result); setArchive(result.destination); setRestore(null); };
        })}>Create reviewed backup</button>
        {operation === 'backup' && <p role="status">{notice}</p>}
      </fieldset>}
      {saved && <div><p>Backup saved: {saved.destination}</p><p>SHA-256: <code>{saved.archive_sha256}</code></p></div>}
      <fieldset disabled={disabled || busy}>
        <legend>Restore a private Author backup</legend>
        <label>Author backup archive <input value={archive} placeholder="/local/path/author-backup.tar" onChange={event => { setArchive(event.target.value); setRestore(null); }} /></label>
        <button type="button" disabled={!archive.trim()} onClick={() => void run('restore', async signal => {
          const result = await client.inspectRestore(archive, signal); return () => setRestore(result);
        })}>Inspect restore archive</button>
        {restore && <div><p>{restore.notice}</p><p>Original project: {restore.original_project_id} · {restore.file_count} files</p>
          <p>SHA-256: <code>{restore.archive_sha256}</code></p></div>}
        <label>Restored project ID <input value={restoredId} maxLength={80} placeholder="my-course-restored" onChange={event => setRestoredId(event.target.value)} /></label>
        <button type="button" disabled={!restore || !restoredId.trim()} onClick={() => restore && void run('restore', async signal => {
          const result = await client.restoreBackup({archive, project_id: restoredId, archive_sha256: restore.archive_sha256}, signal);
          return () => { setNotice('Restored project: ' + result.project_id); onRestore(result.project_id); };
        })}>Restore as new project</button>
        {operation === 'restore' && <p role="status">{notice}</p>}
      </fieldset>
      {projectId && <fieldset disabled={disabled || busy}>
        <legend>Interrupted exports</legend>
        <button type="button" onClick={() => void run('recovery', async signal => {
          const result = await client.getRecovery(signal); return () => setRecovery(result);
        })}>Inspect interrupted exports</button>
        {recovery?.exports.length === 0 && <p>No interrupted export files need attention.</p>}
        {recovery?.exports.map(item => <div key={item.export_id}><p>{item.export_id}: {item.status} · {item.destination}</p>
          {item.staging_present && <><p>Staging directory: {item.staging}</p>
            <button type="button" aria-label={'Remove staging files for ' + item.export_id} onClick={() => void run('recovery', async signal => {
              await client.discardExportStaging(item.export_id, signal); const result = await client.getRecovery(signal);
              return () => { setRecovery(result); setNotice('Staging files removed. The exported archive is unchanged.'); };
            })}>Remove this export’s staging files</button></>}
        </div>)}
        {operation === 'recovery' && <p role="status">{notice}</p>}
      </fieldset>}
    </details>
  </section>;
}
