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
  schema_version: 2,
  id: 'course',
  title: 'Course',
  policies: { max_shared_chars: 100, allowed_share_kinds: ['selection','cell','output'] },
  modules: [{
    id: 'module',
    title: 'Module',
    phases: [{
      id: 'phase',
      title: 'Phase',
      progress: 'required', teacher: {access:{mode:'available',requires:[]},sharing:{allow:[]}},
      surfaces: [{ id: 'terminal', type: 'terminal', cwd: '.', command: ['uv', 'run', 'pytest'] }]
    }]
  }]
};

describe('native terminal instruction composition', () => {
  it.each([false, true])('keeps later lesson navigation after a slow terminal settles (failure: %s)', async (terminalFails) => {
    const terminal = new MainAreaHarness('slow-terminal');
    let finish!: (value: Widget) => void;
    let reject!: (error: Error) => void;
    const creation = new Promise<Widget>((resolve, fail) => { finish = resolve; reject = fail; });
    const shell = {add: vi.fn(), activateById: vi.fn(), currentWidget: null};
    const opened = vi.fn();
    const factory = new CourseSurfaceFactory({
      shell, documents: {openOrReveal: vi.fn()}, commands: {execute: vi.fn(() => creation)},
      serviceOrigin: 'https://courseweave.test', jupyterOrigin: window.location.origin,
      baseUrl: '/', onOpened: opened,
    });
    const fixture = structuredClone(course);
    fixture.modules[0]!.phases[0]!.surfaces.push({id: 'lesson', type: 'html', path: 'lesson.html', fragment: 'theory'});
    factory.setCourse(fixture);
    const first = factory.open({moduleId: 'module', phaseId: 'phase', surfaceId: 'terminal'});
    const firstOutcome = first.catch(() => undefined);
    const last = factory.open({moduleId: 'module', phaseId: 'phase', surfaceId: 'lesson'});
    if (terminalFails) reject(new Error('terminal unavailable')); else finish(terminal);
    try {
      await Promise.all([firstOutcome, last]);
      expect(shell.activateById).toHaveBeenLastCalledWith('courseweave-reader');
      expect(opened.mock.calls.map(([coordinate]) => coordinate.surfaceId)).toEqual(
        terminalFails ? ['lesson'] : ['terminal', 'lesson'],
      );
    } finally {
      for (const [widget] of shell.add.mock.calls) widget.dispose();
      terminal.dispose();
    }
  });

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

it('routes authored HTML fragment links through an explicit activity and opens an approved notebook natively',async()=>{
 const shell={add:vi.fn((widget:Widget)=>Widget.attach(widget,document.body)),activateById:vi.fn(),currentWidget:null};
 const notebook=new Widget();notebook.id='native-notebook';const documents={openOrReveal:vi.fn(()=>notebook)};
 const opened=vi.fn();const factory=new CourseSurfaceFactory({shell,documents,commands:{execute:vi.fn()},serviceOrigin:'https://courseweave.test',jupyterOrigin:window.location.origin,baseUrl:'/',onOpened:opened});
 const fixture={...course,modules:[{id:'module',title:'Module',phases:[
  {id:'read',title:'Read',progress:'required' as const,teacher:{access:{mode:'available' as const,requires:[]},sharing:{allow:[]}},surfaces:[{id:'html',type:'html' as const,path:'lesson.html',label:'Lesson'}]},
  {id:'check',title:'Self-check',progress:'required' as const,teacher:{access:{mode:'available' as const,requires:[]},sharing:{allow:[]}},surfaces:[{id:'check',type:'html' as const,path:'lesson.html',fragment:'self-check',label:'Check'}]},
  {id:'practice',title:'Practice',progress:'required' as const,teacher:{access:{mode:'available' as const,requires:[]},sharing:{allow:[]}},surfaces:[{id:'notebook',type:'notebook' as const,path:'lab.ipynb',label:'Notebook'}]}
 ]}]};
 factory.setCourse(fixture);await factory.open({moduleId:'module',phaseId:'read',surfaceId:'html'});
 const reader=shell.add.mock.calls[0]![0];const iframe=reader.node.querySelector('iframe')!;
 // Simulate the scripts-disabled same-origin authored document loaded by Jupyter.
 const doc=iframe.contentDocument!;doc.open();doc.write('<!doctype html><html><body><a href="#self-check">Check yourself</a><a href="lab.ipynb">Notebook practice</a></body></html>');doc.close();
 iframe.dispatchEvent(new Event('load'));
 (doc.querySelector('a') as HTMLElement).click();
 await vi.waitFor(()=>expect(reader.node.querySelector('iframe')!.src).toContain('#self-check'));
 expect(factory.metadataFor(reader)).toMatchObject({explicitModuleId:'module',explicitPhaseId:'check'});
 const current=reader.node.querySelector('iframe')!;
 const next=current.contentDocument!;next.open();next.write('<!doctype html><html><body><a href="lab.ipynb">Notebook practice</a></body></html>');next.close();current.dispatchEvent(new Event('load'));
 (next.querySelector('a') as HTMLElement).click();
 await vi.waitFor(()=>expect(documents.openOrReveal).toHaveBeenCalledWith('lab.ipynb','Notebook'));
 expect(factory.metadataFor(notebook)).toMatchObject({explicitPhaseId:'practice'});expect(opened).toHaveBeenCalledTimes(3);
 reader.dispose();notebook.dispose();
});

it('scrolls the authored fragment after a hidden reader is activated and after its document loads', async () => {
  const shell = {add: vi.fn((widget: Widget) => Widget.attach(widget, document.body)), activateById: vi.fn(), currentWidget: null};
  const factory = new CourseSurfaceFactory({shell, documents: {openOrReveal: vi.fn()}, commands: {execute: vi.fn()}, serviceOrigin: 'https://courseweave.test', jupyterOrigin: window.location.origin, baseUrl: '/'});
  factory.setCourse({...course, modules: [{id: 'module', title: 'Module', phases: [{
    id: 'check', title: 'Self-check', progress: 'required', teacher: {access: {mode: 'available', requires: []}, sharing: {allow: []}},
    surfaces: [{id: 'html', type: 'html', path: 'lesson.html', fragment: 'self-check'}]
  }]}]});
  await factory.open({moduleId: 'module', phaseId: 'check', surfaceId: 'html'});
  const reader = shell.add.mock.calls[0]![0];
  try {
    const iframe = reader.node.querySelector('iframe')!;
    const doc = iframe.contentDocument!;
    doc.open();doc.write('<!doctype html><html><body><section id="self-check">Check yourself</section></body></html>');doc.close();
    const scroll = vi.fn();
    doc.getElementById('self-check')!.scrollIntoView = scroll;
    iframe.dispatchEvent(new Event('load'));
    expect(scroll).toHaveBeenCalled();
    scroll.mockClear();
    // A tab revisit without navigation retains the student's reading position.
    reader.hide();reader.show();reader.activate();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(scroll).not.toHaveBeenCalled();
    reader.hide();
    await factory.open({moduleId: 'module', phaseId: 'check', surfaceId: 'html'});
    const current = reader.node.querySelector('iframe')!;
    const hiddenDoc = current.contentDocument!;
    hiddenDoc.open();hiddenDoc.write('<!doctype html><html><body><section id="self-check">Check yourself</section></body></html>');hiddenDoc.close();
    hiddenDoc.getElementById('self-check')!.scrollIntoView = scroll;
    current.dispatchEvent(new Event('load'));
    expect(scroll).not.toHaveBeenCalled();
    reader.show();reader.activate();
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
  } finally {reader.dispose();}
});

it('keeps a new reader document inert until its own links are bound, ignoring an old load', async () => {
  const shell = {add: vi.fn((widget: Widget) => Widget.attach(widget, document.body)), activateById: vi.fn(), currentWidget: null};
  const factory = new CourseSurfaceFactory({shell, documents: {openOrReveal: vi.fn()}, commands: {execute: vi.fn()}, serviceOrigin: 'https://courseweave.test', jupyterOrigin: window.location.origin, baseUrl: '/'});
  const fixture = structuredClone(course);
  fixture.modules[0]!.phases[0]!.surfaces.push(
    {id: 'first', type: 'html', path: 'first.html'},
    {id: 'next', type: 'html', path: 'next.html'},
  );
  factory.setCourse(fixture);
  await factory.open({moduleId: 'module', phaseId: 'phase', surfaceId: 'first'});
  const reader = shell.add.mock.calls[0]![0];
  try {
    const oldFrame = reader.node.querySelector('iframe')!;
    expect(oldFrame.inert).toBe(true);
    await factory.open({moduleId: 'module', phaseId: 'phase', surfaceId: 'next'});
    const current = reader.node.querySelector('iframe')!;
    expect(current).not.toBe(oldFrame);
    oldFrame.dispatchEvent(new Event('load'));
    expect(current.inert).toBe(true);
    const doc = current.contentDocument!;
    doc.open();doc.write('<!doctype html><a href="first.html">Previous</a>');doc.close();
    current.dispatchEvent(new Event('load'));
    expect(doc.querySelector('a')!.dataset.courseweaveBound).toBe('true');
    expect(current.inert).toBe(false);
    expect(current.hasAttribute('aria-busy')).toBe(false);
  } finally { reader.dispose(); }
});
