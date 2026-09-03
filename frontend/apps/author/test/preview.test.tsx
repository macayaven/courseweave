import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AuthorPhase } from '@courseweave/ui';
import { AuthorPreview } from '../src/preview';

const phase = (kind: AuthorPhase['kind']): AuthorPhase => ({
  id: kind, title: `A ${kind} phase`, kind, teacher_mode: 'observer', completion: { type: 'manual' },
  capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false },
  surfaces: [{ id: 'remote', type: 'video', role: 'reference', url: 'https://video.example/movie.mp4' }],
});

afterEach(cleanup);
describe('inert Author preview', () => {
  it('renders every phase kind as a no-action learner card and never fetches, navigates, or messages a parent', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const post = vi.spyOn(window.parent, 'postMessage');
    for (const kind of ['orient', 'read', 'watch', 'predict', 'experiment', 'lab', 'review', 'audit', 'ship'] as const) {
      const view = render(<AuthorPreview phase={phase(kind)} issues={[{ path: '/modules/0/phases/0/surfaces/0/path', code: 'missing_artifact', message: 'Missing local artifact.' }, { path: '', code: 'lfs_pointer', message: 'LFS pointer.' }]} />);
      expect(screen.getByRole('status')).toHaveTextContent('Preview only');
      expect(screen.getByText('https://video.example/movie.mp4')).toBeInTheDocument();
      view.unmount();
    }
    render(<AuthorPreview phase={null} issues={[{ path: '', code: 'invalid_terminal_cwd', message: 'Invalid terminal directory.' }]} />);
    expect(screen.getByText(/select a phase/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
