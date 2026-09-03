import { useCallback, useEffect, useRef, useState } from 'react';
import { expectedParentOrigin } from '@courseweave/ui/parent-origin';

export interface AuthorRuntime {
  serviceOrigin: string;
  capabilityToken: string;
  sourceId: string;
}

export type TrustedAuthorRuntime = AuthorRuntime & {
  expectedParentOrigin: string;
};

export type AuthorRuntimeState =
  | { status: 'connecting'; runtime: null }
  | { status: 'ready'; runtime: TrustedAuthorRuntime }
  | { status: 'disconnected'; runtime: null };

function parseRuntime(value: unknown, parentOrigin: string): TrustedAuthorRuntime | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const expectedKeys = ['capabilityToken', 'serviceOrigin', 'sourceId', 'type'];
  if (Object.keys(data).sort().join(',') !== expectedKeys.join(',')) return null;
  if (
    data.type !== 'courseweave.runtime.v1'
    || typeof data.serviceOrigin !== 'string'
    || typeof data.capabilityToken !== 'string'
    || typeof data.sourceId !== 'string'
    || data.capabilityToken.length === 0
    || data.capabilityToken.length > 4096
    || data.capabilityToken.trim() !== data.capabilityToken
    || data.sourceId.length === 0
    || data.sourceId.length > 240
    || data.sourceId.trim() !== data.sourceId
  ) return null;
  try {
    const serviceOrigin = new URL(data.serviceOrigin);
    if (!['http:', 'https:'].includes(serviceOrigin.protocol) || serviceOrigin.origin !== data.serviceOrigin) return null;
    return {
      serviceOrigin: serviceOrigin.origin,
      capabilityToken: data.capabilityToken,
      sourceId: data.sourceId,
      expectedParentOrigin: parentOrigin
    };
  } catch {
    return null;
  }
}

export function useAuthorRuntime(): AuthorRuntimeState & { retry(): void } {
  const [state, setState] = useState<AuthorRuntimeState>({ status: 'connecting', runtime: null });
  const accepted = useRef<TrustedAuthorRuntime | null>(null);
  const parentOrigin = useRef<string | null>(null);
  const retry = useCallback(() => {
    accepted.current = null;
    const expected = expectedParentOrigin();
    parentOrigin.current = expected;
    if (expected === null) {
      setState({ status: 'disconnected', runtime: null });
      return;
    }
    setState({ status: 'connecting', runtime: null });
    window.parent.postMessage({ type: 'courseweave.runtime.request.v1' }, expected);
  }, []);
  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const expected = parentOrigin.current;
      if (
        event.source !== window.parent
        || accepted.current !== null
        || expected === null
        || event.origin !== expected
      ) return;
      const runtime = parseRuntime(event.data, expected);
      if (runtime !== null) {
        accepted.current = runtime;
        setState({ status: 'ready', runtime });
      }
    };
    window.addEventListener('message', listener);
    retry();
    return () => window.removeEventListener('message', listener);
  }, [retry]);
  return { ...state, retry };
}

export function AuthorRuntimeProbe() {
  const runtime = useAuthorRuntime();
  return <output>{runtime.status}</output>;
}

export { parseRuntime as parseAuthorRuntimeMessage };
