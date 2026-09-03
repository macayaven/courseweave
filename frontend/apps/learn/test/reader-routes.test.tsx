import { describe, expect, it } from 'vitest';

import { parseReaderNavigation, selectReaderRoute } from '../src/reader-routes';

const html = { id: 'lesson', type: 'html' as const, role: 'primary' as const, path: 'lessons/a.html' };
const video = { id: 'video', type: 'video' as const, role: 'primary' as const, url: 'https://video.test/a.mp4' };
const course = { title: 'Course', modules: [{ id: 'm01', title: 'Module', phases: [{ id: 'p01', title: 'Phase', kind: 'read' as const, completion: { type: 'manual' as const }, capabilities: { chat: false, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [html, video] }] }] };

describe('reader parent contract', () => {
  it('accepts a local HTML source only at the exact Jupyter parent files route', () => {
    const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', htmlSource: 'https://lab.test/base/files/lessons/a.html' };
    expect(parseReaderNavigation(message, 'https://lab.test')).toEqual(message);
    for (const htmlSource of [
      'https://courseweave.test/files/lessons/a.html',
      'https://attacker.test/base/files/lessons/a.html',
      'https://user:secret@lab.test/base/files/lessons/a.html',
      'https://lab.test/base/not-files/a.html',
      'https://lab.test/base/files/../secret.html',
      'https://lab.test/base/files/a%2F..%2Fsecret.html',
      'https://lab.test/base/files/%252e%252e/secret.html',
      'https://lab.test/base/files/a.html?token=x'
    ]) expect(parseReaderNavigation({ ...message, htmlSource }, 'https://lab.test')).toBeNull();
  });

  it('requires an exact validated HTTPS video outcome matching the manifest URL', () => {
    const outcome = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'video', htmlSource: 'https://video.test/a.mp4' };
    expect(selectReaderRoute(course, 'source-a', outcome, undefined, 'https://lab.test')).toEqual({ surface: video, htmlSource: null });
    expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'https://other.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
    expect(selectReaderRoute(course, 'source-a', { ...outcome, htmlSource: 'http://video.test/a.mp4' }, undefined, 'https://lab.test')).toBeNull();
  });

  it('rejects extra keys, malformed fields, and null HTML success', () => {
    const message = { type: 'courseweave.reader.opened.v1', sourceId: 'source-a', moduleId: 'm01', phaseId: 'p01', surfaceId: 'lesson', htmlSource: 'https://lab.test/files/lessons/a.html' };
    expect(parseReaderNavigation({ ...message, command: 'terminal:send-text' }, 'https://lab.test')).toBeNull();
    expect(selectReaderRoute(course, 'source-a', { ...message, htmlSource: null } as never, undefined, 'https://lab.test')).toBeNull();
  });
});
