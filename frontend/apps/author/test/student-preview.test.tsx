import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StudentPreview } from '../src/preview';

afterEach(cleanup);
const record = { preview_id: 'preview-1', revision: 2, status: 'running', files: 'retained', home: '/local/preview/study',
  package_sha256: 'snapshot-hash', student_version: '0.2.0', provider_mode: 'off', observations: null, error: '' };
function client() { return {
  getExports: vi.fn().mockResolvedValue({ exports: [{ export_id: 'saved', course_id: 'practice', course_version: '1.0.0', kind: 'student_handoff', compatibility: { passed: true } }], student_runtimes: ['0.2.0','0.3.0'], next_offset: null }),
  getPreviews: vi.fn().mockResolvedValue({ previews: [], next_offset: null }),
  startPreview: vi.fn().mockResolvedValue(record),
  openPreview: vi.fn().mockResolvedValue({ opened: true }),
  stopPreview: vi.fn().mockResolvedValue({ ...record, revision: 3, status: 'stopped' }),
  savePreviewObservations: vi.fn().mockResolvedValue({ ...record, revision: 3, observations: { surfaces: ['notebook'], actions: ['notebook_run'], notes: 'Inspected output.', category: 'author_reported' } }),
  previewFiles: vi.fn().mockResolvedValue({ ...record, revision: 4, status: 'stopped', files: 'discarded' }),
}; }

it('prepares only an explicit saved snapshot with provider sharing unchecked, then separately opens Student', async () => {
  const api=client();render(<StudentPreview client={api as any} disabled={false} />);
  expect(api.startPreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Reload preview inputs'}));
  await screen.findByRole('option',{name:'practice · 1.0.0'});
  expect(screen.getByLabelText('Use Author’s configured model in this preview')).not.toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'Prepare Student preview'}));
  await screen.findByText('snapshot-hash');
  expect(api.startPreview).toHaveBeenCalledWith({export_id:'saved',student_version:'0.2.0',share_provider:false},expect.any(AbortSignal));
  expect(api.openPreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Open Student preview'}));
  await screen.findByText(/Student opened in your browser/);
  expect(api.openPreview).toHaveBeenCalledWith('preview-1',expect.any(AbortSignal));
});

it('keeps observations unsaved and retains notes on a revision conflict', async () => {
  const api=client();api.getPreviews.mockResolvedValue({previews:[record],next_offset:null});
  api.savePreviewObservations.mockRejectedValue(new Error('Preview record changed. Reload before saving.'));
  const dirty=vi.fn();render(<StudentPreview client={api as any} disabled={false} onDirtyChange={dirty} />);
  fireEvent.click(screen.getByRole('button',{name:'Reload preview inputs'}));
  fireEvent.click(await screen.findByRole('button',{name:'Record observations'}));
  fireEvent.click(screen.getByLabelText('Notebook'));
  fireEvent.click(screen.getByLabelText('Ran notebook'));
  fireEvent.change(screen.getByLabelText('Preview observations'),{target:{value:'Inspected output.'}});
  expect(api.savePreviewObservations).not.toHaveBeenCalled();expect(dirty).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole('button',{name:'Save preview observations'}));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Preview observations')).toHaveValue('Inspected output.');
  expect(api.savePreviewObservations).toHaveBeenCalledWith('preview-1',expect.objectContaining({revision:2,notes:'Inspected output.',surfaces:['notebook'],actions:['notebook_run']}),expect.any(AbortSignal));
});

it('stopping retains test files and discard requires a separate explicit confirmation', async () => {
  const api=client();api.getPreviews.mockResolvedValue({previews:[record],next_offset:null});
  render(<StudentPreview client={api as any} disabled={false} />);
  fireEvent.click(screen.getByRole('button',{name:'Reload preview inputs'}));
  fireEvent.click(await screen.findByRole('button',{name:'Stop Student preview'}));
  await screen.findByRole('button',{name:'Discard preview files'});
  expect(api.previewFiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Discard preview files'}));
  expect(api.previewFiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Confirm discard of this preview'}));
  await screen.findByText('Files: discarded.');
  expect(api.previewFiles).toHaveBeenCalledWith('preview-1','discard',3,expect.any(AbortSignal));
});
