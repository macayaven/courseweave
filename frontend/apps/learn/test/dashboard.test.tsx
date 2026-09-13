import {course as makeCourse,phase as makePhase,state as makeState,digest} from './fixtures';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard, postOpenSurface } from '../src/dashboard';
const course = makeCourse({ title: 'Course', modules: [{ id: 'm02', title: 'Second', phases: [makePhase({ id: 'p02', title: 'Second phase', surfaces: [], teacher: { access: { mode: "disabled", requires: [] }, guidance: { style: { type: "builtin", id: "explanatory" }, hint_level: "none" }, sharing: { allow: [] }, proposals: { allow: [] } }, completion: { requirements: [] } })], description: "" }, { id: 'm01', title: 'First', phases: [makePhase({ id: 'p01', title: 'First phase', surfaces: [{ id: 'lesson', label:'Lesson', type: 'markdown' as const, purpose: 'primary' as const, path: 'lesson.md' }], teacher: { access: { mode: "disabled", requires: [] }, guidance: { style: { type: "builtin", id: "explanatory" }, hint_level: "none" }, sharing: { allow: [] }, proposals: { allow: [] } }, completion: { requirements: [] } })], description: "" }] });
afterEach(() => cleanup());
describe('Dashboard', () => {
    it('keeps server manifest module and phase order', () => {
        render(<Dashboard course={course} expectedParentOrigin="https://lab.test"/>);
        const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
        expect(headings).toEqual(['Second', 'Second phase', 'First', 'First phase']);
    });
    it('renders an editable-free learner empty course', () => {
        render(<Dashboard course={makeCourse({ title: 'Empty', modules: [] })} expectedParentOrigin="https://lab.test"/>);
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
