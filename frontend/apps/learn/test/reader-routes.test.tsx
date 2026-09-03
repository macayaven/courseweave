import { describe, expect, it } from 'vitest';

import { parseReaderNavigation, selectReaderRoute } from '../src/reader-routes';

const html = { id: 'lesson', type: 'html' as const, role: 'primary' as const, path: 'lessons/a.html' };
const video = { id: 'video', type: 'video' as const, role: 'primary' as const, url: 'https://video.test/a.mp4' };
const course = { title: 'Course', modules: [{ id: 'm01', title: 'Module', phases: [{ id: 'p01', title: 'Phase', kind: 'read' as const, completion: { type: 'manual' as const }, capabilities: { chat: false, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [html, video] }] }] };

describe('reader parent contract', () => {
  it.each([
    ['https://lab.test/', 'https://lab.test/files/lessons/a.html'],
    ['https://lab.test/base/', 'https://lab.test/base/files/lessons/a.html']
  ])('accepts local HTML only beneath the exact Jupyter base %s', (jupyterBaseUrl, htmlSource) => {
    const message = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl, htmlSource };
    expect(parseReaderNavigation(message, 'https://lab.test')).toEqual(message);
    expect(selectReaderRoute(course, 'source-a', message, undefined, 'https://lab.test')).toEqual({ surface: html, htmlSource, parentOpened: true });
  });

  it('rejects paths outside the declared base and noncanonical files segments', () => {
    const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl: 'https://lab.test/base/', htmlSource: 'https://lab.test/base/files/lessons/a.html' };
    for (const htmlSource of [
      'https://courseweave.test/files/lessons/a.html',
      'https://attacker.test/base/files/lessons/a.html',
      'https://user:secret@lab.test/base/files/lessons/a.html',
      'https://lab.test/unrelated/files/lessons/a.html',
      'https://lab.test/base/not-files/a.html',
      'https://lab.test/base/files/nested/files/a.html',
      'https://lab.test/base/%66iles/lessons/a.html',
      'https://lab.test/base/files/../secret.html',
      'https://lab.test/base/files/a%2F..%2Fsecret.html',
      'https://lab.test/base/files/%252e%252e/secret.html',
      'https://lab.test/base/files/a.html?token=x',
      'https://lab.test/base/files/a.html#fragment'
    ]) expect(parseReaderNavigation({ ...message, htmlSource }, 'https://lab.test')).toBeNull();
    for (const jupyterBaseUrl of [
      'https://attacker.test/base/',
      'https://user:secret@lab.test/base/',
      'https://lab.test/base',
      'https://lab.test/base//',
      'https://lab.test/%62ase/',
      'https://lab.test/base/?token=x',
      'https://lab.test/base/#fragment',
      'https://lab.test/base/files/'
    ]) expect(parseReaderNavigation({ ...message, jupyterBaseUrl }, 'https://lab.test')).toBeNull();
  });

  it('requires an exact validated HTTPS video outcome matching the manifest URL', () => {
    const outcome = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'video', jupyterBaseUrl: 'https://lab.test/base/', htmlSource: 'https://video.test/a.mp4' };
    expect(selectReaderRoute(course, 'source-a', outcome, undefined, 'https://lab.test')).toEqual({ surface: video, htmlSource: null, parentOpened: true });
    expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'https://other.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
    expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'http://video.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
    expect(selectReaderRoute(course, 'source-a', { ...outcome, jupyterBaseUrl: 'https://attacker.test/' }, undefined, 'https://lab.test')).toBeNull();
  });

  it('rejects missing or extra keys, malformed fields, and null HTML success', () => {
    const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', jupyterBaseUrl: 'https://lab.test/', htmlSource: 'https://lab.test/files/lessons/a.html' };
    expect(parseReaderNavigation({ ...message, command: 'terminal:send-text' }, 'https://lab.test')).toBeNull();
    const { jupyterBaseUrl: _, ...missingBase } = message;
    expect(parseReaderNavigation(missingBase, 'https://lab.test')).toBeNull();
    expect(selectReaderRoute(course, 'source-a', { ...message, htmlSource: null } as never, undefined, 'https://lab.test')).toBeNull();
  });
});
