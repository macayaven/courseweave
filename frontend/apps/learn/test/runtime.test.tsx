import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProbe } from '../src/runtime';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function dispatchRuntime(data: unknown, origin = 'https://courseweave.test'): void {
  const event = new MessageEvent('message', { data, source: window.parent });
  Object.defineProperty(event, 'origin', { value: origin });
  act(() => window.dispatchEvent(event));
}

describe('useRuntimeBootstrap', () => {
  it('emits only the versioned runtime request and accepts one valid parent reply', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    render(<RuntimeProbe />);
    expect(postMessage).toHaveBeenCalledWith({ type: 'courseweave.runtime.request.v1' }, '*');

    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-test-token' });
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('rejects malformed, wrong-source, non-canonical, origin-mismatched, whitespace-token, and unexpected-field replies', () => {
    render(<RuntimeProbe />);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'x' } }));
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test/', capabilityToken: 'x' });
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'x' }, 'https://other.test');
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: '  x  ' });
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'x', unexpected: true });
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });

  it('keeps an accepted valid token out of browser persistence', () => {
    render(<RuntimeProbe />);
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-test-token' });
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(location.href).not.toContain('runtime-test-token');
    expect(JSON.stringify(history.state)).not.toContain('runtime-test-token');
    expect(localStorage.getItem('capabilityToken')).toBeNull();
    expect(sessionStorage.getItem('capabilityToken')).toBeNull();
  });

  it('removes the runtime listener after unmount', () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const view = render(<RuntimeProbe />);
    view.unmount();
    dispatchRuntime({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-test-token' });
    expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function));
    expect(view.container).toBeEmptyDOMElement();
  });
});
