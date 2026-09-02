import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SurfaceReader } from '../src/surface-reader';
import { selectReaderRoute } from '../src/reader-routes';

const htmlSurface = {
  id: 'lesson-html',
  type: 'html' as const,
  role: 'primary' as const,
  path: 'lessons/intro.html',
  label: 'Introduction lesson'
};

const videoSurface = {
  id: 'lesson-video',
  type: 'video' as const,
  role: 'primary' as const,
  url: 'https://video.example.test/intro.mp4',
  label: 'Introduction video'
};

afterEach(() => cleanup());

describe('SurfaceReader', () => {
  it('accepts an HTML reader route only when a source-bound typed outcome names a current manifest surface', () => {
    const course = {
      title: 'Course',
      modules: [{
        id: 'module-a',
        title: 'Module',
        phases: [{
          id: 'read-a',
          title: 'Read',
          kind: 'read' as const,
          completion: { type: 'manual' as const },
          capabilities: { chat: false, hint_level: 'none' as const, share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false },
          surfaces: [htmlSurface]
        }]
      }]
    };
    const outcome = { type: 'courseweave.reader.opened.v1' as const, sourceId: 'notebook-a', moduleId: 'module-a', phaseId: 'read-a', surfaceId: 'lesson-html', htmlSource: 'https://courseweave.test/content/lesson-html' };

    expect(selectReaderRoute(course, 'notebook-a', outcome)).toEqual({ surface: htmlSurface, htmlSource: 'https://courseweave.test/content/lesson-html' });
    expect(selectReaderRoute(course, 'other-source', outcome)).toBeNull();
    expect(selectReaderRoute(course, 'notebook-a', { ...outcome, surfaceId: 'missing' })).toBeNull();
  });

  it('renders a selected local HTML surface in a minimal sandbox titled from manifest metadata', () => {
    render(<SurfaceReader surface={htmlSurface} htmlSource="https://courseweave.test/content/lesson-html" serviceOrigin="https://courseweave.test" />);

    const reader = screen.getByTitle('Introduction lesson');
    expect(reader).toHaveAttribute('src', 'https://courseweave.test/content/lesson-html');
    expect(reader).toHaveAttribute('sandbox', 'allow-scripts');
    expect(reader).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-forms');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-downloads');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-modals');
    expect(reader.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  });

  it('does not request an iframe for a missing, mismatched, or unsupported local source', () => {
    const { rerender } = render(<SurfaceReader surface={htmlSurface} htmlSource={null} serviceOrigin="https://courseweave.test" />);
    expect(screen.getByRole('status')).toHaveTextContent('This course surface is unavailable.');
    expect(document.querySelector('iframe')).toBeNull();

    rerender(<SurfaceReader surface={htmlSurface} htmlSource="https://outside.example.test/lesson" serviceOrigin="https://courseweave.test" />);
    expect(document.querySelector('iframe')).toBeNull();

    rerender(<SurfaceReader surface={htmlSurface} htmlSource="https://courseweave.test/content/lesson-html?untrusted" serviceOrigin="https://courseweave.test" />);
    expect(document.querySelector('iframe')).toBeNull();

    rerender(<SurfaceReader surface={{ ...htmlSurface, type: 'markdown' }} htmlSource="https://courseweave.test/content/lesson-html" serviceOrigin="https://courseweave.test" />);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('renders an absolute credential-free HTTPS video with native controls and its manifest title', () => {
    render(<SurfaceReader surface={videoSurface} serviceOrigin="https://courseweave.test" />);

    const video = screen.getByTitle('Introduction video');
    expect(video).toHaveAttribute('src', 'https://video.example.test/intro.mp4');
    expect(video).toHaveAttribute('controls');
  });

  it.each([
    'http://video.example.test/intro.mp4',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'blob:https://video.example.test/id',
    'file:///private/intro.mp4',
    'https://viewer:secret@video.example.test/intro.mp4',
    '/relative/intro.mp4',
    'not a url',
    ''
  ])('does not assign an unsafe video source: %s', (url) => {
    render(<SurfaceReader surface={{ ...videoSurface, url }} serviceOrigin="https://courseweave.test" />);

    expect(screen.getByRole('status')).toHaveTextContent('This course surface is unavailable.');
    expect(document.querySelector('video')).toBeNull();
  });
});
