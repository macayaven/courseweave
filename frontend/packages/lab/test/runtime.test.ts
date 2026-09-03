import { ServerConnection } from '@jupyterlab/services';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CourseWeaveRelayClient,
  RuntimeBroker,
  createCourseWeaveIframe
} from '../src/runtime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = '_xsrf=; Max-Age=0';
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function iframeWithWindow(childWindow: Window): HTMLIFrameElement {
  return { get contentWindow() { return childWindow; } } as unknown as HTMLIFrameElement;
}

describe('CourseWeave same-origin relay client', () => {
  it('uses the authenticated Jupyter transport for exact no-query runtime, course, and context relays', async () => {
    document.cookie = '_xsrf=xsrf-test-token';
    const transport = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token'
      }), { status: 200, headers: { 'Cache-Control': 'no-store' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Cache-Control': 'no-store' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'Cache-Control': 'no-store' } }));
    const settings = ServerConnection.makeSettings({
      baseUrl: 'https://lab.test/base/',
      token: 'jupyter-test-token',
      fetch: transport as unknown as typeof fetch
    });
    const client = new CourseWeaveRelayClient('https://courseweave.test', settings);
    const context = {
      source_id: 'source-1', sequence: 0, active_path: null,
      active_cell_id: null, active_cell_tags: [], surface_kind: null,
      explicit_module_id: null, explicit_phase_id: null,
      video_seconds: null, terminal_surface_id: null
    } as const;

    await expect(client.getRuntime('runtime-123')).resolves.toEqual({
      serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token'
    });
    await client.getCourse();
    await client.postContext(context);

    expect(transport).toHaveBeenCalledTimes(3);
    const requests = transport.mock.calls.map(([request]) => request as Request);
    expect(requests.map((request) => request.url)).toEqual([
      'https://lab.test/base/courseweave/runtime',
      'https://lab.test/base/courseweave/course',
      'https://lab.test/base/courseweave/context'
    ]);
    expect(requests.every((request) => new URL(request.url).search === '')).toBe(true);
    expect(requests.map((request) => request.credentials)).toEqual(['same-origin', 'same-origin', 'same-origin']);
    expect(requests.map((request) => request.headers.get('Authorization'))).toEqual([
      'token jupyter-test-token', 'token jupyter-test-token', 'token jupyter-test-token'
    ]);
    expect(requests.map((request) => request.headers.get('X-XSRFToken'))).toEqual([
      'xsrf-test-token', 'xsrf-test-token', 'xsrf-test-token'
    ]);
    expect(requests[0]!.headers.get('X-CourseWeave-Runtime-ID')).toBe('runtime-123');
    expect(requests[2]!.method).toBe('POST');
    await expect(requests[2]!.text()).resolves.toBe(JSON.stringify(context));
  });

  it('returns one generic runtime error without retaining or exposing a secret-bearing transport response', async () => {
    const capability = 'upstream-secret-capability';
    const transport = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'broken', message: capability }), { status: 500 })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const settings = ServerConnection.makeSettings({
      baseUrl: 'https://lab.test/', fetch: transport as unknown as typeof fetch
    });
    const client = new CourseWeaveRelayClient('https://courseweave.test', settings);

    await expect(client.getRuntime('runtime-123')).rejects.toThrow('CourseWeave runtime unavailable.');
    expect(consoleError).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
    expect((transport.mock.calls[0]![0] as Request).url).toBe('https://lab.test/courseweave/runtime');
  });
});

describe('RuntimeBroker', () => {
  it('starts while detached and binds the later current iframe window before replying', async () => {
    const child = { postMessage: vi.fn() } as unknown as Window;
    let current: Window | null = null;
    const getRuntime = vi.fn().mockResolvedValue({
      serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token'
    });
    const beforeReply = vi.fn(() => {
      expect(child.postMessage).not.toHaveBeenCalled();
    });
    const broker = new RuntimeBroker({
      hostWindow: window,
      iframe: { get contentWindow() { return current; } } as unknown as HTMLIFrameElement,
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      sourceId: 'source-123',
      relay: { getRuntime },
      beforeReply
    });
    broker.start();
    const request = { type: 'courseweave.runtime.request.v1' };

    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: child }));
    expect(getRuntime).not.toHaveBeenCalled();

    current = child;
    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: child }));
    await settle();

    expect(beforeReply).toHaveBeenCalledOnce();
    expect(beforeReply).toHaveBeenCalledWith(child);
    expect(getRuntime).toHaveBeenCalledWith('runtime-123');
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'courseweave.runtime.v1' }), 'https://courseweave.test');
    broker.dispose();
  });

  it('rejects stale windows and suppresses the reply if navigation replaces the verified iframe window', async () => {
    const stale = { postMessage: vi.fn() } as unknown as Window;
    const child = { postMessage: vi.fn() } as unknown as Window;
    const replacement = { postMessage: vi.fn() } as unknown as Window;
    let current: Window | null = child;
    let resolveRuntime!: (value: { serviceOrigin: string; capabilityToken: string }) => void;
    const beforeReply = vi.fn();
    const getRuntime = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRuntime = resolve; }));
    const broker = new RuntimeBroker({
      hostWindow: window,
      iframe: { get contentWindow() { return current; } } as unknown as HTMLIFrameElement,
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      sourceId: 'source-123',
      relay: { getRuntime },
      beforeReply
    });
    broker.start();
    const request = { type: 'courseweave.runtime.request.v1' };

    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: stale }));
    expect(getRuntime).not.toHaveBeenCalled();
    current = child;
    window.dispatchEvent(new MessageEvent('message', { data: request, origin: 'https://courseweave.test', source: child }));
    current = replacement;
    resolveRuntime({ serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token' });
    await settle();

    expect(beforeReply).not.toHaveBeenCalled();
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(replacement.postMessage).not.toHaveBeenCalled();
    broker.dispose();
  });

  it('accepts only the owned child window at the CourseWeave origin and replies to that exact target', async () => {
    const child = { postMessage: vi.fn() } as unknown as Window;
    const getRuntime = vi.fn().mockResolvedValue({
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token'
    });
    const broker = new RuntimeBroker({
      hostWindow: window,
      iframe: iframeWithWindow(child),
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
      iframe: iframeWithWindow(child),
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
      iframe: iframeWithWindow(child),
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
