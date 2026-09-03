/**
 * CourseWeave JupyterLab bridge.
 *
 * A prebuilt JupyterLab 4 extension with no React. It opens exactly one
 * sandboxed iframe hosting the CourseWeave guide rail served by the local
 * loopback CourseWeave service, opens allowlisted course surfaces through
 * native Jupyter APIs, and ignores untrusted child messages (design spec §12).
 */
import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette } from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IEditorTracker } from '@jupyterlab/fileeditor';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminalTracker } from '@jupyterlab/terminal';
import { Widget } from '@lumino/widgets';
import { ContextObserver, ContextPublisher } from './context';
import { parseLaunchConfiguration } from './protocol';
import { CourseWeaveRelayClient, RuntimeBroker, createCourseWeaveIframe } from './runtime';
import { LabCaptureProvider } from './share';
import {
  CourseSurfaceFactory,
  SurfaceRequestBroker,
  parseCourseSnapshot,
  registerCoursePalette,
  registerCourseCommands,
  type CourseSnapshot
} from './surfaces';

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
async function resolveServiceOrigin(
  registry: ISettingRegistry | null
): Promise<string> {
  const fromPageConfig = PageConfig.getOption(SERVICE_URL_OPTION).replace(
    /\/+$/,
    ''
  );
  if (fromPageConfig) {
    return fromPageConfig;
  }
  if (registry !== null) {
    try {
      const settings = await registry.load(PLUGIN_ID);
      const composite = settings.get(SERVICE_ORIGIN_SETTING).composite;
      const fromSettings =
        typeof composite === 'string' ? composite.replace(/\/+$/, '') : '';
      if (fromSettings) {
        return fromSettings;
      }
    } catch (error) {
      console.warn(
        'CourseWeave bridge: settings unavailable, using the loopback default origin.',
        error
      );
    }
  }
  return DEFAULT_SERVICE_ORIGIN;
}

/**
 * Preserve the Task 0 activation-order guard while removing its broad message
 * listener. RuntimeBroker installs the only listener after an owned iframe
 * exists; this preflight makes fallback/manual origins fail closed first.
 */
function installOriginGuard(serviceOrigin: string): void {
  try {
    const parsed = new URL(serviceOrigin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.origin !== serviceOrigin
    ) throw new Error();
  } catch {
    throw new Error('CourseWeave bridge service origin is invalid.');
  }
}

/**
 * The sandboxed guide iframe. `allow-scripts` and `allow-same-origin` let the
 * embedded learner application talk to its own service origin (the capability
 * token never appears in the iframe URL).
 */
class CourseWeaveGuide extends Widget {
  readonly iframe: HTMLIFrameElement;

  constructor(serviceOrigin: string) {
    const node = document.createElement('div');
    node.classList.add('cw-Guide');

    const iframe = createCourseWeaveIframe(serviceOrigin, 'learn');
    node.appendChild(iframe);

    super({ node });
    this.iframe = iframe;
    this.id = GUIDE_WIDGET_ID;
    this.title.label = 'CourseWeave';
    this.title.caption = 'CourseWeave guide rail';
    this.addClass('cw-Guide-host');
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'CourseWeave guide, dashboard, native course surfaces, context, and explicit Share bridge.',
  autoStart: true,
  requires: [ILabShell, ICommandPalette, IDocumentManager, IEditorTracker, INotebookTracker, ITerminalTracker],
  optional: [ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    shell: ILabShell,
    palette: ICommandPalette,
    documents: IDocumentManager,
    editor: IEditorTracker,
    notebook: INotebookTracker,
    terminal: ITerminalTracker,
    registry: ISettingRegistry | null
  ): Promise<void> => {
    // Resolve the service origin BEFORE anything can create a guide: there
    // must be no window in which the command would open a default-origin
    // guide while a custom origin is still resolving.
    const launch = parseLaunchConfiguration(PageConfig.getOption);
    const serviceOrigin = launch?.serviceOrigin ?? await resolveServiceOrigin(registry);
    const launchMode = launch?.launchMode ?? 'learn';
    const relay = launch === null ? null : new CourseWeaveRelayClient(serviceOrigin);
    const sourceId = crypto.randomUUID();
    let attachRuntime: (
      widget: Widget,
      iframe: HTMLIFrameElement,
      beforeReply?: (childWindow: Window) => void
    ) => void = () => undefined;
    const factory = new CourseSurfaceFactory({
      shell,
      documents,
      commands: app.commands,
      serviceOrigin,
      jupyterOrigin: window.location.origin,
      baseUrl: PageConfig.getBaseUrl(),
      beforeAuthorAttach: (widget, iframe) => attachRuntime(widget, iframe)
    });
    let course: CourseSnapshot | null = null;
    let guide: CourseWeaveGuide | null = null;
    let surfaceBroker: SurfaceRequestBroker | null = null;
    let captureProvider: LabCaptureProvider | null = null;
    let publisher: ContextPublisher | null = null;
    let observer: ContextObserver | null = null;
    const runtimeBrokers = new Map<Widget, RuntimeBroker>();

    const showRecovery = (): void => {
      if (guide === null || guide.isDisposed) return;
      let status = guide.node.querySelector<HTMLElement>('[data-courseweave-recovery]');
      if (status === null) {
        status = document.createElement('p');
        status.dataset.courseweaveRecovery = 'true';
        status.setAttribute('role', 'status');
        guide.node.appendChild(status);
      }
      status.textContent = 'CourseWeave backend unavailable. Retry from the CourseWeave command after restarting the service.';
    };

    const clearRecovery = (): void => {
      guide?.node.querySelector('[data-courseweave-recovery]')?.remove();
    };

    const refreshCourse = async (): Promise<CourseSnapshot> => {
      if (relay === null) throw new Error('Course relay unavailable.');
      const response = await relay.getCourse();
      if (!response.ok) throw new Error('Course relay unavailable.');
      const next = parseCourseSnapshot(await response.json());
      if (next === null) throw new Error('Course relay returned an invalid manifest.');
      course = next;
      factory.setCourse(next);
      clearRecovery();
      return next;
    };

    attachRuntime = (
      widget: Widget,
      iframe: HTMLIFrameElement,
      beforeReply?: (childWindow: Window) => void
    ): void => {
      if (launch === null || relay === null || runtimeBrokers.has(widget)) return;
      const runtimeBroker = new RuntimeBroker({
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

    const observeContext = (childWindow: Window): void => {
      if (relay === null) return;
      if (publisher === null) {
        publisher = new ContextPublisher({ sourceId, relay, childWindow, serviceOrigin, onRecovery: showRecovery });
      } else {
        publisher.setChildWindow(childWindow);
        void publisher.retry();
      }
      observer?.dispose();
      observer = new ContextObserver({
        shell,
        notebook,
        editor,
        terminal,
        surfaceMetadata: (widget) => factory.metadataFor(widget),
        publisher
      });
      observer.start();
    };

    const attachGuideBridges = (
      widget: CourseWeaveGuide,
      iframe: HTMLIFrameElement
    ): ((childWindow: Window) => void) => {
      let attached = false;
      return (childWindow: Window): void => {
        if (
          attached
          || widget.isDisposed
          || guide !== widget
          || iframe.contentWindow !== childWindow
        ) return;
        attached = true;
        surfaceBroker = new SurfaceRequestBroker({
          hostWindow: window,
          childWindow,
          serviceOrigin,
          sourceId,
          factory
        });
        surfaceBroker.start();
        captureProvider = new LabCaptureProvider({
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

    const openGuide = (): void => {
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

    const openDashboard = async (): Promise<void> => {
      try {
        await refreshCourse();
        factory.openDashboard();
      } catch {
        showRecovery();
      }
    };

    const openAuthor = (): void => {
      factory.openAuthor();
    };

    registerCourseCommands({
      addCommand: (id, options) => app.commands.addCommand(id, options)
    }, {
      openGuide,
      openDashboard,
      openAuthor,
      requestShare: () => openGuide()
    });
    registerCoursePalette(palette);

    installOriginGuard(serviceOrigin);
    try {
      await refreshCourse();
    } catch {
      // Runtime/guide recovery remains available while normal JupyterLab stays usable.
    }
    if (launchMode === 'author') openAuthor();
    else openGuide();
  }
};

export default plugin;
