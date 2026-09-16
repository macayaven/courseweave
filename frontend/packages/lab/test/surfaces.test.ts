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
  COURSEWEAVE_PALETTE_CATEGORY,
  SurfaceRequestBroker,
  coordinateForCoursePath,
  localReaderUrl,
  parseCourseSnapshot,
  registerCoursePalette,
  registerCourseCommands,
  type CourseSnapshot
} from '../src/surfaces';

const course: CourseSnapshot = {
  schema_version: 2,
  id: 'course',
  title: 'Course',
  policies: { max_shared_chars: 4, allowed_share_kinds: ['selection','cell','output'] },
  modules: [{
    id: 'm01',
    title: 'Module',
    phases: [{
      id: 'p01',
      title: 'Phase',
      progress: 'required', teacher: {access:{mode:'available',requires:[]},sharing:{allow:['selection', 'cell']}},
      surfaces: [
        { id: 'html', type: 'html', path: 'lessons/a b.html' },
        { id: 'video', type: 'video', src: 'https://video.test/watch?v=1' },
        { id: 'markdown', type: 'markdown', path: 'README.md' },
        { id: 'notebook', type: 'notebook', path: 'notebooks/lab.ipynb' },
        { id: 'source', type: 'source', path: 'src/main.py' },
        { id: 'terminal', type: 'terminal', cwd: 'labs', command: ['python', '-m', 'lab'] }
      ]
    }]
  }]
};

function widget(id: string) {
  const handlers: Array<() => void> = [];
  const contentHeader = {
    addWidget: vi.fn((child: Widget) => {
      value.node.querySelector('[data-main-area-content-header]')!.appendChild(child.node);
    })
  };
  const value = {
    id,
    isDisposed: false,
    node: document.createElement('div'),
    title: { label: '', caption: '', closable: false },
    disposed: { connect: vi.fn((handler: () => void) => handlers.push(handler)) },
    contentHeader,
    dispose: vi.fn(() => {
      value.isDisposed = true;
      handlers.forEach((handler) => handler());
    })
  };
  const header = document.createElement('div');
  header.setAttribute('data-main-area-content-header', '');
  value.node.appendChild(header);
  const terminalInternal = document.createElement('div');
  terminalInternal.className = 'jp-Terminal';
  value.node.appendChild(terminalInternal);
  return value;
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

  it('adds every registered CourseWeave command to one palette category without duplicates', () => {
    const commandIds = Object.values(COURSEWEAVE_COMMANDS);
    const items: Array<{ command: string; category: string }> = [];

    registerCoursePalette({ addItem: (item) => {
      items.push(item);
      return { dispose: vi.fn() };
    } });

    expect(items).toEqual(commandIds.map((command) => ({
      command,
      category: COURSEWEAVE_PALETTE_CATEGORY
    })));
    expect(new Set(items.map(({ command }) => command)).size).toBe(items.length);
  });

  it('parses only the relay fields needed for exact course allowlisting', () => {
    expect(parseCourseSnapshot(course)).toEqual(course);
    expect(parseCourseSnapshot({ ...course, modules: [{ ...course.modules[0]!, id: '' }] })).toBeNull();
    expect(parseCourseSnapshot({ ...course, policies: { max_shared_chars: 0, allowed_share_kinds: ['selection','cell','output'] } })).toBeNull();
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
    expect(commands.execute).toHaveBeenCalledWith('terminal:create-new');
    expect(JSON.stringify(commands.execute.mock.calls)).not.toContain('labs');
    expect(JSON.stringify(commands.execute.mock.calls)).not.toContain('python');
    expect(nativeTerminal.contentHeader.addWidget).toHaveBeenCalledOnce();
    expect(nativeTerminal.node.querySelector('.jp-Terminal')?.children).toHaveLength(0);
    expect(nativeTerminal.node.querySelectorAll('[data-courseweave-terminal-instructions]')).toHaveLength(1);
    const instructions = nativeTerminal.node.querySelector<HTMLElement>('[data-courseweave-terminal-instructions]')!;
    const payload = '{\n  "cwd": "labs",\n  "command": [\n    "python",\n    "-m",\n    "lab"\n  ]\n}';
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

  it('reuses one composed terminal when consecutive opens overlap', async () => {
    let resolveCreation!: (value: ReturnType<typeof widget>) => void;
    const { factory, commands, shell, nativeTerminal } = harness();
    commands.execute.mockReturnValue(new Promise((resolve) => {
      resolveCreation = resolve;
    }));

    const first = factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    const second = factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    await vi.waitFor(() => expect(commands.execute).toHaveBeenCalledOnce());

    resolveCreation(nativeTerminal);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(nativeTerminal.contentHeader.addWidget).toHaveBeenCalledOnce();
    expect(nativeTerminal.node.querySelectorAll('[data-courseweave-terminal-instructions]')).toHaveLength(1);
    expect(shell.activateById.mock.calls).toEqual([['terminal-native'], ['terminal-native']]);
  });

  it('clears a failed terminal creation flight so a later open can retry', async () => {
    const { factory, commands } = harness();
    const replacement = widget('terminal-retry');
    commands.execute.mockRejectedValueOnce(new Error('backend unavailable')).mockResolvedValueOnce(replacement);
    const first = factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    const second = factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    await expect(Promise.all([first, second])).rejects.toThrow('backend unavailable');

    await expect(factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' })).resolves.toMatchObject({
      terminalSurfaceId: 'terminal'
    });
    expect(commands.execute).toHaveBeenCalledTimes(2);
    expect(replacement.contentHeader.addWidget).toHaveBeenCalledOnce();
  });

  it('disposes owned instructions and recreates one composition after the native terminal closes', async () => {
    const { factory, commands, nativeTerminal } = harness();
    const replacement = widget('terminal-recreated');
    commands.execute.mockResolvedValueOnce(nativeTerminal).mockResolvedValueOnce(replacement);
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });
    const instructions = nativeTerminal.contentHeader.addWidget.mock.calls[0]![0] as Widget;

    nativeTerminal.dispose();
    expect(instructions.isDisposed).toBe(true);
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'terminal' });

    expect(commands.execute).toHaveBeenCalledTimes(2);
    expect(replacement.contentHeader.addWidget).toHaveBeenCalledOnce();
    expect(replacement.node.querySelectorAll('[data-courseweave-terminal-instructions]')).toHaveLength(1);
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
    expect(commands.execute).toHaveBeenCalledWith('terminal:create-new');
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
    let iframe = reader.node.querySelector('iframe') as HTMLIFrameElement;
    expect(reader.id).toBe('courseweave-reader');
    expect(html.htmlSource).toBe('https://lab.test/base/courseweave/reader/lessons/a%20b.html');
    expect(html.jupyterBaseUrl).toBe('https://lab.test/base/');
    expect(iframe.src).toBe(html.htmlSource);
    expect(iframe.referrerPolicy).toBe('same-origin');
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-forms');

    const video = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'video' });
    iframe = reader.node.querySelector('iframe') as HTMLIFrameElement;
    expect(video.htmlSource).toBe('https://video.test/watch?v=1');
    expect(video.jupyterBaseUrl).toBe('https://lab.test/base/');
    expect(iframe.src).toBe(video.htmlSource);
    expect(iframe.referrerPolicy).toBe('no-referrer');
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.inert).toBe(true);
    iframe.dispatchEvent(new Event('load'));
    expect(iframe.inert).toBe(false);
    expect(shell.add).toHaveBeenCalledOnce();
  });

  it('embeds a local video as media so its authenticated range requests retain the Jupyter origin', async () => {
    const { factory, shell } = harness();
    const local = structuredClone(course);
    local.modules[0]!.phases[0]!.surfaces.find(s => s.id === 'video')!.src = 'media/clip.mp4';
    factory.setCourse(local);
    const result = await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'video' });
    const reader = shell.add.mock.calls[0]![0];
    const iframe = reader.node.querySelector('iframe') as HTMLIFrameElement;
    expect(result.htmlSource).toBe('https://lab.test/base/files/media/clip.mp4');
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    const document = new DOMParser().parseFromString(iframe.srcdoc, 'text/html');
    expect(document.querySelector('video')?.getAttribute('src')).toBe(result.htmlSource);
    expect(document.querySelector('video')?.hasAttribute('controls')).toBe(true);
    expect(document.querySelector('video')?.hasAttribute('autoplay')).toBe(false);
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
    expect(document.querySelector('script')).toBeNull();
    await factory.open({ moduleId: 'm01', phaseId: 'p01', surfaceId: 'html' });
    expect(reader.node.querySelector('iframe')?.srcdoc).toBe('');
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
    unsafe.modules[0]!.phases[0]!.surfaces[1]!.src = 'https://user:secret@video.test/watch';
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
    expect(author.node.querySelector('iframe')?.getAttribute('sandbox')?.split(' ')).toContain('allow-downloads');
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
  it('honors a repeated terminal selection after a different queued lesson', async () => {
    const {factory, commands, shell, nativeTerminal} = harness();
    let finish!: (value: ReturnType<typeof widget>) => void;
    commands.execute.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const child = {postMessage: vi.fn()} as unknown as Window;
    const broker = new SurfaceRequestBroker({hostWindow: window, childWindow: child, serviceOrigin: 'https://courseweave.test', sourceId: 'source-a', factory});
    broker.start();
    try {
      for (const surfaceId of ['terminal', 'html', 'terminal']) {
        window.dispatchEvent(new MessageEvent('message', {
          origin: 'https://courseweave.test', source: child,
          data: {type: 'courseweave.open-surface.v1', moduleId: 'm01', phaseId: 'p01', surfaceId},
        }));
      }
      await vi.waitFor(() => expect(commands.execute).toHaveBeenCalledOnce());
      finish(nativeTerminal);
      await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(3));
      expect((child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => message.surfaceId)).toEqual(['terminal', 'html', 'terminal']);
      expect(shell.activateById).toHaveBeenLastCalledWith('terminal-native');
      expect(commands.execute).toHaveBeenCalledOnce();
    } finally { broker.dispose(); }
  });

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
      htmlSource: 'https://lab.test/base/courseweave/reader/lessons/a%20b.html'
    }, 'https://courseweave.test');
    broker.dispose();
  });

  it('ignores wrong source, origin, schema, and failed coordinates', async () => {
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

it('accepts canonical v2 policies and fragment metadata without legacy capabilities', () => {
 const canonical = structuredClone(course) as any;
 canonical.schema_version = 2;
 const phase = canonical.modules[0].phases[0];
 delete phase.capabilities;
 phase.teacher = {access:{mode:'available',requires:[]},sharing:{allow:['cell']},guidance:{style:{type:'builtin',id:'explanatory'},hint_level:'gentle'},proposals:{allow:[]}};
 phase.surfaces[0].fragment='self-check';
 expect(parseCourseSnapshot(canonical)).not.toBeNull();
});
