import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.DragEvent === 'undefined') {
    Object.defineProperty(globalThis, 'DragEvent', { value: class DragEvent extends Event {} });
  }
});

import { Panel, Widget } from '@lumino/widgets';

import { CourseSurfaceFactory, type CourseSnapshot } from '../src/surfaces';

class MainAreaHarness extends Panel {
  readonly contentHeader = new Panel();

  constructor(id: string) {
    super();
    this.id = id;
    this.addWidget(this.contentHeader);
  }
}

const course: CourseSnapshot = {
  id: 'course',
  title: 'Course',
  policies: { max_shared_chars: 100 },
  modules: [{
    id: 'module',
    title: 'Module',
    phases: [{
      id: 'phase',
      title: 'Phase',
      capabilities: { share_selection: false, share_cell: false, share_output: false },
      surfaces: [{ id: 'terminal', type: 'terminal', cwd: '.', argv: ['uv', 'run', 'pytest'] }]
    }]
  }]
};

describe('native terminal instruction composition', () => {
  it('uses the public main-area content header and follows real Lumino attach/dispose lifecycle', async () => {
    const nativeTerminal = new MainAreaHarness('native-terminal');
    Widget.attach(nativeTerminal, document.body);
    const shell = {
      add: vi.fn(),
      activateById: vi.fn(() => {
        expect(nativeTerminal.contentHeader.node.querySelector('[data-courseweave-terminal-instructions]')).not.toBeNull();
      }),
      currentWidget: null
    };
    const factory = new CourseSurfaceFactory({
      shell,
      documents: { openOrReveal: vi.fn() },
      commands: { execute: vi.fn().mockResolvedValue(nativeTerminal) },
      serviceOrigin: 'https://courseweave.test',
      jupyterOrigin: 'https://lab.test',
      baseUrl: '/',
      writeClipboard: vi.fn().mockResolvedValue(undefined)
    });
    factory.setCourse(course);

    try {
      await factory.open({ moduleId: 'module', phaseId: 'phase', surfaceId: 'terminal' });
      const instruction = nativeTerminal.contentHeader.widgets[0]!;
      expect(instruction).toBeInstanceOf(Widget);
      expect(instruction.node.isConnected).toBe(true);
      expect(nativeTerminal.node.querySelectorAll('[data-courseweave-terminal-instructions]')).toHaveLength(1);

      nativeTerminal.dispose();
      expect(instruction.isDisposed).toBe(true);
    } finally {
      if (!nativeTerminal.isDisposed) nativeTerminal.dispose();
    }
  });
});
