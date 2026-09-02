import { useCallback, useEffect, useState } from 'react';

import type { RuntimeConfiguration } from './api';

export type RuntimeState =
  | { status: 'connecting'; runtime: null }
  | { status: 'ready'; runtime: RuntimeConfiguration }
  | { status: 'recovery'; runtime: null };

function parseRuntimeMessage(value: unknown, origin: string): RuntimeConfiguration | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (
    data.type !== 'courseweave.runtime.v1' ||
    typeof data.serviceOrigin !== 'string' ||
    typeof data.capabilityToken !== 'string' ||
    data.capabilityToken.length === 0
  ) return null;
  try {
    const service = new URL(data.serviceOrigin);
    if (!['http:', 'https:'].includes(service.protocol) || service.origin !== data.serviceOrigin || origin !== service.origin) return null;
    return { serviceOrigin: service.origin, capabilityToken: data.capabilityToken };
  } catch {
    return null;
  }
}

export function useRuntimeBootstrap(): RuntimeState & { retry(): void } {
  const [state, setState] = useState<RuntimeState>({ status: 'connecting', runtime: null });
  const request = useCallback(() => {
    setState({ status: 'connecting', runtime: null });
    window.parent.postMessage({ type: 'courseweave.runtime.request.v1' }, '*');
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent) return;
      const runtime = parseRuntimeMessage(event.data, event.origin);
      if (runtime !== null) setState((previous) => previous.status === 'ready' ? previous : { status: 'ready', runtime });
    };
    window.addEventListener('message', listener);
    request();
    return () => window.removeEventListener('message', listener);
  }, [request]);

  return { ...state, retry: request };
}

export function RuntimeProbe() {
  const runtime = useRuntimeBootstrap();
  return <output>{runtime.status}</output>;
}
