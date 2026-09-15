import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecoveryPanel } from '../src/recovery-panel';

afterEach(cleanup);
function client() { return {
  inspectBackup: vi.fn().mockResolvedValue({ inventory_sha256: 'reviewed-files', total_bytes: 200,
    files: [{path:'course/lesson.md',size:100}], notice: 'Private backup selection.' }),
  createBackup: vi.fn().mockResolvedValue({destination:'/local/backup.tar',archive_sha256:'saved-archive'}),
  inspectRestore: vi.fn().mockResolvedValue({archive_sha256:'reviewed-archive',original_project_id:'original',file_count:5,total_bytes:200,notice:'New project; fresh review required.'}),
  restoreBackup: vi.fn().mockResolvedValue({project_id:'recovered'}),
  getRecovery: vi.fn().mockResolvedValue({exports:[]}), discardExportStaging: vi.fn().mockResolvedValue({}),
}; }

it('backs up only a reviewed selection and invalidates changed artifact choices', async () => {
  const api = client();
  render(<RecoveryPanel client={api as any} projectId="project" disabled={false} onRestore={vi.fn()} />);
  fireEvent.click(screen.getByText('Backup and recovery'));
  fireEvent.change(screen.getByRole('textbox',{name:'New backup file'}),{target:{value:'/local/backup.tar'}});
  expect(screen.getByRole('button',{name:'Create reviewed backup'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect backup selection'}));
  await screen.findByText('Private backup selection.');
  expect(api.createBackup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox',{name:'Saved review reports'}));
  expect(screen.getByRole('button',{name:'Create reviewed backup'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect backup selection'}));
  await screen.findByText('Private backup selection.');
  fireEvent.click(screen.getByRole('button',{name:'Create reviewed backup'}));
  await screen.findByText('Backup saved: /local/backup.tar');
  expect(api.createBackup).toHaveBeenCalledWith({categories:['reviews'],destination:'/local/backup.tar',inventory_sha256:'reviewed-files'},expect.any(AbortSignal));
});

it('restores an inspected archive under a new ID and retains input after a conflict', async () => {
  const api=client(), onRestore=vi.fn();api.restoreBackup.mockRejectedValueOnce(new Error('Destination already exists.'));
  render(<RecoveryPanel client={api as any} projectId={null} disabled={false} onRestore={onRestore} />);
  fireEvent.click(screen.getByText('Backup and recovery'));
  fireEvent.change(screen.getByRole('textbox',{name:'Author backup archive'}),{target:{value:'/local/old.tar'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Restored project ID'}),{target:{value:'recovered'}});
  expect(screen.getByRole('button',{name:'Restore as new project'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Inspect restore archive'}));
  await screen.findByText('New project; fresh review required.');
  expect(api.restoreBackup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Restore as new project'}));
  await screen.findByText('Destination already exists.');
  expect(screen.getByRole('textbox',{name:'Author backup archive'})).toHaveValue('/local/old.tar');
  fireEvent.click(screen.getByRole('button',{name:'Restore as new project'}));
  await screen.findByText('Restored project: recovered');
  expect(onRestore).toHaveBeenCalledWith('recovered');
  expect(api.restoreBackup).toHaveBeenLastCalledWith({archive:'/local/old.tar',project_id:'recovered',archive_sha256:'reviewed-archive'},expect.any(AbortSignal));
});

it('removes only the selected interrupted export on an explicit action', async () => {
  const api=client();api.getRecovery.mockResolvedValue({exports:[{export_id:'export-one',status:'interrupted',staging_present:true,staging:'/local/staging',destination:'/local/export.tar'}]} as any);
  render(<RecoveryPanel client={api as any} projectId="project" disabled={false} onRestore={vi.fn()} />);
  fireEvent.click(screen.getByText('Backup and recovery'));
  fireEvent.click(screen.getByRole('button',{name:'Inspect interrupted exports'}));
  const discard=await screen.findByRole('button',{name:'Remove staging files for export-one'});
  expect(api.discardExportStaging).not.toHaveBeenCalled();
  fireEvent.click(discard);
  await screen.findByText('Staging files removed. The exported archive is unchanged.');
  expect(api.discardExportStaging).toHaveBeenCalledWith('export-one',expect.any(AbortSignal));
});

it('shows a stale backup error beside the backup action', async () => {
  const api=client();api.createBackup.mockRejectedValue(new Error('Backup selection changed; inspect again.'));
  render(<RecoveryPanel client={api as any} projectId="project" disabled={false} onRestore={vi.fn()} />);
  fireEvent.click(screen.getByText('Backup and recovery'));
  fireEvent.change(screen.getByRole('textbox',{name:'New backup file'}),{target:{value:'/local/backup.tar'}});
  fireEvent.click(screen.getByRole('button',{name:'Inspect backup selection'}));
  await screen.findByText('Private backup selection.');
  fireEvent.click(screen.getByRole('button',{name:'Create reviewed backup'}));
  await screen.findByText('Backup selection changed; inspect again.');
  expect(within(screen.getByRole('group',{name:'Back up project'})).getByText('Backup selection changed; inspect again.')).toBeVisible();
});
