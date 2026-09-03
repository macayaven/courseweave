import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectedParentOrigin } from '@courseweave/ui/parent-origin';
import { useAuthorRuntime } from '../src/runtime';

const VALID_RUNTIME = {
  type: 'courseweave.runtime.v1',
  serviceOrigin: 'https://courseweave.test',
  capabilityToken: 'author-runtime-token',
  sourceId: 'author-window'
} as const;

function setReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', { configurable: true, value });
}

function reply(
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

describe('Author parent-origin trust bootstrap', () => {
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
    const view = renderHook(() => useAuthorRuntime());

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'courseweave.runtime.request.v1' },
      'https://lab.test'
    );
    reply(VALID_RUNTIME);

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.runtime).toMatchObject({
      serviceOrigin: 'https://courseweave.test',
      sourceId: 'author-window',
      expectedParentOrigin: 'https://lab.test'
    });
  });

  it('enters recovery without posting when the referrer is absent or malformed', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    const view = renderHook(() => useAuthorRuntime());
    expect(postMessage).not.toHaveBeenCalled();
    expect(view.result.current).toMatchObject({ status: 'disconnected', runtime: null });
  });

  it('rejects forged source, forged parent origin, malformed service origin, secrets, IDs, and extra keys', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useAuthorRuntime());

    reply(VALID_RUNTIME, 'https://lab.test', {} as MessageEventSource);
    reply(VALID_RUNTIME, 'https://attacker.test');
    reply({ ...VALID_RUNTIME, serviceOrigin: 'https://courseweave.test/' });
    reply({ ...VALID_RUNTIME, serviceOrigin: 'file:///tmp/course' });
    reply({ ...VALID_RUNTIME, capabilityToken: ' x ' });
    reply({ ...VALID_RUNTIME, capabilityToken: 'x'.repeat(4097) });
    reply({ ...VALID_RUNTIME, sourceId: '' });
    reply({ ...VALID_RUNTIME, sourceId: 'x'.repeat(241) });
    reply({ ...VALID_RUNTIME, unexpected: true });

    expect(view.result.current.status).toBe('connecting');
  });

  it('accepts at most one runtime reply per retry epoch', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useAuthorRuntime());
    reply(VALID_RUNTIME);
    reply({ ...VALID_RUNTIME, sourceId: 'forged-replacement' });
    expect(view.result.current.runtime?.sourceId).toBe('author-window');

    act(() => view.result.current.retry());
    reply({ ...VALID_RUNTIME, sourceId: 'author-window-2' });
    expect(view.result.current.runtime?.sourceId).toBe('author-window-2');
  });

  it('keeps an accepted capability out of browser persistence', () => {
    setReferrer('https://lab.test/');
    const view = renderHook(() => useAuthorRuntime());
    reply(VALID_RUNTIME);
    expect(view.result.current.status).toBe('ready');
    expect(location.href).not.toContain(VALID_RUNTIME.capabilityToken);
    expect(JSON.stringify(history.state)).not.toContain(VALID_RUNTIME.capabilityToken);
    expect(localStorage.getItem('capabilityToken')).toBeNull();
    expect(sessionStorage.getItem('capabilityToken')).toBeNull();
  });
});
