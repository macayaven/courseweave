import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorRuntimeProbe } from '../src/runtime';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function reply(data: unknown, origin = 'https://courseweave.test', source: MessageEventSource | null = window.parent): void {
  const event = new MessageEvent('message', { data, source });
  Object.defineProperty(event, 'origin', { value: origin });
  act(() => window.dispatchEvent(event));
}

describe('Author runtime', () => {
  it('requests and accepts only the trusted v1 runtime shape without persistence', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    render(<AuthorRuntimeProbe />);
    expect(postMessage).toHaveBeenCalledWith({ type: 'courseweave.runtime.request.v1' }, '*');
    reply({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token', sourceId: 'author-window' });
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(location.href).not.toContain('runtime-token');
    expect(JSON.stringify(localStorage)).not.toContain('runtime-token');
  });

  it('rejects wrong keys, source, origin, and whitespace secrets', () => {
    render(<AuthorRuntimeProbe />);
    reply({ type: 'courseweave.runtime.response.v1', serviceOrigin: 'https://courseweave.test', token: 'x', sourceId: 'a' });
    reply({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'x', sourceId: 'a' }, 'https://courseweave.test', {} as MessageEventSource);
    reply({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'x', sourceId: 'a' }, 'https://other.test');
    reply({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test/', capabilityToken: 'x', sourceId: 'a' });
    reply({ type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: ' x ', sourceId: 'a' });
    expect(screen.getByText('connecting')).toBeInTheDocument();
  });
});
