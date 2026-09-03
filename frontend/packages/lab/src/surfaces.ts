import { Widget } from '@lumino/widgets';

import { parseOpenSurfaceRequest } from './protocol';

export type SurfaceType = 'html' | 'markdown' | 'video' | 'notebook' | 'source' | 'terminal' | 'external';

export interface CourseSurface {
  id: string;
  type: SurfaceType;
  path?: string;
  url?: string;
  cwd?: string;
  argv?: string[];
  label?: string;
}

export interface CourseSnapshot {
  id: string;
  title: string;
  policies: { max_shared_chars: number };
  modules: Array<{
    id: string;
    title: string;
    phases: Array<{
      id: string;
      title: string;
      capabilities: {
        share_selection: boolean;
        share_cell: boolean;
        share_output: boolean;
      };
      surfaces: CourseSurface[];
    }>;
  }>;
}

export interface SurfaceCoordinate {
  moduleId: string;
  phaseId: string;
  surfaceId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}

function validSurface(value: unknown): value is CourseSurface {
  if (!record(value) || !nonBlank(value.id, 80)) return false;
  if (!['html', 'markdown', 'video', 'notebook', 'source', 'terminal', 'external'].includes(String(value.type))) return false;
  if (['html', 'markdown', 'notebook', 'source'].includes(String(value.type)) && !nonBlank(value.path)) return false;
  if (value.path !== undefined && !nonBlank(value.path)) return false;
  if (value.url !== undefined && !nonBlank(value.url, 4096)) return false;
  if (value.cwd !== undefined && !nonBlank(value.cwd)) return false;
  if (value.argv !== undefined && (!Array.isArray(value.argv) || value.argv.some((item) => !nonBlank(item, 4096)))) return false;
  return true;
}

export function parseCourseSnapshot(value: unknown): CourseSnapshot | null {
  if (!record(value) || !nonBlank(value.id, 80) || !nonBlank(value.title, 240)) return null;
  if (!record(value.policies) || !Number.isInteger(value.policies.max_shared_chars) || (value.policies.max_shared_chars as number) < 1 || (value.policies.max_shared_chars as number) > 131072) return null;
  if (!Array.isArray(value.modules)) return null;
  const moduleIds = new Set<string>();
  for (const module of value.modules) {
    if (!record(module) || !nonBlank(module.id, 80) || !nonBlank(module.title, 240) || moduleIds.has(module.id) || !Array.isArray(module.phases)) return null;
    moduleIds.add(module.id);
    const phaseIds = new Set<string>();
    for (const phase of module.phases) {
      if (!record(phase) || !nonBlank(phase.id, 80) || !nonBlank(phase.title, 240) || phaseIds.has(phase.id) || !record(phase.capabilities) || !Array.isArray(phase.surfaces)) return null;
      if (typeof phase.capabilities.share_selection !== 'boolean' || typeof phase.capabilities.share_cell !== 'boolean' || typeof phase.capabilities.share_output !== 'boolean') return null;
      phaseIds.add(phase.id);
      const surfaceIds = new Set<string>();
      for (const surface of phase.surfaces) {
        if (!validSurface(surface) || surfaceIds.has(surface.id)) return null;
        surfaceIds.add(surface.id);
      }
    }
  }
  return value as unknown as CourseSnapshot;
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid Jupyter origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value) throw new Error('invalid Jupyter origin');
  return parsed.origin;
}

function safeRelativePath(path: string): string {
  if (!nonBlank(path) || path.startsWith('/') || path.includes('\\') || path.includes('%') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) throw new Error('unsafe course path');
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) throw new Error('unsafe course path');
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

export function localReaderUrl(path: string, jupyterOrigin: string, baseUrl: string): string {
  return new URL(`files/${safeRelativePath(path)}`, canonicalJupyterBaseUrl(jupyterOrigin, baseUrl)).href;
}

export function canonicalJupyterBaseUrl(jupyterOrigin: string, baseUrl: string): string {
  const origin = canonicalOrigin(jupyterOrigin);
  let base: URL;
  try {
    base = new URL(baseUrl, `${origin}/`);
  } catch {
    throw new Error('invalid Jupyter base URL');
  }
  if (base.origin !== origin || base.username || base.password || base.search || base.hash) throw new Error('invalid Jupyter base URL');
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const segments = basePath.split('/').slice(1, -1);
  if (basePath.includes('%') || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment === 'files')) throw new Error('invalid Jupyter base URL');
  return `${origin}${basePath}`;
}

function videoUrl(value: string | undefined): string {
  if (value === undefined || value.trim() !== value) throw new Error('invalid video URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid video URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href !== value) throw new Error('invalid video URL');
  return parsed.href;
}

interface SurfaceShell {
  add(widget: Widget, area: 'main', options?: Record<string, unknown>): void;
  activateById(id: string): void;
  currentWidget: Widget | null;
}

interface SurfaceDocumentManager {
  openOrReveal(path: string, factory: string): Widget | undefined;
}

interface SurfaceCommands {
  execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface SurfaceMainAreaWidget extends Widget {
  // MainAreaWidget's public extension point for notification/header widgets.
  readonly contentHeader: {
    addWidget(widget: Widget): void;
  };
}

export interface SurfaceMetadata {
  activePath: string | null;
  surfaceKind: SurfaceType | null;
  terminalSurfaceId: string | null;
  explicitModuleId: string | null;
  explicitPhaseId: string | null;
}

interface CourseSurfaceFactoryOptions {
  shell: SurfaceShell;
  documents: SurfaceDocumentManager;
  commands: SurfaceCommands;
  serviceOrigin: string;
  jupyterOrigin: string;
  baseUrl: string;
  beforeAuthorAttach?: (widget: Widget, iframe: HTMLIFrameElement) => void;
  writeClipboard?: (text: string) => Promise<void>;
}

export interface SurfaceOpenResult {
  htmlSource: string | null;
  jupyterBaseUrl: string;
  terminalSurfaceId: string | null;
}

function writeBrowserClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    return Promise.reject(new Error('Clipboard API unavailable.'));
  }
  return clipboard.writeText(text);
}

function terminalInstructions(surface: CourseSurface, writeClipboard: (text: string) => Promise<void>): Widget {
  if (surface.cwd === undefined || surface.argv === undefined || surface.argv.length === 0) {
    throw new Error('Terminal instructions are missing.');
  }
  const payload = JSON.stringify({ cwd: surface.cwd, argv: surface.argv }, null, 2);
  const panel = document.createElement('section');
  panel.setAttribute('data-courseweave-terminal-instructions', '');
  panel.setAttribute('aria-label', 'CourseWeave terminal launch instructions');
  panel.style.padding = '8px 12px';
  panel.style.background = 'var(--jp-layout-color1, #fff)';
  panel.style.borderBottom = 'var(--jp-border-width, 1px) solid var(--jp-border-color2, #ddd)';
  panel.style.maxHeight = '40%';
  panel.style.overflow = 'auto';

  const heading = document.createElement('strong');
  heading.textContent = 'Terminal launch instructions';
  panel.appendChild(heading);

  const explanation = document.createElement('p');
  explanation.textContent = 'CourseWeave does not run this command. Review and copy the structured values when ready.';
  panel.appendChild(explanation);

  const command = document.createElement('pre');
  command.setAttribute('data-courseweave-terminal-command', '');
  command.textContent = payload;
  command.style.whiteSpace = 'pre-wrap';
  command.style.userSelect = 'text';
  panel.appendChild(command);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy launch instructions';
  panel.appendChild(copy);

  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.marginInlineStart = '8px';
  panel.appendChild(status);

  copy.addEventListener('click', () => {
    status.textContent = 'Copying terminal launch instructions…';
    void Promise.resolve().then(() => writeClipboard(payload)).then(() => {
      status.textContent = 'Terminal launch instructions copied.';
    }).catch(() => {
      status.textContent = 'Copy failed. Select the instructions and copy them manually.';
    });
  });
  return new Widget({ node: panel });
}

function mainAreaWidget(value: unknown): SurfaceMainAreaWidget {
  if (!(value instanceof Widget) && (!record(value) || !nonBlank(value.id))) {
    throw new Error('Native terminal unavailable.');
  }
  const candidate = value as SurfaceMainAreaWidget;
  if (!record(candidate.contentHeader) || typeof candidate.contentHeader.addWidget !== 'function' || candidate.isDisposed) {
    throw new Error('Native terminal unavailable.');
  }
  return candidate;
}

export function coordinateForCoursePath(course: CourseSnapshot, path: string): { moduleId: string; phaseId: string } | null {
  try {
    safeRelativePath(path);
  } catch {
    return null;
  }
  const matches = new Map<string, { moduleId: string; phaseId: string }>();
  for (const module of course.modules) {
    for (const phase of module.phases) {
      if (phase.surfaces.some((surface) => surface.path === path)) {
        matches.set(`${module.id}/${phase.id}`, { moduleId: module.id, phaseId: phase.id });
      }
    }
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}

export const COURSEWEAVE_COMMANDS = {
  openGuide: 'courseweave:open-guide',
  openDashboard: 'courseweave:open-dashboard',
  openAuthor: 'courseweave:open-author',
  shareSelection: 'courseweave:share-selection',
  shareCell: 'courseweave:share-cell',
  shareOutput: 'courseweave:share-output'
} as const;

export const COURSEWEAVE_PALETTE_CATEGORY = 'CourseWeave';

export function registerCoursePalette(
  palette: { addItem(options: { command: string; category: string }): unknown }
): void {
  const registered = new Set<string>();
  for (const command of Object.values(COURSEWEAVE_COMMANDS)) {
    if (registered.has(command)) continue;
    registered.add(command);
    palette.addItem({ command, category: COURSEWEAVE_PALETTE_CATEGORY });
  }
}

export function registerCourseCommands(
  commands: { addCommand(id: string, options: { label: string; execute(): unknown }): void },
  actions: { openGuide(): unknown; openDashboard(): unknown; openAuthor(): unknown; requestShare(kind: 'selection' | 'cell' | 'output'): unknown }
): void {
  commands.addCommand(COURSEWEAVE_COMMANDS.openGuide, { label: 'Open CourseWeave Guide', execute: actions.openGuide });
  commands.addCommand(COURSEWEAVE_COMMANDS.openDashboard, { label: 'Open CourseWeave Dashboard', execute: actions.openDashboard });
  commands.addCommand(COURSEWEAVE_COMMANDS.openAuthor, { label: 'Open CourseWeave Author', execute: actions.openAuthor });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareSelection, { label: 'Share Selection with CourseWeave', execute: () => actions.requestShare('selection') });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareCell, { label: 'Share Cell with CourseWeave', execute: () => actions.requestShare('cell') });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareOutput, { label: 'Share Output with CourseWeave', execute: () => actions.requestShare('output') });
}

class ReaderWidget extends Widget {
  readonly iframe: HTMLIFrameElement;

  constructor() {
    const node = document.createElement('div');
    const iframe = document.createElement('iframe');
    iframe.title = 'CourseWeave reader';
    iframe.referrerPolicy = 'no-referrer';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-presentation');
    node.appendChild(iframe);
    super({ node });
    this.iframe = iframe;
    this.id = 'courseweave-reader';
    this.title.label = 'Course reader';
    this.title.closable = true;
  }
}

class IframeWidget extends Widget {
  readonly iframe: HTMLIFrameElement;

  constructor(id: string, title: string, src: string) {
    const node = document.createElement('div');
    const iframe = document.createElement('iframe');
    iframe.title = title;
    iframe.src = src;
    iframe.referrerPolicy = 'origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    node.appendChild(iframe);
    super({ node });
    this.iframe = iframe;
    this.id = id;
    this.title.label = title;
    this.title.closable = true;
  }
}

class DashboardWidget extends Widget {
  constructor(course: CourseSnapshot, private readonly open: (coordinate: SurfaceCoordinate) => Promise<unknown>) {
    super({ node: document.createElement('div') });
    this.id = 'courseweave-dashboard';
    this.title.label = 'Course dashboard';
    this.title.closable = true;
    this.updateCourse(course);
  }

  updateCourse(course: CourseSnapshot): void {
    this.node.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = course.title;
    this.node.appendChild(heading);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    for (const module of course.modules) {
      for (const phase of module.phases) {
        for (const surface of phase.surfaces) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = surface.label ?? surface.id;
          button.addEventListener('click', () => {
            void this.open({ moduleId: module.id, phaseId: phase.id, surfaceId: surface.id }).catch(() => {
              status.textContent = 'CourseWeave backend unavailable. Retry after restarting the service.';
            });
          });
          this.node.appendChild(button);
        }
      }
    }
    this.node.appendChild(status);
  }
}

export class CourseSurfaceFactory {
  private course: CourseSnapshot | null = null;
  private reader: ReaderWidget | null = null;
  private dashboard: DashboardWidget | null = null;
  private author: IframeWidget | null = null;
  private readonly terminals = new Map<string, Widget>();
  private readonly terminalFlights = new Map<string, Promise<SurfaceMainAreaWidget>>();
  private readonly metadata = new WeakMap<object, SurfaceMetadata>();
  private readonly jupyterBaseUrl: string;

  constructor(private readonly options: CourseSurfaceFactoryOptions) {
    this.jupyterBaseUrl = canonicalJupyterBaseUrl(options.jupyterOrigin, options.baseUrl);
  }

  setCourse(course: CourseSnapshot): void {
    this.course = course;
    if (this.dashboard !== null && !this.dashboard.isDisposed) this.dashboard.updateCourse(course);
  }

  private lookup(coordinate: SurfaceCoordinate): CourseSurface {
    const surface = this.course?.modules.find((item) => item.id === coordinate.moduleId)
      ?.phases.find((item) => item.id === coordinate.phaseId)
      ?.surfaces.find((item) => item.id === coordinate.surfaceId);
    if (surface === undefined) throw new Error('Surface is not allowlisted.');
    return surface;
  }

  private activate(widget: Widget): void {
    this.options.shell.activateById(widget.id);
  }

  private nativeDocument(path: string | undefined, factory: string, surface: SurfaceType): Widget {
    if (path === undefined) throw new Error('Surface path is missing.');
    safeRelativePath(path);
    const widget = this.options.documents.openOrReveal(path, factory);
    if (widget === undefined) throw new Error('Native surface unavailable.');
    this.metadata.set(widget, { activePath: path, surfaceKind: surface, terminalSurfaceId: null, explicitModuleId: null, explicitPhaseId: null });
    this.activate(widget);
    return widget;
  }

  private createTerminal(key: string, coordinate: SurfaceCoordinate, surface: CourseSurface): Promise<SurfaceMainAreaWidget> {
    const instructions = terminalInstructions(surface, this.options.writeClipboard ?? writeBrowserClipboard);
    const creation = this.options.commands.execute('terminal:create-new', {
      name: `courseweave-${coordinate.moduleId}-${coordinate.phaseId}-${surface.id}`
    }).then((created) => {
      const widget = mainAreaWidget(created);
      widget.contentHeader.addWidget(instructions);
      this.terminals.set(key, widget);
      widget.disposed.connect(() => {
        instructions.dispose();
        if (this.terminals.get(key) === widget) this.terminals.delete(key);
      });
      return widget;
    }).catch((error: unknown) => {
      instructions.dispose();
      throw error;
    });
    this.terminalFlights.set(key, creation);
    void creation.then(() => {
      if (this.terminalFlights.get(key) === creation) this.terminalFlights.delete(key);
    }, () => {
      if (this.terminalFlights.get(key) === creation) this.terminalFlights.delete(key);
    });
    return creation;
  }

  async open(coordinate: SurfaceCoordinate): Promise<SurfaceOpenResult> {
    const surface = this.lookup(coordinate);
    if (surface.type === 'markdown') {
      this.nativeDocument(surface.path, 'Markdown Preview', 'markdown');
      return { htmlSource: null, jupyterBaseUrl: this.jupyterBaseUrl, terminalSurfaceId: null };
    }
    if (surface.type === 'notebook') {
      this.nativeDocument(surface.path, 'Notebook', 'notebook');
      return { htmlSource: null, jupyterBaseUrl: this.jupyterBaseUrl, terminalSurfaceId: null };
    }
    if (surface.type === 'source') {
      this.nativeDocument(surface.path, 'Editor', 'source');
      return { htmlSource: null, jupyterBaseUrl: this.jupyterBaseUrl, terminalSurfaceId: null };
    }
    if (surface.type === 'terminal') {
      if (surface.cwd !== undefined && surface.cwd !== '.') safeRelativePath(surface.cwd);
      const key = `${coordinate.moduleId}/${coordinate.phaseId}/${surface.id}`;
      let widget = this.terminals.get(key);
      if (widget === undefined || widget.isDisposed) {
        widget = await (this.terminalFlights.get(key) ?? this.createTerminal(key, coordinate, surface));
      }
      this.metadata.set(widget, { activePath: null, surfaceKind: 'terminal', terminalSurfaceId: surface.id, explicitModuleId: coordinate.moduleId, explicitPhaseId: coordinate.phaseId });
      this.activate(widget);
      return { htmlSource: null, jupyterBaseUrl: this.jupyterBaseUrl, terminalSurfaceId: surface.id };
    }
    if (surface.type === 'html' || surface.type === 'video') {
      const source = surface.type === 'html'
        ? localReaderUrl(surface.path ?? '', this.options.jupyterOrigin, this.options.baseUrl)
        : videoUrl(surface.url);
      if (this.reader === null || this.reader.isDisposed) {
        this.reader = new ReaderWidget();
        this.options.shell.add(this.reader, 'main', { type: 'CourseWeave' });
      }
      this.reader.iframe.src = source;
      this.metadata.set(this.reader, { activePath: surface.type === 'html' ? surface.path ?? null : null, surfaceKind: surface.type, terminalSurfaceId: null, explicitModuleId: coordinate.moduleId, explicitPhaseId: coordinate.phaseId });
      this.activate(this.reader);
      return { htmlSource: source, jupyterBaseUrl: this.jupyterBaseUrl, terminalSurfaceId: null };
    }
    throw new Error('Surface type is not supported.');
  }

  openDashboard(): Widget {
    if (this.course === null) throw new Error('Course unavailable.');
    if (this.dashboard === null || this.dashboard.isDisposed) {
      this.dashboard = new DashboardWidget(this.course, (coordinate) => this.open(coordinate));
      this.options.shell.add(this.dashboard, 'main', { type: 'CourseWeave' });
    }
    this.metadata.set(this.dashboard, { activePath: null, surfaceKind: null, terminalSurfaceId: null, explicitModuleId: null, explicitPhaseId: null });
    this.activate(this.dashboard);
    return this.dashboard;
  }

  openAuthor(): Widget {
    if (this.author === null || this.author.isDisposed) {
      this.author = new IframeWidget('courseweave-author', 'CourseWeave author', `${this.options.serviceOrigin}/author/`);
      this.options.beforeAuthorAttach?.(this.author, this.author.iframe);
      this.options.shell.add(this.author, 'main', { type: 'CourseWeave' });
    }
    this.activate(this.author);
    return this.author;
  }

  metadataFor(widget: object | null): SurfaceMetadata | null {
    return widget === null ? null : this.metadata.get(widget) ?? null;
  }
}

export class SurfaceRequestBroker {
  private listening = false;
  private readonly flights = new Set<string>();

  constructor(private readonly options: {
    hostWindow: Window;
    childWindow: Window;
    serviceOrigin: string;
    sourceId: string;
    factory: Pick<CourseSurfaceFactory, 'open'>;
  }) {}

  private readonly listener = (event: MessageEvent<unknown>): void => {
    if (!this.listening || event.source !== this.options.childWindow || event.origin !== this.options.serviceOrigin) return;
    const request = parseOpenSurfaceRequest(event.data);
    if (request === null) return;
    const key = `${request.moduleId}/${request.phaseId}/${request.surfaceId}`;
    if (this.flights.has(key)) return;
    this.flights.add(key);
    void this.options.factory.open(request).then((result) => {
      if (!this.listening) return;
      this.options.childWindow.postMessage({
        type: 'courseweave.reader.opened.v1',
        sourceId: this.options.sourceId,
        moduleId: request.moduleId,
        phaseId: request.phaseId,
        surfaceId: request.surfaceId,
        jupyterBaseUrl: result.jupyterBaseUrl,
        htmlSource: result.htmlSource
      }, this.options.serviceOrigin);
    }).catch(() => undefined).finally(() => this.flights.delete(key));
  };

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.hostWindow.addEventListener('message', this.listener);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.hostWindow.removeEventListener('message', this.listener);
    this.flights.clear();
  }
}
