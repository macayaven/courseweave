import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectedParentOrigin } from '@courseweave/ui/parent-origin';
import { ParentCaptureRequester, useRuntimeBootstrap } from '../src/runtime';

const VALID_RUNTIME = {
  type: 'courseweave.runtime.v1',
  serviceOrigin: 'https://courseweave.test',
  capabilityToken: 'runtime-test-token',
  sourceId: 'notebook-a'
} as const;

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, value });
}

function dispatchRuntime(
  data: unknown,
  origin = 'https://lab.test',
  source: MessageEventSource | null = window.parent
): void {
  const event = new MessageEvent('message', { data, source });
  Object.defineProperty(event, 'origin', { value: origin });
  act(() => window.dispatchEvent(event));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setReferrer('');
});

describe('Learn parent-origin trust bootstrap', () => {
  it.each([
    ['https://lab.test/', 'https://lab.test'],
    ['http://127.0.0.1:8888/', 'http://127.0.0.1:8888'],
    ['https://[::1]:9443/', 'https://[::1]:9443']
  ])('accepts an origin-only browser referrer %s', (referrer, expected) => {
    expect(expectedParentOrigin(referrer)).toBe(expected);
  });

  it.each([
    '',
    ' not-a-url ',
    'ftp://lab.test/',
    'https://user:secret@lab.test/',
    'https://lab.test/tree/course',
    'https://lab.test/?workspace=course',
    'https://lab.test/#course',
    ' https://lab.test/ '
  ])('fails closed for rejected referrer %j', (referrer) => {
    expect(expectedParentOrigin(referrer)).toBeNull();
  });

  it('targets only the derived parent origin and persists it in the accepted runtime', () => {
    setReferrer('https://lab.test/');
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    const view = renderHook(() => useRuntimeBootstrap());

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'courseweave.runtime.request.v1' },
      'https://lab.test'
    );
    dispatchRuntime(VALID_RUNTIME);

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.runtime).toMatchObject({
      serviceOrigin: 'https://courseweave.test',
      sourceId: 'notebook-a',
      expectedParentOrigin: 'https://lab.test'
    });
  });

  it('enters recovery without posting when the referrer is absent or malformed', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    const view = renderHook(() => useRuntimeBootstrap());
    expect(postMessage).not.toHaveBeenCalled();
    expect(view.result.current).toMatchObject({ status: 'recovery', runtime: null });
  });

  it('rejects forged source, forged parent origin, malformed service origin, secrets, IDs, and extra keys', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useRuntimeBootstrap());

    dispatchRuntime(VALID_RUNTIME, 'https://lab.test', {} as MessageEventSource);
    dispatchRuntime(VALID_RUNTIME, 'https://attacker.test');
    dispatchRuntime({ ...VALID_RUNTIME, serviceOrigin: 'https://courseweave.test/' });
    dispatchRuntime({ ...VALID_RUNTIME, serviceOrigin: 'file:///tmp/course' });
    dispatchRuntime({ ...VALID_RUNTIME, capabilityToken: ' x ' });
    dispatchRuntime({ ...VALID_RUNTIME, capabilityToken: 'x'.repeat(4097) });
    dispatchRuntime({ ...VALID_RUNTIME, sourceId: '' });
    dispatchRuntime({ ...VALID_RUNTIME, sourceId: 'x'.repeat(241) });
    dispatchRuntime({ ...VALID_RUNTIME, unexpected: true });

    expect(view.result.current.status).toBe('connecting');
  });

  it('accepts at most one runtime reply per retry epoch', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useRuntimeBootstrap());
    dispatchRuntime(VALID_RUNTIME);
    dispatchRuntime({ ...VALID_RUNTIME, sourceId: 'forged-replacement' });
    expect(view.result.current.runtime?.sourceId).toBe('notebook-a');

    act(() => view.result.current.retry());
    dispatchRuntime({ ...VALID_RUNTIME, sourceId: 'notebook-b' });
    expect(view.result.current.runtime?.sourceId).toBe('notebook-b');
  });

  it('keeps an accepted capability out of browser persistence', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useRuntimeBootstrap());
    dispatchRuntime(VALID_RUNTIME);
    expect(view.result.current.status).toBe('ready');
    expect(location.href).not.toContain(VALID_RUNTIME.capabilityToken);
    expect(JSON.stringify(history.state)).not.toContain(VALID_RUNTIME.capabilityToken);
    expect(localStorage.getItem('capabilityToken')).toBeNull();
    expect(sessionStorage.getItem('capabilityToken')).toBeNull();
  });

  it('accepts metadata-free context invalidation only from the exact Jupyter parent', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useRuntimeBootstrap());
    dispatchRuntime(VALID_RUNTIME);
    dispatchRuntime({ type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, 'https://courseweave.test');
    dispatchRuntime({ type: 'courseweave.context.changed.v1', sourceId: 'notebook-a', active_path: 'secret.py' }, 'https://lab.test');
    dispatchRuntime({ type: 'courseweave.context.changed.v1', sourceId: 'wrong-source' }, 'https://lab.test');
    dispatchRuntime({ type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, 'https://lab.test', {} as MessageEventSource);
    expect(view.result.current.contextVersion).toBe(0);
    dispatchRuntime({ type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, 'https://lab.test');
    expect(view.result.current.contextVersion).toBe(1);
  });
});

describe('ParentCaptureRequester', () => {
  it('posts one exact capture request to Jupyter and accepts only its matching result', async () => {
    const parent = { postMessage: vi.fn() } as unknown as Window;
    const requester = new ParentCaptureRequester({
      runtime: { serviceOrigin: 'https://courseweave.test', capabilityToken: 'token', sourceId: 'source-a', expectedParentOrigin: 'https://lab.test' },
      hostWindow: window,
      parentWindow: parent,
      requestId: () => 'request-a'
    });
    const captured = requester.request('selection', 4);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'courseweave.share.capture.request.v1', requestId: 'request-a', kind: 'selection', maxChars: 4 }, 'https://lab.test');
    dispatchRuntime({ type: 'courseweave.share.capture.result.v1', requestId: 'request-a', kind: 'selection', label: 'file.py', content: 'safe' }, 'https://courseweave.test', parent);
    dispatchRuntime({ type: 'courseweave.share.capture.result.v1', requestId: 'wrong', kind: 'selection', label: 'file.py', content: 'safe' }, 'https://lab.test', parent);
    dispatchRuntime({ type: 'courseweave.share.capture.result.v1', requestId: 'request-a', kind: 'cell', label: 'file.py', content: 'safe' }, 'https://lab.test', parent);
    let settled = false;
    void captured.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    dispatchRuntime({ type: 'courseweave.share.capture.result.v1', requestId: 'request-a', kind: 'selection', label: 'file.py', content: 'safe' }, 'https://lab.test', parent);
    await expect(captured).resolves.toEqual({ kind: 'selection', label: 'file.py', content: 'safe' });
    requester.dispose();
  });

  it('clears rejected, cancelled, duplicate, and disposed requests without retaining content', async () => {
    const parent = { postMessage: vi.fn() } as unknown as Window;
    let id = 0;
    const requester = new ParentCaptureRequester({ runtime: { serviceOrigin: 'https://courseweave.test', capabilityToken: 'token', sourceId: 'source-a', expectedParentOrigin: 'https://lab.test' }, hostWindow: window, parentWindow: parent, requestId: () => `request-${++id}` });
    const rejected = requester.request('cell', 4);
    dispatchRuntime({ type: 'courseweave.share.capture.rejected.v1', requestId: 'request-1', code: 'too_large' }, 'https://lab.test', parent);
    await expect(rejected).rejects.toThrow('too_large');
    dispatchRuntime({ type: 'courseweave.share.capture.result.v1', requestId: 'request-1', kind: 'cell', label: 'x', content: 'late-secret' }, 'https://lab.test', parent);

    const cancelled = requester.request('output', 4);
    requester.cancel();
    await expect(cancelled).rejects.toThrow('cancelled');
    const disposed = requester.request('selection', 4);
    requester.dispose();
    await expect(disposed).rejects.toThrow('disposed');
    expect(JSON.stringify(requester)).not.toContain('late-secret');
  });
});
