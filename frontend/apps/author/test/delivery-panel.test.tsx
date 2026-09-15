import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeliveryPanel } from '../src/delivery-panel';

afterEach(cleanup);
const report = { passed: true, profile: { application_version: '0.2.0', schema_version: 2 }, structural: [], assets: [], links: [], profile_issues: [],
  not_performed: [{ code: 'installed', location: '', severity: 'not_performed', message: 'Installed Student execution has not been checked.' }] };
function client() { return {
  buildStudentBundle: vi.fn().mockResolvedValue({ bundle_id: 'bundle', export_id: 'saved', destination: '/local/student', student_version: '0.2.0', package_sha256: 'exact-package-hash' }),
  inspectDelivery: vi.fn().mockResolvedValue({ course_id: 'practice', project_revision: 3, inventory_sha256: 'bytes', source_decisions_sha256: 'decisions',
    files: [{ path: 'courseweave.json', sha256: 'manifest', size: 100, selected: true, blocked_reasons: [] },
      { path: 'LICENSE', sha256: 'license', size: 10, selected: true, blocked_reasons: [] },
      { path: 'private.md', sha256: 'private', size: 20, selected: false, blocked_reasons: ['Source is not approved for distribution.'] }],
    required_paths: ['courseweave.json', 'LICENSE'], directories: [], omitted: [], selection_issues: [], compatibility: report, student_runtimes: ['0.2.0'] }),
  getExports: vi.fn().mockResolvedValue({ exports: [], next_offset: null }),
  exportCourse: vi.fn().mockResolvedValue({ export_id: 'saved', course_id: 'practice', course_version: '1.0.0', destination: '/local/practice.tar',
    package_sha256: 'exact-package-hash', kind: 'student_handoff', compatibility: report, created_at: '2026-09-15T10:00:00Z' }),
}; }

it('requires explicit inventory and file review, then reports the actual package and unperformed checks', async () => {
  const api = client(); render(<DeliveryPanel client={api} disabled={false} epoch={0} />);
  expect(api.inspectDelivery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect handoff files' }));
  await screen.findByLabelText('Include courseweave.json');
  expect(screen.getByLabelText('Include private.md')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Course version'), { target: { value: '1.0.0' } });
  fireEvent.change(screen.getByLabelText('New course archive (.tar)'), { target: { value: '/local/practice.tar' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export reviewed course' }));
  await screen.findByText('exact-package-hash');
  expect(api.exportCourse).toHaveBeenCalledWith(expect.objectContaining({ project_revision: 3, inventory_sha256: 'bytes',
    source_decisions_sha256: 'decisions', selected_paths: ['courseweave.json', 'LICENSE'], destination: '/local/practice.tar' }), expect.any(AbortSignal));
  expect(screen.getAllByText('Installed Student execution has not been checked.').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('New Student bundle folder'), { target: { value: '/local/student' } });
  fireEvent.click(screen.getByRole('button', { name: 'Build Student bundle for practice 1.0.0' }));
  await screen.findByText(/bundle created/);
  expect(api.buildStudentBundle).toHaveBeenCalledWith({ export_id: 'saved', student_version: '0.2.0', destination: '/local/student' }, expect.any(AbortSignal));
});

it('invalidates an old review after a source change and preserves the destination after failure', async () => {
  const api = client(); api.exportCourse.mockRejectedValue(new Error('Files changed; inspect again.'));
  const view = render(<DeliveryPanel client={api} disabled={false} epoch={0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect handoff files' }));
  await screen.findByLabelText('Include courseweave.json');
  fireEvent.change(screen.getByLabelText('Course version'), { target: { value: '1.0.0' } });
  fireEvent.change(screen.getByLabelText('New course archive (.tar)'), { target: { value: '/local/retained.tar' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export reviewed course' }));
  await screen.findByText('Files changed; inspect again.');
  expect(screen.getByLabelText('New course archive (.tar)')).toHaveValue('/local/retained.tar');
  view.rerender(<DeliveryPanel client={api} disabled={false} epoch={1} />);
  await waitFor(() => expect(screen.queryByLabelText('Include courseweave.json')).not.toBeInTheDocument());
  expect(api.exportCourse).toHaveBeenCalledTimes(1);
});

it('can build an earlier saved handoff after reopening without inspecting the current course', async () => {
  const api = client();
  api.getExports.mockResolvedValue({ exports: [{ export_id: 'earlier', course_id: 'practice', course_version: '1.0.0', destination: '/local/earlier.tar',
    package_sha256: 'earlier-hash', kind: 'student_handoff', compatibility: report, created_at: '2026-09-15T10:00:00Z' }], next_offset: null, student_runtimes: ['0.2.0'] });
  render(<DeliveryPanel client={api} disabled={false} epoch={0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved exports' }));
  await screen.findByText('earlier-hash');
  fireEvent.change(screen.getByLabelText('New Student bundle folder'), { target: { value: '/local/resumed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Build Student bundle for practice 1.0.0' }));
  await waitFor(() => expect(api.buildStudentBundle).toHaveBeenCalledWith({ export_id: 'earlier', student_version: '0.2.0', destination: '/local/resumed' }, expect.any(AbortSignal)));
  expect(api.inspectDelivery).not.toHaveBeenCalled();
});
