import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dashboard, postOpenSurface } from '../src/dashboard';

const course = { title: 'Course', modules: [{ id: 'm02', title: 'Second', phases: [{ id: 'p02', title: 'Second phase', kind: 'read' as const, completion: { type: 'manual' as const }, capabilities: { chat: false, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }, { id: 'm01', title: 'First', phases: [{ id: 'p01', title: 'First phase', kind: 'read' as const, completion: { type: 'manual' as const }, capabilities: { chat: false, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [{ id: 'lesson', type: 'markdown' as const, role: 'primary' as const, path: 'lesson.md' }] }] }] };

afterEach(() => cleanup());

describe('Dashboard', () => {
  it('keeps server manifest module and phase order', () => {
    render(<Dashboard course={course} expectedParentOrigin="https://lab.test" />);
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Second', 'Second phase', 'First', 'First phase']);
  });

  it('renders an editable-free learner empty course', () => {
    render(<Dashboard course={{ title: 'Empty', modules: [] }} expectedParentOrigin="https://lab.test" />);
    expect(screen.getByText('This course has no modules yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add|edit|delete/i })).not.toBeInTheDocument();
  });

  it('posts only the typed surface navigation message', () => {
    const parent = { postMessage: vi.fn() } as unknown as Window;
    postOpenSurface('https://lab.test', { moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson' }, parent);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'courseweave.open-surface.v1', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson' }, 'https://lab.test');
    expect(parent.postMessage).not.toHaveBeenCalledWith(expect.anything(), '*');
  });

  it('does not provide terminal command execution', () => {
    expect(postOpenSurface('https://lab.test', { moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson' })).toBeUndefined();
  });
});
