/**
 * CourseWeave JupyterLab bridge — Task 0 walking skeleton.
 *
 * A prebuilt JupyterLab 4 extension with no React. It opens exactly one
 * sandboxed iframe hosting the CourseWeave guide rail served by the local
 * loopback CourseWeave service, keeps it in the right sidebar, and ignores
 * any postMessage whose origin is not the configured service origin
 * (design spec §12).
 */
import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Widget } from '@lumino/widgets';
import { parseLaunchConfiguration, type LaunchMode } from './protocol';
import { CourseWeaveRelayClient, RuntimeBroker, createCourseWeaveIframe } from './runtime';

/**
 * Runtime plugin identity. JupyterLab-server derives the settings plugin ID
 * from the shipped schema path, so this must stay aligned exactly:
 * `@courseweave/lab:plugin` ↔ `schemas/@courseweave/lab/plugin.json`.
 */
const PLUGIN_ID = '@courseweave/lab:plugin';
const OPEN_GUIDE_COMMAND = 'courseweave:open-guide';
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

  constructor(serviceOrigin: string, mode: LaunchMode) {
    const node = document.createElement('div');
    node.classList.add('cw-Guide');

    const iframe = createCourseWeaveIframe(serviceOrigin, mode);
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
    'Persistent CourseWeave guide rail: one sandboxed iframe, origin-guarded messages.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    shell: ILabShell,
    registry: ISettingRegistry | null
  ): Promise<void> => {
    // Resolve the service origin BEFORE anything can create a guide: there
    // must be no window in which the command would open a default-origin
    // guide while a custom origin is still resolving.
    const launch = parseLaunchConfiguration(PageConfig.getOption);
    const serviceOrigin = launch?.serviceOrigin ?? await resolveServiceOrigin(registry);
    const launchMode = launch?.launchMode ?? 'learn';
    const relay = launch === null ? null : new CourseWeaveRelayClient(serviceOrigin);
    let guide: CourseWeaveGuide | null = null;
    let broker: RuntimeBroker | null = null;

    const openGuide = (): void => {
      let current = guide;
      if (current === null || current.isDisposed) {
        current = new CourseWeaveGuide(serviceOrigin, launchMode);
        const widget = current;
        // Clear the tracked reference when the widget is closed/disposed so
        // the command recreates the guide instead of touching a disposed
        // widget.
        widget.disposed.connect(() => {
          if (guide === widget) {
            broker?.dispose();
            broker = null;
            guide = null;
          }
        });
        guide = current;
        current.title.closable = true;
        shell.add(current, 'right', { rank: 900 });
        const childWindow = current.iframe.contentWindow;
        if (launch !== null && relay !== null && childWindow !== null) {
          broker = new RuntimeBroker({
            hostWindow: window,
            childWindow,
            serviceOrigin,
            runtimeId: launch.runtimeId,
            sourceId: crypto.randomUUID(),
            relay
          });
          broker.start();
        }
      }
      shell.activateById(current.id);
    };

    app.commands.addCommand(OPEN_GUIDE_COMMAND, {
      label: 'Open CourseWeave Guide',
      execute: openGuide
    });

    installOriginGuard(serviceOrigin);
    openGuide();
  }
};

export default plugin;
