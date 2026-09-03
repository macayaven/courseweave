"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SurfaceRequestBroker = exports.CourseSurfaceFactory = exports.COURSEWEAVE_COMMANDS = void 0;
exports.parseCourseSnapshot = parseCourseSnapshot;
exports.localReaderUrl = localReaderUrl;
exports.canonicalJupyterBaseUrl = canonicalJupyterBaseUrl;
exports.coordinateForCoursePath = coordinateForCoursePath;
exports.registerCourseCommands = registerCourseCommands;
const widgets_1 = require("@lumino/widgets");
const protocol_1 = require("./protocol");
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonBlank(value, max = 1024) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
}
function validSurface(value) {
    if (!record(value) || !nonBlank(value.id, 80))
        return false;
    if (!['html', 'markdown', 'video', 'notebook', 'source', 'terminal', 'external'].includes(String(value.type)))
        return false;
    if (['html', 'markdown', 'notebook', 'source'].includes(String(value.type)) && !nonBlank(value.path))
        return false;
    if (value.path !== undefined && !nonBlank(value.path))
        return false;
    if (value.url !== undefined && !nonBlank(value.url, 4096))
        return false;
    if (value.cwd !== undefined && !nonBlank(value.cwd))
        return false;
    if (value.argv !== undefined && (!Array.isArray(value.argv) || value.argv.some((item) => !nonBlank(item, 4096))))
        return false;
    return true;
}
function parseCourseSnapshot(value) {
    if (!record(value) || !nonBlank(value.id, 80) || !nonBlank(value.title, 240))
        return null;
    if (!record(value.policies) || !Number.isInteger(value.policies.max_shared_chars) || value.policies.max_shared_chars < 1 || value.policies.max_shared_chars > 131072)
        return null;
    if (!Array.isArray(value.modules))
        return null;
    const moduleIds = new Set();
    for (const module of value.modules) {
        if (!record(module) || !nonBlank(module.id, 80) || !nonBlank(module.title, 240) || moduleIds.has(module.id) || !Array.isArray(module.phases))
            return null;
        moduleIds.add(module.id);
        const phaseIds = new Set();
        for (const phase of module.phases) {
            if (!record(phase) || !nonBlank(phase.id, 80) || !nonBlank(phase.title, 240) || phaseIds.has(phase.id) || !record(phase.capabilities) || !Array.isArray(phase.surfaces))
                return null;
            if (typeof phase.capabilities.share_selection !== 'boolean' || typeof phase.capabilities.share_cell !== 'boolean' || typeof phase.capabilities.share_output !== 'boolean')
                return null;
            phaseIds.add(phase.id);
            const surfaceIds = new Set();
            for (const surface of phase.surfaces) {
                if (!validSurface(surface) || surfaceIds.has(surface.id))
                    return null;
                surfaceIds.add(surface.id);
            }
        }
    }
    return value;
}
function canonicalOrigin(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error('invalid Jupyter origin');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value)
        throw new Error('invalid Jupyter origin');
    return parsed.origin;
}
function safeRelativePath(path) {
    if (!nonBlank(path) || path.startsWith('/') || path.includes('\\') || path.includes('%') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))
        throw new Error('unsafe course path');
    const segments = path.split('/');
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'))
        throw new Error('unsafe course path');
    return segments.map((segment) => encodeURIComponent(segment)).join('/');
}
function localReaderUrl(path, jupyterOrigin, baseUrl) {
    return new URL(`files/${safeRelativePath(path)}`, canonicalJupyterBaseUrl(jupyterOrigin, baseUrl)).href;
}
function canonicalJupyterBaseUrl(jupyterOrigin, baseUrl) {
    const origin = canonicalOrigin(jupyterOrigin);
    let base;
    try {
        base = new URL(baseUrl, `${origin}/`);
    }
    catch {
        throw new Error('invalid Jupyter base URL');
    }
    if (base.origin !== origin || base.username || base.password || base.search || base.hash)
        throw new Error('invalid Jupyter base URL');
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const segments = basePath.split('/').slice(1, -1);
    if (basePath.includes('%') || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || segment === 'files'))
        throw new Error('invalid Jupyter base URL');
    return `${origin}${basePath}`;
}
function videoUrl(value) {
    if (value === undefined || value.trim() !== value)
        throw new Error('invalid video URL');
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error('invalid video URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.href !== value)
        throw new Error('invalid video URL');
    return parsed.href;
}
function coordinateForCoursePath(course, path) {
    try {
        safeRelativePath(path);
    }
    catch {
        return null;
    }
    const matches = new Map();
    for (const module of course.modules) {
        for (const phase of module.phases) {
            if (phase.surfaces.some((surface) => surface.path === path)) {
                matches.set(`${module.id}/${phase.id}`, { moduleId: module.id, phaseId: phase.id });
            }
        }
    }
    return matches.size === 1 ? matches.values().next().value ?? null : null;
}
exports.COURSEWEAVE_COMMANDS = {
    openGuide: 'courseweave:open-guide',
    openDashboard: 'courseweave:open-dashboard',
    openAuthor: 'courseweave:open-author',
    shareSelection: 'courseweave:share-selection',
    shareCell: 'courseweave:share-cell',
    shareOutput: 'courseweave:share-output'
};
function registerCourseCommands(commands, actions) {
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.openGuide, { label: 'Open CourseWeave Guide', execute: actions.openGuide });
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.openDashboard, { label: 'Open CourseWeave Dashboard', execute: actions.openDashboard });
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.openAuthor, { label: 'Open CourseWeave Author', execute: actions.openAuthor });
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.shareSelection, { label: 'Share Selection with CourseWeave', execute: () => actions.requestShare('selection') });
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.shareCell, { label: 'Share Cell with CourseWeave', execute: () => actions.requestShare('cell') });
    commands.addCommand(exports.COURSEWEAVE_COMMANDS.shareOutput, { label: 'Share Output with CourseWeave', execute: () => actions.requestShare('output') });
}
class ReaderWidget extends widgets_1.Widget {
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
class IframeWidget extends widgets_1.Widget {
    constructor(id, title, src) {
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
class DashboardWidget extends widgets_1.Widget {
    constructor(course, open) {
        super({ node: document.createElement('div') });
        this.open = open;
        this.id = 'courseweave-dashboard';
        this.title.label = 'Course dashboard';
        this.title.closable = true;
        this.updateCourse(course);
    }
    updateCourse(course) {
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
class CourseSurfaceFactory {
    constructor(options) {
        this.options = options;
        this.course = null;
        this.reader = null;
        this.dashboard = null;
        this.author = null;
        this.terminals = new Map();
        this.metadata = new WeakMap();
        this.jupyterBaseUrl = canonicalJupyterBaseUrl(options.jupyterOrigin, options.baseUrl);
    }
    setCourse(course) {
        this.course = course;
        if (this.dashboard !== null && !this.dashboard.isDisposed)
            this.dashboard.updateCourse(course);
    }
    lookup(coordinate) {
        const surface = this.course?.modules.find((item) => item.id === coordinate.moduleId)
            ?.phases.find((item) => item.id === coordinate.phaseId)
            ?.surfaces.find((item) => item.id === coordinate.surfaceId);
        if (surface === undefined)
            throw new Error('Surface is not allowlisted.');
        return surface;
    }
    activate(widget) {
        this.options.shell.activateById(widget.id);
    }
    nativeDocument(path, factory, surface) {
        if (path === undefined)
            throw new Error('Surface path is missing.');
        safeRelativePath(path);
        const widget = this.options.documents.openOrReveal(path, factory);
        if (widget === undefined)
            throw new Error('Native surface unavailable.');
        this.metadata.set(widget, { activePath: path, surfaceKind: surface, terminalSurfaceId: null, explicitModuleId: null, explicitPhaseId: null });
        this.activate(widget);
        return widget;
    }
    async open(coordinate) {
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
            if (surface.cwd !== undefined && surface.cwd !== '.')
                safeRelativePath(surface.cwd);
            const key = `${coordinate.moduleId}/${coordinate.phaseId}/${surface.id}`;
            let widget = this.terminals.get(key);
            if (widget === undefined || widget.isDisposed) {
                const created = await this.options.commands.execute('terminal:create-new', {
                    name: `courseweave-${coordinate.moduleId}-${coordinate.phaseId}-${surface.id}`,
                    ...(surface.cwd === undefined ? {} : { cwd: surface.cwd })
                });
                if (!(created instanceof widgets_1.Widget) && (!record(created) || !nonBlank(created.id)))
                    throw new Error('Native terminal unavailable.');
                widget = created;
                this.terminals.set(key, widget);
                widget.disposed.connect(() => {
                    if (this.terminals.get(key) === widget)
                        this.terminals.delete(key);
                });
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
    openDashboard() {
        if (this.course === null)
            throw new Error('Course unavailable.');
        if (this.dashboard === null || this.dashboard.isDisposed) {
            this.dashboard = new DashboardWidget(this.course, (coordinate) => this.open(coordinate));
            this.options.shell.add(this.dashboard, 'main', { type: 'CourseWeave' });
        }
        this.metadata.set(this.dashboard, { activePath: null, surfaceKind: null, terminalSurfaceId: null, explicitModuleId: null, explicitPhaseId: null });
        this.activate(this.dashboard);
        return this.dashboard;
    }
    openAuthor() {
        if (this.author === null || this.author.isDisposed) {
            this.author = new IframeWidget('courseweave-author', 'CourseWeave author', `${this.options.serviceOrigin}/author/`);
            this.options.beforeAuthorAttach?.(this.author, this.author.iframe);
            this.options.shell.add(this.author, 'main', { type: 'CourseWeave' });
        }
        this.activate(this.author);
        return this.author;
    }
    metadataFor(widget) {
        return widget === null ? null : this.metadata.get(widget) ?? null;
    }
}
exports.CourseSurfaceFactory = CourseSurfaceFactory;
class SurfaceRequestBroker {
    constructor(options) {
        this.options = options;
        this.listening = false;
        this.flights = new Set();
        this.listener = (event) => {
            if (!this.listening || event.source !== this.options.childWindow || event.origin !== this.options.serviceOrigin)
                return;
            const request = (0, protocol_1.parseOpenSurfaceRequest)(event.data);
            if (request === null)
                return;
            const key = `${request.moduleId}/${request.phaseId}/${request.surfaceId}`;
            if (this.flights.has(key))
                return;
            this.flights.add(key);
            void this.options.factory.open(request).then((result) => {
                if (!this.listening)
                    return;
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
    }
    start() {
        if (this.listening)
            return;
        this.listening = true;
        this.options.hostWindow.addEventListener('message', this.listener);
    }
    dispose() {
        if (!this.listening)
            return;
        this.listening = false;
        this.options.hostWindow.removeEventListener('message', this.listener);
        this.flights.clear();
    }
}
exports.SurfaceRequestBroker = SurfaceRequestBroker;
