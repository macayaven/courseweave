"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * CourseWeave JupyterLab bridge.
 *
 * A prebuilt JupyterLab 4 extension with no React. It opens exactly one
 * sandboxed iframe hosting the CourseWeave guide rail served by the local
 * loopback CourseWeave service, opens allowlisted course surfaces through
 * native Jupyter APIs, and ignores untrusted child messages (design spec §12).
 */
const application_1 = require("@jupyterlab/application");
const coreutils_1 = require("@jupyterlab/coreutils");
const docmanager_1 = require("@jupyterlab/docmanager");
const fileeditor_1 = require("@jupyterlab/fileeditor");
const notebook_1 = require("@jupyterlab/notebook");
const settingregistry_1 = require("@jupyterlab/settingregistry");
const terminal_1 = require("@jupyterlab/terminal");
const widgets_1 = require("@lumino/widgets");
const context_1 = require("./context");
const protocol_1 = require("./protocol");
const runtime_1 = require("./runtime");
const share_1 = require("./share");
const surfaces_1 = require("./surfaces");
/**
 * Runtime plugin identity. JupyterLab-server derives the settings plugin ID
 * from the shipped schema path, so this must stay aligned exactly:
 * `@courseweave/lab:plugin` ↔ `schemas/@courseweave/lab/plugin.json`.
 */
const PLUGIN_ID = '@courseweave/lab:plugin';
const GUIDE_WIDGET_ID = 'courseweave-guide';
/**
 * Non-persisted page-config option carrying the CourseWeave service URL.
 * Task 6 injects it into the authenticated Jupyter server page configuration
 * from the `COURSEWEAVE_URL` environment variable of the owned child process;
 * nothing is read from disk. Resolution priority 1.
 */
const SERVICE_URL_OPTION = 'courseweaveServiceUrl';
/**
 * Plugin setting key for manual Task 0 custom-port configuration, read via
 * `ISettingRegistry` from this plugin's shipped schema. Resolution priority 2.
 */
const SERVICE_ORIGIN_SETTING = 'serviceOrigin';
/** Loopback fallback used only when both higher priorities are unset. */
const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:8765';
/**
 * Resolve the service origin, in required priority order:
 *
 * 1. non-empty `courseweaveServiceUrl` page-config option (future automatic
 *    launch injection),
 * 2. non-empty `serviceOrigin` from this plugin's setting schema (manual
 *    custom-port configuration; the schema default flows through here too),
 * 3. the loopback default.
 *
 * The capability token is server-side state and never appears in the iframe
 * URL.
 */
async function resolveServiceOrigin(registry) {
    const fromPageConfig = coreutils_1.PageConfig.getOption(SERVICE_URL_OPTION).replace(/\/+$/, '');
    if (fromPageConfig) {
        return fromPageConfig;
    }
    if (registry !== null) {
        try {
            const settings = await registry.load(PLUGIN_ID);
            const composite = settings.get(SERVICE_ORIGIN_SETTING).composite;
            const fromSettings = typeof composite === 'string' ? composite.replace(/\/+$/, '') : '';
            if (fromSettings) {
                return fromSettings;
            }
        }
        catch (error) {
            console.warn('CourseWeave bridge: settings unavailable, using the loopback default origin.', error);
        }
    }
    return DEFAULT_SERVICE_ORIGIN;
}
/**
 * Preserve the Task 0 activation-order guard while removing its broad message
 * listener. RuntimeBroker installs the only listener after an owned iframe
 * exists; this preflight makes fallback/manual origins fail closed first.
 */
function installOriginGuard(serviceOrigin) {
    try {
        const parsed = new URL(serviceOrigin);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            || parsed.username.length > 0
            || parsed.password.length > 0
            || parsed.origin !== serviceOrigin)
            throw new Error();
    }
    catch {
        throw new Error('CourseWeave bridge service origin is invalid.');
    }
}
/**
 * The sandboxed guide iframe. `allow-scripts` and `allow-same-origin` let the
 * embedded learner application talk to its own service origin (the capability
 * token never appears in the iframe URL).
 */
class CourseWeaveGuide extends widgets_1.Widget {
    constructor(serviceOrigin) {
        const node = document.createElement('div');
        node.classList.add('cw-Guide');
        const iframe = (0, runtime_1.createCourseWeaveIframe)(serviceOrigin, 'learn');
        node.appendChild(iframe);
        super({ node });
        this.iframe = iframe;
        this.id = GUIDE_WIDGET_ID;
        this.title.label = 'CourseWeave';
        this.title.caption = 'CourseWeave guide rail';
        this.addClass('cw-Guide-host');
    }
}
const plugin = {
    id: PLUGIN_ID,
    description: 'CourseWeave guide, dashboard, native course surfaces, context, and explicit Share bridge.',
    autoStart: true,
    requires: [application_1.ILabShell, docmanager_1.IDocumentManager, fileeditor_1.IEditorTracker, notebook_1.INotebookTracker, terminal_1.ITerminalTracker],
    optional: [settingregistry_1.ISettingRegistry],
    activate: async (app, shell, documents, editor, notebook, terminal, registry) => {
        // Resolve the service origin BEFORE anything can create a guide: there
        // must be no window in which the command would open a default-origin
        // guide while a custom origin is still resolving.
        const launch = (0, protocol_1.parseLaunchConfiguration)(coreutils_1.PageConfig.getOption);
        const serviceOrigin = launch?.serviceOrigin ?? await resolveServiceOrigin(registry);
        const launchMode = launch?.launchMode ?? 'learn';
        const relay = launch === null ? null : new runtime_1.CourseWeaveRelayClient(serviceOrigin);
        const sourceId = crypto.randomUUID();
        let attachRuntime = () => undefined;
        const factory = new surfaces_1.CourseSurfaceFactory({
            shell,
            documents,
            commands: app.commands,
            serviceOrigin,
            jupyterOrigin: window.location.origin,
            baseUrl: coreutils_1.PageConfig.getBaseUrl(),
            beforeAuthorAttach: (widget, iframe) => attachRuntime(widget, iframe)
        });
        let course = null;
        let guide = null;
        let surfaceBroker = null;
        let captureProvider = null;
        let publisher = null;
        let observer = null;
        const runtimeBrokers = new Map();
        const showRecovery = () => {
            if (guide === null || guide.isDisposed)
                return;
            let status = guide.node.querySelector('[data-courseweave-recovery]');
            if (status === null) {
                status = document.createElement('p');
                status.dataset.courseweaveRecovery = 'true';
                status.setAttribute('role', 'status');
                guide.node.appendChild(status);
            }
            status.textContent = 'CourseWeave backend unavailable. Retry from the CourseWeave command after restarting the service.';
        };
        const clearRecovery = () => {
            guide?.node.querySelector('[data-courseweave-recovery]')?.remove();
        };
        const refreshCourse = async () => {
            if (relay === null)
                throw new Error('Course relay unavailable.');
            const response = await relay.getCourse();
            if (!response.ok)
                throw new Error('Course relay unavailable.');
            const next = (0, surfaces_1.parseCourseSnapshot)(await response.json());
            if (next === null)
                throw new Error('Course relay returned an invalid manifest.');
            course = next;
            factory.setCourse(next);
            clearRecovery();
            return next;
        };
        attachRuntime = (widget, iframe, beforeReply) => {
            if (launch === null || relay === null || runtimeBrokers.has(widget))
                return;
            const runtimeBroker = new runtime_1.RuntimeBroker({
                hostWindow: window,
                iframe,
                serviceOrigin,
                runtimeId: launch.runtimeId,
                sourceId,
                relay,
                beforeReply
            });
            runtimeBroker.start();
            runtimeBrokers.set(widget, runtimeBroker);
            widget.disposed.connect(() => {
                runtimeBroker.dispose();
                runtimeBrokers.delete(widget);
            });
        };
        const observeContext = (childWindow) => {
            if (relay === null)
                return;
            if (publisher === null) {
                publisher = new context_1.ContextPublisher({ sourceId, relay, childWindow, serviceOrigin, onRecovery: showRecovery });
            }
            else {
                publisher.setChildWindow(childWindow);
                void publisher.retry();
            }
            observer?.dispose();
            observer = new context_1.ContextObserver({
                shell,
                notebook,
                editor,
                terminal,
                surfaceMetadata: (widget) => factory.metadataFor(widget),
                publisher
            });
            observer.start();
        };
        const attachGuideBridges = (widget, iframe) => {
            let attached = false;
            return (childWindow) => {
                if (attached
                    || widget.isDisposed
                    || guide !== widget
                    || iframe.contentWindow !== childWindow)
                    return;
                attached = true;
                surfaceBroker = new surfaces_1.SurfaceRequestBroker({
                    hostWindow: window,
                    childWindow,
                    serviceOrigin,
                    sourceId,
                    factory
                });
                surfaceBroker.start();
                captureProvider = new share_1.LabCaptureProvider({
                    hostWindow: window,
                    childWindow,
                    serviceOrigin,
                    course: () => course,
                    activeCoordinate: () => publisher?.acceptedCoordinate() ?? null,
                    activeWidget: () => shell.currentWidget,
                    notebook,
                    editor,
                    terminal
                });
                captureProvider.start();
                observeContext(childWindow);
            };
        };
        const openGuide = () => {
            let current = guide;
            if (current === null || current.isDisposed) {
                current = new CourseWeaveGuide(serviceOrigin);
                const widget = current;
                // Clear the tracked reference when the widget is closed/disposed so
                // the command recreates the guide instead of touching a disposed
                // widget.
                widget.disposed.connect(() => {
                    if (guide === widget) {
                        surfaceBroker?.dispose();
                        captureProvider?.dispose();
                        observer?.dispose();
                        surfaceBroker = null;
                        captureProvider = null;
                        observer = null;
                        guide = null;
                    }
                });
                guide = current;
                current.title.closable = true;
                attachRuntime(widget, current.iframe, attachGuideBridges(widget, current.iframe));
                shell.add(current, 'right', { rank: 900 });
            }
            shell.activateById(current.id);
        };
        const openDashboard = async () => {
            try {
                await refreshCourse();
                factory.openDashboard();
            }
            catch {
                showRecovery();
            }
        };
        const openAuthor = () => {
            factory.openAuthor();
        };
        (0, surfaces_1.registerCourseCommands)({
            addCommand: (id, options) => app.commands.addCommand(id, options)
        }, {
            openGuide,
            openDashboard,
            openAuthor,
            requestShare: () => openGuide()
        });
        installOriginGuard(serviceOrigin);
        try {
            await refreshCourse();
        }
        catch {
            // Runtime/guide recovery remains available while normal JupyterLab stays usable.
        }
        if (launchMode === 'author')
            openAuthor();
        else
            openGuide();
    }
};
exports.default = plugin;
