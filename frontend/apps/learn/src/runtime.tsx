import { useCallback, useEffect, useRef, useState } from 'react';

import type { RuntimeConfiguration } from './api';

export type RuntimeState =
  | { status: 'connecting'; runtime: null }
  | { status: 'ready'; runtime: RuntimeConfiguration }
  | { status: 'recovery'; runtime: null };

function parseRuntimeMessage(value: unknown, origin: string): RuntimeConfiguration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const expectedKeys = ['capabilityToken', 'serviceOrigin', 'sourceId', 'type'];
  if (Object.keys(data).sort().join(',') !== expectedKeys.join(',')) return null;
  if (
    data.type !== 'courseweave.runtime.v1' ||
    typeof data.serviceOrigin !== 'string' ||
    typeof data.capabilityToken !== 'string' ||
    typeof data.sourceId !== 'string' ||
    data.capabilityToken.trim() !== data.capabilityToken ||
    data.capabilityToken.length === 0 ||
    data.sourceId.trim() !== data.sourceId ||
    data.sourceId.length === 0 ||
    data.sourceId.length > 240
  ) return null;
  try {
    const service = new URL(data.serviceOrigin);
    if (!['http:', 'https:'].includes(service.protocol) || service.origin !== data.serviceOrigin || origin !== service.origin) return null;
    return { serviceOrigin: service.origin, capabilityToken: data.capabilityToken, sourceId: data.sourceId };
  } catch {
    return null;
  }
}

function isContextChangedMessage(value: unknown): value is { type: 'courseweave.context.changed.v1'; sourceId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).sort().join(',') === 'sourceId,type'
    && data.type === 'courseweave.context.changed.v1'
    && typeof data.sourceId === 'string';
}

export function useRuntimeBootstrap(): RuntimeState & { retry(): void; contextVersion: number } {
  const [state, setState] = useState<RuntimeState>({ status: 'connecting', runtime: null });
  const [contextVersion, setContextVersion] = useState(0);
  const activeRuntime = useRef<RuntimeConfiguration | null>(null);
  const request = useCallback(() => {
    activeRuntime.current = null;
    setContextVersion(0);
    setState({ status: 'connecting', runtime: null });
    window.parent.postMessage({ type: 'courseweave.runtime.request.v1' }, '*');
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent) return;
      const runtime = parseRuntimeMessage(event.data, event.origin);
      if (runtime !== null && activeRuntime.current === null) {
        activeRuntime.current = runtime;
        setState({ status: 'ready', runtime });
        return;
      }
      if (isContextChangedMessage(event.data)) {
        const current = activeRuntime.current;
        if (current !== null && event.origin === current.serviceOrigin && event.data.sourceId === current.sourceId) {
          setContextVersion((version) => version + 1);
        }
      }
    };
    window.addEventListener('message', listener);
    request();
    return () => window.removeEventListener('message', listener);
  }, [request]);

  return { ...state, retry: request, contextVersion };
}

export function RuntimeProbe() {
  const runtime = useRuntimeBootstrap();
  return <output>{runtime.status}</output>;
}
