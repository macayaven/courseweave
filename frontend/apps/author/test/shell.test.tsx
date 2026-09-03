import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  retry: vi.fn(),
  useAuthorRuntime: vi.fn(),
}));

vi.mock('../src/api', () => ({
  createAuthorClient: () => ({
    getCourse: mocks.getCourse,
    getProposals: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock('../src/runtime', () => ({ useAuthorRuntime: mocks.useAuthorRuntime }));

import { AuthorApp, AuthorShell } from '../src/app';

const readyRuntime = { serviceOrigin: 'https://courseweave.test', capabilityToken: 'token', sourceId: 'author' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Author shell', () => {
  it('renders connecting, loading, ready, and disconnected shell states with all regions intact', async () => {
    mocks.useAuthorRuntime.mockReturnValue({ status: 'connecting', runtime: null, retry: mocks.retry });
    const view = render(<AuthorApp />);
    expect(screen.getByText('Connecting to the trusted CourseWeave bridge.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
    for (const region of ['Outline', 'Inspector', 'Preview', 'Curriculum teacher']) expect(screen.getByRole('region', { name: region })).toBeInTheDocument();

    mocks.useAuthorRuntime.mockReturnValue({ status: 'ready', runtime: readyRuntime, retry: mocks.retry });
    mocks.getCourse.mockReturnValue(new Promise(() => {}));
    view.rerender(<AuthorApp />);
    expect(screen.getByText('Loading saved course…')).toBeInTheDocument();

    mocks.getCourse.mockResolvedValue({ manifest: {}, raw: '{}', etag: '"etag"' });
    view.unmount();
    render(<AuthorApp />);
    expect(await screen.findByText('Ready. Curriculum teacher provider unavailable.')).toBeInTheDocument();

    mocks.getCourse.mockRejectedValue(new Error('offline'));
    cleanup();
    render(<AuthorApp />);
    expect(await screen.findByText('Disconnected from CourseWeave. Your unsaved work is not stored here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('keeps all non-chat regions usable when no provider is configured', () => {
    render(<AuthorShell state="Ready. Curriculum teacher provider unavailable." provider="not_configured" />);
    for (const region of ['Outline', 'Inspector', 'Preview', 'Curriculum teacher']) expect(screen.getByRole('region', { name: region })).toBeInTheDocument();
    expect(screen.getAllByText(/provider unavailable/i)).not.toHaveLength(0);
  });

  it('hydrates the local draft editor from the read-only course response with an explicit Save action', async () => {
    mocks.useAuthorRuntime.mockReturnValue({ status: 'ready', runtime: readyRuntime, retry: mocks.retry });
    mocks.getCourse.mockResolvedValue({ manifest: {
      schema_version: 1, id: 'course', title: 'Course', description: '', entry_module_id: 'module',
      policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 100, workspace_write_globs: [] },
      modules: [{ id: 'module', title: 'Module', description: '', phases: [{ id: 'read', title: 'Read', kind: 'read', teacher_mode: 'reading_companion', completion: { type: 'manual' }, capabilities: { chat: true, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [{ id: 'page', type: 'markdown', role: 'primary', path: 'lesson.md' }] }] }],
    }, raw: '{}', etag: '"etag"' });
    render(<AuthorApp />);
    expect(await screen.findByRole('button', { name: 'Select module Module' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add module' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save course' })).toBeInTheDocument();
  });

  it('hydrates each canonical example as a clean local draft', async () => {
    mocks.useAuthorRuntime.mockReturnValue({ status: 'ready', runtime: readyRuntime, retry: mocks.retry });
    for (const path of ['../../../../examples/minimal-course/courseweave.json', '../../../../examples/cli-course/courseweave.json']) {
      const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      mocks.getCourse.mockResolvedValue({ manifest, raw: JSON.stringify(manifest), etag: '"etag"' });
      render(<AuthorApp />);
      expect(await screen.findByText('Draft matches the loaded course.')).toBeInTheDocument();
      cleanup();
    }
  });
});
