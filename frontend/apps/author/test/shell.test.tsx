import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  retry: vi.fn(),
  useAuthorRuntime: vi.fn(),
}));

vi.mock('../src/api', () => ({ createAuthorClient: () => ({ getCourse: mocks.getCourse }) }));
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
});
