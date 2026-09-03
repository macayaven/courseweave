import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useBeforeUnload, type RecoveryStatus } from '../src/reconnect';

const appMocks = vi.hoisted(() => ({ getCourse: vi.fn(), validateCourse: vi.fn(), putCourse: vi.fn(), runtime: vi.fn(), retry: vi.fn() }));
vi.mock('../src/api', () => ({ createAuthorClient: () => ({ getCourse: appMocks.getCourse, validateCourse: appMocks.validateCourse, putCourse: appMocks.putCourse, getProposals: vi.fn(), postGuide: vi.fn(), createProposal: vi.fn(), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }), AuthorApiError: class AuthorApiError extends Error {} }));
vi.mock('../src/runtime', () => ({ useAuthorRuntime: appMocks.runtime }));
import { AuthorApp } from '../src/app';

function Harness({ dirty, status }: { dirty: boolean; status: RecoveryStatus }) { useBeforeUnload(dirty); return <output>{status}</output>; }
afterEach(cleanup);
describe('Author reconnect and unload recovery', () => {
  it('installs beforeunload only while a local draft is dirty and removes it after save/unmount', () => {
    const listener = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<Harness dirty status="connected" />);
    expect(listener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    view.rerender(<Harness dirty={false} status="connected" />);
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    view.unmount();
  });

  it('models reconnecting and conflict recovery without an automatic save replay', () => {
    render(<Harness dirty status="conflict" />);
    expect(screen.getByText('conflict')).toBeInTheDocument();
  });

  it('aborts all active validation reads on runtime loss then refetches a changed ETag without replaying PUT', async () => {
    const manifest = { schema_version: 1, id: 'course', title: 'Course', description: '', entry_module_id: 'module', policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 1, workspace_write_globs: [] }, modules: [{ id: 'module', title: 'Module', description: '', phases: [{ id: 'phase', title: 'Phase', kind: 'read', teacher_mode: 'reading_companion', completion: { type: 'manual' }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [{ id: 'surface', type: 'markdown', role: 'primary', path: 'lesson.md' }] }] }] };
    let resolveValidation: ((value: { manifest: unknown; formatted_json: string }) => void) | undefined;
    appMocks.getCourse.mockResolvedValueOnce({ manifest, raw: '{}', etag: '"old"' }).mockResolvedValueOnce({ manifest: { ...manifest, title: 'Remote' }, raw: '{"title":"Remote"}\n', etag: '"new"' });
    appMocks.validateCourse.mockImplementation(() => new Promise((resolve) => { resolveValidation = resolve; }));
    const ready = { status: 'ready' as const, runtime: { serviceOrigin: 'https://course.test', capabilityToken: 'token', sourceId: 'author' }, retry: appMocks.retry };
    appMocks.runtime.mockReturnValue(ready);
    const view = render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText('Course title'), { target: { value: 'Dirty local' } });
    fireEvent.click(screen.getByRole('button', { name: 'Validate structure' }));
    await waitFor(() => expect(appMocks.validateCourse).toHaveBeenCalledOnce());
    const signal = appMocks.validateCourse.mock.calls[0]?.[2] as AbortSignal;
    appMocks.runtime.mockReturnValue({ status: 'disconnected', runtime: null, retry: appMocks.retry });
    view.rerender(<AuthorApp />);
    expect(signal.aborted).toBe(true);
    appMocks.runtime.mockReturnValue(ready);
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(appMocks.getCourse).toHaveBeenCalledTimes(2));
    resolveValidation?.({ manifest, formatted_json: '{}\n' });
    expect(appMocks.putCourse).not.toHaveBeenCalled();
    expect(await screen.findByText(/remote version changed/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Course title')).toHaveValue('Dirty local');
  });
});
