import { ServerConnection } from '@jupyterlab/services';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CourseWeaveRelayClient,
  RuntimeBroker,
  createCourseWeaveIframe
} from '../src/runtime';

afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CourseWeave same-origin relay client', () => {
  it('uses ServerConnection.makeRequest against the Jupyter base URL with the exact runtime ID header', async () => {
    const makeRequest = vi.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
      new Response(JSON.stringify({
        serviceOrigin: 'https://courseweave.test',
        capabilityToken: 'runtime-token'
      }), { status: 200 })
    );
    const settings = ServerConnection.makeSettings({ baseUrl: 'https://lab.test/base/' });
    const client = new CourseWeaveRelayClient('https://courseweave.test', settings);

    await expect(client.getRuntime('runtime-123')).resolves.toEqual({
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token'
    });
    expect(makeRequest).toHaveBeenCalledTimes(1);
    const [url, init, usedSettings] = makeRequest.mock.calls[0]!;
    expect(url).toBe('https://lab.test/base/courseweave/runtime');
    expect(new Headers(init.headers).get('X-CourseWeave-Runtime-ID')).toBe('runtime-123');
    expect(usedSettings).toBe(settings);
  });

  it('uses only same-origin Jupyter course and context relay URLs', async () => {
    const makeRequest = vi.spyOn(ServerConnection, 'makeRequest')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 409 }));
    const settings = ServerConnection.makeSettings({ baseUrl: 'https://lab.test/base/' });
    const client = new CourseWeaveRelayClient('https://courseweave.test', settings);
    const context = {
      source_id: 'source-1', sequence: 0, active_path: null,
      active_cell_id: null, active_cell_tags: [], surface_kind: null,
      explicit_module_id: null, explicit_phase_id: null,
      video_seconds: null, terminal_surface_id: null
    } as const;

    await client.getCourse();
    await client.postContext(context);

    expect(makeRequest.mock.calls.map(([url]) => url)).toEqual([
      'https://lab.test/base/courseweave/course',
      'https://lab.test/base/courseweave/context'
    ]);
    expect(makeRequest.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(context)
    });
    expect(JSON.stringify(makeRequest.mock.calls)).not.toContain('https://courseweave.test/api/');
  });

  it('returns one generic runtime error without retaining or exposing response secrets', async () => {
    const capability = 'upstream-secret-capability';
    vi.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
      new Response(JSON.stringify({ code: 'broken', message: capability }), { status: 500 })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = ServerConnection.makeSettings({ baseUrl: 'https://lab.test/' });
    const client = new CourseWeaveRelayClient('https://courseweave.test', settings);

    await expect(client.getRuntime('runtime-123')).rejects.toThrow('CourseWeave runtime unavailable.');
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('RuntimeBroker', () => {
  it('accepts only the owned child window at the CourseWeave origin and replies to that exact target', async () => {
    const child = { postMessage: vi.fn() } as unknown as Window;
    const getRuntime = vi.fn().mockResolvedValue({
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token'
    });
    const broker = new RuntimeBroker({
      hostWindow: window,
      childWindow: child,
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      sourceId: 'source-123',
      relay: { getRuntime }
    });
    broker.start();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'courseweave.runtime.request.v1' },
      origin: 'https://courseweave.test',
      source: child
    }));
    await settle();

    expect(getRuntime).toHaveBeenCalledWith('runtime-123');
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'courseweave.runtime.v1',
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token',
      sourceId: 'source-123'
    }, 'https://courseweave.test');
    expect(child.postMessage).not.toHaveBeenCalledWith(expect.anything(), '*');
    broker.dispose();
  });

  it('ignores forged source, origin, schema, and duplicate concurrent requests', async () => {
    const child = { postMessage: vi.fn() } as unknown as Window;
    let resolveRuntime!: (value: { serviceOrigin: string; capabilityToken: string }) => void;
    const getRuntime = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRuntime = resolve; }));
    const broker = new RuntimeBroker({
      hostWindow: window,
      childWindow: child,
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      sourceId: 'source-123',
      relay: { getRuntime }
    });
    broker.start();
    const request = { type: 'courseweave.runtime.request.v1' };

    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: {} as MessageEventSource }));
    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://attacker.test', source: child }));
    window.dispatchEvent(new MessageEvent('message', { data: { ...request, extra: true }, origin: 'https://courseweave.test', source: child }));
    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: child }));
    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: child }));
    expect(getRuntime).toHaveBeenCalledTimes(1);

    resolveRuntime({ serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token' });
    await settle();
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    broker.dispose();
  });

  it('does not echo a failed relay capability through replies, console, or thrown events', async () => {
    const capability = 'never-echo-this-capability';
    const child = { postMessage: vi.fn() } as unknown as Window;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorEvent = vi.fn();
    window.addEventListener('error', errorEvent);
    const broker = new RuntimeBroker({
      hostWindow: window,
      childWindow: child,
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      sourceId: 'source-123',
      relay: { getRuntime: vi.fn().mockRejectedValue(new Error(capability)) }
    });
    broker.start();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'courseweave.runtime.request.v1' },
      origin: 'https://courseweave.test',
      source: child
    }));
    await settle();

    expect(child.postMessage).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(errorEvent).not.toHaveBeenCalled();
    broker.dispose();
    window.removeEventListener('error', errorEvent);
  });

  it('creates an origin-referrer sandboxed guide iframe without a URL token', () => {
    const iframe = createCourseWeaveIframe('https://courseweave.test', 'learn');
    expect(iframe.src).toBe('https://courseweave.test/learn/');
    expect(iframe.referrerPolicy).toBe('origin');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    expect(iframe.src).not.toContain('token');
  });
});
