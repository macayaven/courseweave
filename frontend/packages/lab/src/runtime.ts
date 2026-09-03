import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import { parseRuntimeRelayPayload, parseRuntimeRequest, type RuntimeRelayPayload } from './protocol';

export interface WorkspaceContext {
  source_id: string;
  sequence: number;
  active_path: string | null;
  active_cell_id: string | null;
  active_cell_tags: string[];
  surface_kind: string | null;
  explicit_module_id: string | null;
  explicit_phase_id: string | null;
  video_seconds: number | null;
  terminal_surface_id: string | null;
}

export class CourseWeaveRelayClient {
  private readonly serverSettings: ServerConnection.ISettings;

  constructor(
    private readonly serviceOrigin: string,
    serverSettings: ServerConnection.ISettings = ServerConnection.makeSettings()
  ) {
    this.serverSettings = serverSettings;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    const url = URLExt.join(this.serverSettings.baseUrl, 'courseweave', path);
    return ServerConnection.makeRequest(url, init, this.serverSettings);
  }

  async getRuntime(runtimeId: string): Promise<RuntimeRelayPayload> {
    try {
      if (runtimeId.length === 0 || runtimeId.length > 240 || runtimeId.trim() !== runtimeId) {
        throw new Error('invalid runtime ID');
      }
      const response = await this.request('runtime', {
        method: 'GET',
        headers: { 'X-CourseWeave-Runtime-ID': runtimeId },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('runtime relay failed');
      const payload = parseRuntimeRelayPayload(await response.json(), this.serviceOrigin);
      if (payload === null) throw new Error('invalid runtime relay payload');
      return payload;
    } catch {
      throw new Error('CourseWeave runtime unavailable.');
    }
  }

  async getCourse(): Promise<Response> {
    return this.request('course', { method: 'GET', cache: 'no-store' });
  }

  async postContext(context: WorkspaceContext): Promise<Response> {
    return this.request('context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(context),
      cache: 'no-store'
    });
  }
}

interface RuntimeBrokerOptions {
  hostWindow: Window;
  childWindow: Window;
  serviceOrigin: string;
  runtimeId: string;
  sourceId: string;
  relay: Pick<CourseWeaveRelayClient, 'getRuntime'>;
}

export class RuntimeBroker {
  private listening = false;
  private inFlight = false;

  constructor(private readonly options: RuntimeBrokerOptions) {}

  private readonly listener = (event: MessageEvent<unknown>): void => {
    if (
      !this.listening
      || this.inFlight
      || event.source !== this.options.childWindow
      || event.origin !== this.options.serviceOrigin
      || parseRuntimeRequest(event.data) === null
    ) return;
    this.inFlight = true;
    void this.reply().finally(() => {
      this.inFlight = false;
    });
  };

  private async reply(): Promise<void> {
    try {
      const runtime = await this.options.relay.getRuntime(this.options.runtimeId);
      if (!this.listening || runtime.serviceOrigin !== this.options.serviceOrigin) return;
      this.options.childWindow.postMessage({
        type: 'courseweave.runtime.v1',
        serviceOrigin: runtime.serviceOrigin,
        capabilityToken: runtime.capabilityToken,
        sourceId: this.options.sourceId
      }, this.options.serviceOrigin);
    } catch {
      // The guide already owns recovery UI. Never echo relay errors or secrets.
    }
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.hostWindow.addEventListener('message', this.listener);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.hostWindow.removeEventListener('message', this.listener);
  }
}

export function createCourseWeaveIframe(serviceOrigin: string, mode: 'learn' | 'author'): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'cw-Guide-iframe';
  iframe.title = mode === 'learn' ? 'CourseWeave guide' : 'CourseWeave author';
  iframe.src = `${serviceOrigin}/${mode}/`;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  iframe.referrerPolicy = 'origin';
  return iframe;
}
