import {course as makeCourse,phase as makePhase,state as makeState,digest} from './fixtures';
import { describe, expect, it } from 'vitest';
import { parseReaderNavigation, selectReaderRoute } from '../src/reader-routes';
const html = { id: 'lesson', label:'Lesson', type: 'html' as const, purpose: 'primary' as const, path: 'lessons/a.html' };
const video = { id: 'video', label:'Video', type: 'video' as const, purpose: 'primary' as const, src: 'https://video.test/a.mp4' };
const course = makeCourse({ title: 'Course', modules: [{ id: 'm01', title: 'Module', phases: [makePhase({ id: 'p01', title: 'Phase', surfaces: [html, video], teacher: { access: { mode: "disabled", requires: [] }, guidance: { style: { type: "builtin", id: "explanatory" }, hint_level: "none" }, sharing: { allow: [] }, proposals: { allow: [] } }, completion: { requirements: [] } })], description: "" }] });
describe('reader parent contract', () => {
    it.each([
        ['https://lab.test/', 'https://lab.test/courseweave/reader/lessons/a.html'],
        ['https://lab.test/base/', 'https://lab.test/base/courseweave/reader/lessons/a.html']
    ])('accepts local HTML only beneath the exact Jupyter base %s', (jupyterBaseUrl, htmlSource) => {
        const message = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl, htmlSource };
        expect(parseReaderNavigation(message, 'https://lab.test')).toEqual(message);
        expect(selectReaderRoute(course, 'source-a', message, undefined, 'https://lab.test')).toEqual({ surface: html, htmlSource, parentOpened: true });
    });
    it('rejects paths outside the declared base and noncanonical files segments', () => {
        const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl: 'https://lab.test/base/', htmlSource: 'https://lab.test/base/courseweave/reader/lessons/a.html' };
        for (const htmlSource of [
            'https://courseweave.test/courseweave/reader/lessons/a.html',
            'https://attacker.test/base/courseweave/reader/lessons/a.html',
            'https://user:secret@lab.test/base/courseweave/reader/lessons/a.html',
            'https://lab.test/unrelated/courseweave/reader/lessons/a.html',
            'https://lab.test/base/not-files/a.html',
            'https://lab.test/base/files/nested/files/a.html',
            'https://lab.test/base/%66iles/lessons/a.html',
            'https://lab.test/base/files/../secret.html',
            'https://lab.test/base/files/a%2F..%2Fsecret.html',
            'https://lab.test/base/files/%252e%252e/secret.html',
            'https://lab.test/base/files/a.html?token=x',
            'https://lab.test/base/files/a.html#%2Fsecret'
        ])
            expect(parseReaderNavigation({ ...message, htmlSource }, 'https://lab.test')).toBeNull();
        for (const jupyterBaseUrl of [
            'https://attacker.test/base/',
            'https://user:secret@lab.test/base/',
            'https://lab.test/base',
            'https://lab.test/base//',
            'https://lab.test/%62ase/',
            'https://lab.test/base/?token=x',
            'https://lab.test/base/#fragment',
            'https://lab.test/base/files/'
        ])
            expect(parseReaderNavigation({ ...message, jupyterBaseUrl }, 'https://lab.test')).toBeNull();
    });
    it('requires an exact validated HTTPS video outcome matching the manifest URL', () => {
        const outcome = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'video', jupyterBaseUrl: 'https://lab.test/base/', htmlSource: 'https://video.test/a.mp4' };
        expect(selectReaderRoute(course, 'source-a', outcome, undefined, 'https://lab.test')).toEqual({ surface: video, htmlSource: null, parentOpened: true });
        expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'https://other.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
        expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'http://video.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
        expect(selectReaderRoute(course, 'source-a', { ...outcome, jupyterBaseUrl: 'https://attacker.test/' }, undefined, 'https://lab.test')).toBeNull();
    });
    it('rejects missing or extra keys, malformed fields, and null HTML success', () => {
        const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl: 'https://lab.test/', htmlSource: 'https://lab.test/courseweave/reader/lessons/a.html' };
        expect(parseReaderNavigation({ ...message, command: 'terminal:send-text' }, 'https://lab.test')).toBeNull();
        const { jupyterBaseUrl: _, ...missingBase } = message;
        expect(parseReaderNavigation(missingBase, 'https://lab.test')).toBeNull();
        expect(selectReaderRoute(course, 'source-a', { ...message, htmlSource: null } as never, undefined, 'https://lab.test')).toBeNull();
    });
});
