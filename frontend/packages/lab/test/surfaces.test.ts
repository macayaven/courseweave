import { describe, expect, it, vi } from 'vitest';
import type { Widget } from '@lumino/widgets';

vi.mock('@lumino/widgets', () => ({
  Widget: class {
    id = '';
    isDisposed = false;
    node: HTMLElement;
    title = { label: '', caption: '', closable: false };
    private handlers: Array<() => void> = [];
    disposed = { connect: (handler: () => void) => this.handlers.push(handler) };
    constructor(options: { node?: HTMLElement } = {}) {
      this.node = options.node ?? document.createElement('div');
    }
    dispose() {
      this.isDisposed = true;
      this.handlers.forEach((handler) => handler());
    }
  }
}));

import {
  CourseSurfaceFactory,
  COURSEWEAVE_COMMANDS,
  SurfaceRequestBroker,
  coordinateForCoursePath,
  localReaderUrl,
  parseCourseSnapshot,
  registerCourseCommands,
  type CourseSnapshot
} from '../src/surfaces';

const course: CourseSnapshot = {
  id: 'course',
  title: 'Course',
  policies: { max_shared_chars: 4 },
  modules: [{
    id: 'm01',
    title: 'Module',
    phases: [{
      id: 'p01',
      title: 'Phase',
      capabilities: {
        share_selection: true,
        share_cell: true,
        share_output: false
      },
      surfaces: [
        { id: 'html', type: 'html', path: 'lessons/a b.html' },
        { id: 'video', type: 'video', url: 'https://video.test/watch?v=1' },
        { id: 'markdown', type: 'markdown', path: 'README.md' },
        { id: 'notebook', type: 'notebook', path: 'notebooks/lab.ipynb' },
        { id: 'source', type: 'source', path: 'src/main.py' },
        { id: 'terminal', type: 'terminal', cwd: 'labs', argv: ['python', '-m', 'lab'] }
      ]
    }]
  }]
};

function widget(id: string) {
  return {
    id,
    isDisposed: false,
    node: document.createElement('div'),
    title: { label: '', caption: '', closable: false },
    disposed: { connect: vi.fn() }
  };
}

function harness(
  beforeAuthorAttach?: (widget: Widget, iframe: HTMLIFrameElement) => void,
  writeClipboard = vi.fn().mockResolvedValue(undefined)
) {
  const shell = { add: vi.fn(), activateById: vi.fn(), currentWidget: null };
  const documents = { openOrReveal: vi.fn((path: string, factory: string) => widget(`${factory}:${path}`)) };
  const nativeTerminal = widget('terminal-native');
  const commands = { execute: vi.fn().mockResolvedValue(nativeTerminal) };
  const factory = new CourseSurfaceFactory({
    shell,
    documents,
    commands,
    serviceOrigin: 'https://courseweave.test',
    jupyterOrigin: 'https://lab.test',
    baseUrl: '/base/',
    beforeAuthorAttach,
    writeClipboard
  });
  factory.setCourse(course);
  return { factory, shell, documents, commands, nativeTerminal, writeClipboard };
}

describe('CourseSurfaceFactory', () => {
  it('registers only the six stable CourseWeave commands and maps Share commands without reading content', () => {
    const registrations = new Map<string, { label: string; execute(): unknown }>();
    const actions = { openGuide: vi.fn(), openDashboard: vi.fn(), openAuthor: vi.fn(), requestShare: vi.fn() };
    registerCourseCommands({ addCommand: (id, options) => registrations.set(id, options) }, actions);
    expect([...registrations.keys()]).toEqual(Object.values(COURSEWEAVE_COMMANDS));
    registrations.get(COURSEWEAVE_COMMANDS.openGuide)!.execute();
    registrations.get(COURSEWEAVE_COMMANDS.openDashboard)!.execute();
    registrations.get(COURSEWEAVE_COMMANDS.openAuthor)!.execute();
    registrations.get(COURSEWEAVE_COMMANDS.shareSelection)!.execute();
    registrations.get(COURSEWEAVE_COMMANDS.shareCell)!.execute();
    registrations.get(COURSEWEAVE_COMMANDS.shareOutput)!.execute();
    expect(actions.openGuide).toHaveBeenCalledOnce();
    expect(actions.openDashboard).toHaveBeenCalledOnce();
    expect(actions.openAuthor).toHaveBeenCalledOnce();
    expect(actions.requestShare.mock.calls).toEqual([['selection'], ['cell'], ['output']]);
  });

  it('parses only the relay fields needed for exact course allowlisting', () => {
    expect(parseCourseSnapshot(course)).toEqual(course);
    expect(parseCourseSnapshot({ ...course, modules: [{ ...course.modules[0]!, id: '' }] })).toBeNull();
    expect(parseCourseSnapshot({ ...course, policies: { max_shared_chars: 0 } })).toBeNull();
  });

  it('opens rendered Markdown, notebook, and source with verified native factories', async () => {
    const { factory, documents } = harness();
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'markdown' });
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'notebook' });
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'source' });
    expect(documents.openOrReveal.mock.calls).toEqual([
      ['README.md', 'Markdown Preview'],
      ['notebooks/lab.ipynb', 'Notebook'],
      ['src/main.py', 'Editor']
    ]);
  });

  it('resolves an exact unique active course path for capability checks and rejects ambiguity', () => {
    expect(coordinateForCoursePath(course, 'notebooks/lab.ipynb')).toEqual({ moduleId: 'm01', phaseId: 'p01' });
    expect(coordinateForCoursePath(course, '../notebooks/lab.ipynb')).toBeNull();
    const duplicate = structuredClone(course);
    duplicate.modules[0]!.phases.push({ ...structuredClone(duplicate.modules[0]!.phases[0]!), id: 'p02' });
    expect(coordinateForCoursePath(duplicate, 'notebooks/lab.ipynb')).toBeNull();
  });

  it('shows exact structured terminal instructions before activating one stable native terminal', async () => {
    const { factory, commands, shell, nativeTerminal, writeClipboard } = harness();
    shell.activateById.mockImplementation(() => {
      expect(nativeTerminal.node.querySelector('[data-courseweave-terminal-instructions]')).not.toBeNull();
    });
    const first = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    const second = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    expect(commands.execute).toHaveBeenCalledOnce();
    expect(commands.execute).toHaveBeenCalledWith('terminal:create-new', {
      name: 'courseweave-m01-p01-terminal'
    });
    expect(JSON.stringify(commands.execute.mock.calls)).not.toContain('labs');
    expect(JSON.stringify(commands.execute.mock.calls)).not.toContain('python');
    expect(nativeTerminal.node.querySelectorAll('[data-courseweave-terminal-instructions]')).toHaveLength(1);
    const instructions = nativeTerminal.node.querySelector<HTMLElement>('[data-courseweave-terminal-instructions]')!;
    const payload = '{\n  "cwd": "labs",\n  "argv": [\n    "python",\n    "-m",\n    "lab"\n  ]\n}';
    expect(instructions.querySelector('[data-courseweave-terminal-command]')?.textContent).toBe(payload);
    expect(instructions.textContent).toContain('Terminal launch instructions');
    const copy = instructions.querySelector<HTMLButtonElement>('button')!;
    expect(copy.textContent).toBe('Copy launch instructions');
    copy.click();
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(payload));
    expect(instructions.querySelector('[role="status"]')?.textContent).toBe('Terminal launch instructions copied.');
    expect(first.terminalSurfaceId).toBe('terminal');
    expect(second.terminalSurfaceId).toBe('terminal');
    expect(shell.activateById).toHaveBeenCalledTimes(2);
    expect(shell.activateById).toHaveBeenLastCalledWith('terminal-native');
  });

  it('shows copy failure without forwarding instructions or executing anything', async () => {
    const writeClipboard = vi.fn(() => {
      throw new Error('clipboard denied');
    });
    const { factory, commands, nativeTerminal } = harness(undefined, writeClipboard);
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    nativeTerminal.node.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(nativeTerminal.node.querySelector('[role="status"]')?.textContent).toBe(
      'Copy failed. Select the instructions and copy them manually.'
    ));
    expect(commands.execute).toHaveBeenCalledOnce();
    expect(commands.execute).toHaveBeenCalledWith('terminal:create-new', {
      name: 'courseweave-m01-p01-terminal'
    });
  });

  it('rejects an unsafe terminal cwd before creating UI or a terminal', async () => {
    const { factory, commands, shell } = harness();
    const unsafe = structuredClone(course);
    unsafe.modules[0]!.phases[0]!.surfaces.find((surface) => surface.type === 'terminal')!.cwd = '../outside';
    factory.setCourse(unsafe);
    await expect(factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' })).rejects.toThrow('unsafe course path');
    expect(commands.execute).not.toHaveBeenCalled();
    expect(shell.add).not.toHaveBeenCalled();
    expect(document.querySelector('[data-courseweave-terminal-instructions]')).toBeNull();
  });

  it('uses one reusable sandboxed reader with jailed Jupyter files and validated HTTPS video URLs', async () => {
    const { factory, shell } = harness();
    const html = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'html' });
    const reader = shell.add.mock.calls[0]![0];
    const iframe = reader.node.querySelector('iframe') as HTMLIFrameElement;
    expect(reader.id).toBe('courseweave-reader');
    expect(html.htmlSource).toBe('https://lab.test/base/files/lessons/a%20b.html');
    expect(html.jupyterBaseUrl).toBe('https://lab.test/base/');
    expect(iframe.src).toBe(html.htmlSource);
    expect(iframe.referrerPolicy).toBe('no-referrer');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-presentation');

    const video = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'video' });
    expect(video.htmlSource).toBe('https://video.test/watch?v=1');
    expect(video.jupyterBaseUrl).toBe('https://lab.test/base/');
    expect(iframe.src).toBe(video.htmlSource);
    expect(shell.add).toHaveBeenCalledOnce();
  });

  it.each([
    '../secret.html',
    '/absolute.html',
    'safe/../../secret.html',
    'safe\\secret.html',
    'https://courseweave.test/learn/',
    'https://user:secret@lab.test/base/files/lesson.html'
  ])('rejects unsafe local reader input %s', (path) => {
    expect(() => localReaderUrl(path, 'https://lab.test', '/base/')).toThrow();
  });

  it('rejects missing coordinates and foreign or credentialed video URLs before opening', async () => {
    const { factory, shell } = harness();
    await expect(factory.open({ moduleId: 'm01', phaseId: 'wrong', surfaceId: 'html' })).rejects.toThrow('not allowlisted');
    const unsafe = structuredClone(course);
    unsafe.modules[0]!.phases[0]!.surfaces[1]!.url = 'https://user:secret@video.test/watch';
    factory.setCourse(unsafe);
    await expect(factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'video' })).rejects.toThrow('invalid video');
    expect(shell.add).not.toHaveBeenCalled();
  });

  it('deduplicates dashboard and Author widgets and recreates them after disposal', () => {
    const { factory, shell } = harness();
    const dashboard = factory.openDashboard();
    const sameDashboard = factory.openDashboard();
    const author = factory.openAuthor();
    const sameAuthor = factory.openAuthor();
    expect(dashboard).toBe(sameDashboard);
    expect(author).toBe(sameAuthor);
    expect(dashboard.id).toBe('courseweave-dashboard');
    expect(author.id).toBe('courseweave-author');
    expect((author.node.querySelector('iframe') as HTMLIFrameElement).src).toBe('https://courseweave.test/author/');
    expect(shell.add).toHaveBeenCalledTimes(2);

    dashboard.dispose();
    expect(factory.openDashboard()).not.toBe(dashboard);
    expect(shell.add).toHaveBeenCalledTimes(3);
  });

  it('registers the Author iframe before its first shell add and only once', () => {
    const beforeAuthorAttach = vi.fn(() => {
      expect(shell.add).not.toHaveBeenCalled();
    });
    const { factory, shell } = harness(beforeAuthorAttach);

    const author = factory.openAuthor();
    expect(factory.openAuthor()).toBe(author);

    expect(beforeAuthorAttach).toHaveBeenCalledOnce();
    expect(beforeAuthorAttach).toHaveBeenCalledWith(
      author,
      author.node.querySelector('iframe')
    );
    expect(shell.add).toHaveBeenCalledOnce();
  });

  it('rerenders one existing dashboard from the latest authenticated course snapshot', async () => {
    const { factory, shell, documents } = harness();
    const dashboard = factory.openDashboard();
    expect(dashboard.node.querySelector('h1')?.textContent).toBe('Course');
    expect(dashboard.node.querySelector('button')?.textContent).toBe('html');

    const refreshed = structuredClone(course);
    refreshed.title = 'Refreshed Course';
    refreshed.modules[0]!.phases[0]!.surfaces = [
      { id: 'new-source', type: 'source', path: 'src/refreshed.py', label: 'Refreshed source' }
    ];
    factory.setCourse(refreshed);
    const sameDashboard = factory.openDashboard();

    expect(sameDashboard).toBe(dashboard);
    expect(shell.add).toHaveBeenCalledOnce();
    expect(dashboard.node.querySelector('h1')?.textContent).toBe('Refreshed Course');
    expect([...dashboard.node.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Refreshed source']);
    dashboard.node.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(documents.openOrReveal).toHaveBeenCalledWith('src/refreshed.py', 'Editor'));
    expect(documents.openOrReveal).not.toHaveBeenCalledWith('lessons/a b.html', expect.anything());
  });
});

describe('SurfaceRequestBroker', () => {
  it('accepts one exact owned-child request and reports final reader URL only after open succeeds', async () => {
    const { factory } = harness();
    const child = { postMessage: vi.fn() } as unknown as Window;
    const broker = new SurfaceRequestBroker({
      hostWindow: window,
      childWindow: child,
      serviceOrigin: 'https://courseweave.test',
      sourceId: 'source-a',
      factory
    });
    broker.start();
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://courseweave.test',
      source: child,
      data: { type: 'courseweave.open-surface.v1', moduleId: 'm01', phaseId: 'p01', surfaceId: 'html' }
    }));
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'courseweave.reader.opened.v1',
      sourceId: 'source-a',
      moduleId: 'm01',
      phaseId: 'p01',
      surfaceId: 'html',
      jupyterBaseUrl: 'https://lab.test/base/',
      htmlSource: 'https://lab.test/base/files/lessons/a%20b.html'
    }, 'https://courseweave.test');
    broker.dispose();
  });

  it('ignores wrong source, origin, schema, duplicate flight, and failed coordinates', async () => {
    const { factory } = harness();
    const child = { postMessage: vi.fn() } as unknown as Window;
    const open = vi.spyOn(factory, 'open');
    const broker = new SurfaceRequestBroker({ hostWindow: window, childWindow: child, serviceOrigin: 'https://courseweave.test', sourceId: 'source-a', factory });
    broker.start();
    const request = { type: 'courseweave.open-surface.v1', moduleId: 'm01', phaseId: 'p01', surfaceId: 'html' };
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://courseweave.test', source: {} as MessageEventSource, data: request }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://attacker.test', source: child, data: request }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://courseweave.test', source: child, data: { ...request, command: 'terminal:send-text' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://courseweave.test', source: child, data: { ...request, phaseId: 'missing' } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(open).toHaveBeenCalledOnce();
    expect(child.postMessage).not.toHaveBeenCalled();
    broker.dispose();
  });
});
