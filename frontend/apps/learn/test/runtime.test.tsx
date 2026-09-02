import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProbe } from '../src/runtime';

afterEach(() => cleanup());

describe('useRuntimeBootstrap', () => {
  it('emits only the versioned runtime request and accepts one valid parent reply', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    render(<RuntimeProbe />);
    expect(postMessage).toHaveBeenCalledWith({ type: 'courseweave.runtime.request.v1' }, '*');

    const reply = new MessageEvent('message', {
        data: {
          type: 'courseweave.runtime.v1',
          serviceOrigin: 'https://courseweave.test',
          capabilityToken: 'runtime-test-token'
        },
        origin: 'https://courseweave.test',
        source: window.parent
      });
    Object.defineProperty(reply, 'origin', { value: 'https://courseweave.test' });
    act(() => window.dispatchEvent(reply));
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('ignores malformed, wrong-source, missing-token, and non-origin runtime messages', () => {
    render(<RuntimeProbe />);
    for (const event of [
      new MessageEvent('message', { data: { type: 'courseweave.runtime.v1' }, origin: 'https://courseweave.test' }),
      new MessageEvent('message', { data: { type: 'courseweave.runtime.v1', serviceOrigin: 'ftp://bad.test', capabilityToken: 'x' }, origin: 'https://courseweave.test', source: window.parent }),
      new MessageEvent('message', { data: { type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: '' }, origin: 'https://courseweave.test', source: window.parent })
    ]) window.dispatchEvent(event);
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });

  it('keeps token custody out of browser persistence', () => {
    render(<RuntimeProbe />);
    expect(location.href).not.toContain('runtime-test-token');
    expect(JSON.stringify(history.state)).not.toContain('runtime-test-token');
    expect(localStorage.getItem('capabilityToken')).toBeNull();
    expect(sessionStorage.getItem('capabilityToken')).toBeNull();
  });

  it('cleans up after unmount', () => {
    const view = render(<RuntimeProbe />);
    view.unmount();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-test-token' }, origin: 'https://courseweave.test', source: window.parent }));
    expect(view.container).toBeEmptyDOMElement();
  });
});
