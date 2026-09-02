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
import { Widget } from '@lumino/widgets';

const PLUGIN_ID = 'courseweave:bridge';
const OPEN_GUIDE_COMMAND = 'courseweave:open-guide';
const GUIDE_WIDGET_ID = 'courseweave-guide';

/**
 * Non-persisted page-config option carrying the CourseWeave service URL.
 * Task 6 injects it into the authenticated Jupyter server page configuration
 * from the `COURSEWEAVE_URL` environment variable of the owned child process;
 * nothing is read from disk.
 */
const SERVICE_URL_OPTION = 'courseweaveServiceUrl';

/** Loopback fallback used only when the page config provides no URL. */
const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:8765';

/**
 * Resolve the service origin from Jupyter page configuration, so custom
 * ports and hosts chosen at launch work without rebuilding. The capability
 * token is server-side state and never appears in the iframe URL.
 */
function resolveServiceOrigin(): string {
  const configured = PageConfig.getOption(SERVICE_URL_OPTION).replace(/\/+$/, '');
  return configured || DEFAULT_SERVICE_ORIGIN;
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
  activate: (app: JupyterFrontEnd, shell: ILabShell): void => {
    const serviceOrigin = resolveServiceOrigin();
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

    installOriginGuard(serviceOrigin);
    openGuide();
  }
};

export default plugin;
