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

const PLUGIN_ID = 'courseweave:bridge';
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
 * The sandboxed guide iframe. `allow-scripts` and `allow-same-origin` let the
 * embedded learner application talk to its own service origin (the capability
 * token never appears in the iframe URL).
 */
class CourseWeaveGuide extends Widget {
  constructor(serviceOrigin: string) {
    const node = document.createElement('div');
    node.classList.add('cw-Guide');

    const iframe = document.createElement('iframe');
    iframe.className = 'cw-Guide-iframe';
    iframe.title = 'CourseWeave guide';
    iframe.src = `${serviceOrigin}/learn/`;
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    node.appendChild(iframe);

    super({ node });
    this.id = GUIDE_WIDGET_ID;
    this.title.label = 'CourseWeave';
    this.title.caption = 'CourseWeave guide rail';
    this.addClass('cw-Guide-host');
  }
}

/**
 * Accept postMessages only from the CourseWeave service origin. Messages from
 * any other origin are dropped before any handling (spec §12: "ignores
 * messages from unexpected iframe origins"). Task 0 only establishes the
 * guarded listener; the command allowlist arrives with the full bridge.
 */
function installOriginGuard(serviceOrigin: string): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== serviceOrigin) {
      return;
    }
    // Command handling for allowlisted bridge commands lands in a later task.
  });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'Persistent CourseWeave guide rail: one sandboxed iframe, origin-guarded messages.',
  autoStart: true,
  requires: [ILabShell],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    shell: ILabShell,
    registry: ISettingRegistry | null
  ): void => {
    // Provisional origin until settings resolve; the guide is (re)created
    // with the resolved origin below before the user normally interacts.
    let serviceOrigin = DEFAULT_SERVICE_ORIGIN;
    let guide: CourseWeaveGuide | null = null;

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
            guide = null;
          }
        });
        guide = current;
        current.title.closable = true;
        shell.add(current, 'right', { rank: 900 });
      }
      shell.activateById(current.id);
    };

    app.commands.addCommand(OPEN_GUIDE_COMMAND, {
      label: 'Open CourseWeave Guide',
      execute: openGuide
    });

    void resolveServiceOrigin(registry).then(resolved => {
      serviceOrigin = resolved;
      installOriginGuard(serviceOrigin);
      openGuide();
    });
  }
};

export default plugin;
