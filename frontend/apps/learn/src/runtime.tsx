import { useCallback, useEffect, useRef, useState } from 'react';
import { expectedParentOrigin } from '@courseweave/ui/parent-origin';

import type { RuntimeConfiguration } from './api';

export type TrustedRuntimeConfiguration = RuntimeConfiguration & { expectedParentOrigin: string };
export type ParentCaptureKind = 'selection' | 'cell' | 'output';
export type ParentCapture = { kind: ParentCaptureKind; content: string; label?: string };

export type RuntimeState =
  | { status: 'connecting'; runtime: null }
  | { status: 'ready'; runtime: TrustedRuntimeConfiguration }
  | { status: 'recovery'; runtime: null };

function parseRuntimeMessage(value: unknown, parentOrigin: string): TrustedRuntimeConfiguration | null {
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
    data.capabilityToken.length > 4096 ||
    data.sourceId.trim() !== data.sourceId ||
    data.sourceId.length === 0 ||
    data.sourceId.length > 240
  ) return null;
  try {
    const service = new URL(data.serviceOrigin);
    if (!['http:', 'https:'].includes(service.protocol) || service.origin !== data.serviceOrigin) return null;
    return {
      serviceOrigin: service.origin,
      capabilityToken: data.capabilityToken,
      sourceId: data.sourceId,
      expectedParentOrigin: parentOrigin
    };
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

function parseCaptureResult(value: unknown, requestId: string, kind: ParentCaptureKind, maxChars: number): ParentCapture | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'content,kind,label,requestId,type') return null;
  if (
    data.type !== 'courseweave.share.capture.result.v1'
    || data.requestId !== requestId
    || data.kind !== kind
    || typeof data.content !== 'string'
    || Array.from(data.content).length === 0
    || Array.from(data.content).length > maxChars
    || (data.label !== undefined && typeof data.label !== 'string')
  ) return null;
  return { kind, content: data.content, ...(data.label === undefined ? {} : { label: data.label }) };
}

function parseCaptureRejection(value: unknown, requestId: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'code,requestId,type') return null;
  return data.type === 'courseweave.share.capture.rejected.v1'
    && data.requestId === requestId
    && typeof data.code === 'string'
    && data.code.trim() === data.code
    && data.code.length > 0
    && data.code.length <= 120
    ? data.code
    : null;
}

export class ParentCaptureRequester {
  private pending: { requestId: string; kind: ParentCaptureKind; maxChars: number; resolve(value: ParentCapture): void; reject(error: Error): void } | null = null;
  private disposed = false;
  private readonly listener: (event: MessageEvent<unknown>) => void;
  private readonly requestId: () => string;

  constructor(private readonly options: { runtime: TrustedRuntimeConfiguration; hostWindow: Window; parentWindow: Window; requestId?: () => string }) {
    this.requestId = options.requestId ?? (() => crypto.randomUUID());
    this.listener = (event) => {
      const current = this.pending;
      if (current === null || event.source !== this.options.parentWindow || event.origin !== this.options.runtime.expectedParentOrigin) return;
      const result = parseCaptureResult(event.data, current.requestId, current.kind, current.maxChars);
      if (result !== null) {
        this.pending = null;
        current.resolve(result);
        return;
      }
      const code = parseCaptureRejection(event.data, current.requestId);
      if (code !== null) {
        this.pending = null;
        current.reject(new Error(code));
      }
    };
    options.hostWindow.addEventListener('message', this.listener);
  }

  request(kind: ParentCaptureKind, maxChars: number): Promise<ParentCapture> {
    if (this.disposed) return Promise.reject(new Error('disposed'));
    if (this.pending !== null) return Promise.reject(new Error('busy'));
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return Promise.reject(new Error('invalid_limit'));
    const requestId = this.requestId();
    const promise = new Promise<ParentCapture>((resolve, reject) => {
      this.pending = { requestId, kind, maxChars, resolve, reject };
    });
    this.options.parentWindow.postMessage(
      { type: 'courseweave.share.capture.request.v1', requestId, kind, maxChars },
      this.options.runtime.expectedParentOrigin
    );
    return promise;
  }

  cancel(): void {
    const current = this.pending;
    this.pending = null;
    current?.reject(new Error('cancelled'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.hostWindow.removeEventListener('message', this.listener);
    const current = this.pending;
    this.pending = null;
    current?.reject(new Error('disposed'));
  }

  toJSON(): { pendingRequestId: string | null } {
    return { pendingRequestId: this.pending?.requestId ?? null };
  }
}

export function useParentCapture(runtime: TrustedRuntimeConfiguration | null): (kind: ParentCaptureKind, maxChars: number) => Promise<ParentCapture> {
  const requester = useRef<ParentCaptureRequester | null>(null);
  useEffect(() => {
    requester.current?.dispose();
    requester.current = runtime === null ? null : new ParentCaptureRequester({ runtime, hostWindow: window, parentWindow: window.parent });
    return () => {
      requester.current?.dispose();
      requester.current = null;
    };
  }, [runtime]);
  return useCallback((kind, maxChars) => requester.current?.request(kind, maxChars) ?? Promise.reject(new Error('unavailable')), []);
}

export function useRuntimeBootstrap(): RuntimeState & { retry(): void; contextVersion: number } {
  const [state, setState] = useState<RuntimeState>({ status: 'connecting', runtime: null });
  const [contextVersion, setContextVersion] = useState(0);
  const activeRuntime = useRef<TrustedRuntimeConfiguration | null>(null);
  const parentOrigin = useRef<string | null>(null);
  const request = useCallback(() => {
    activeRuntime.current = null;
    setContextVersion(0);
    const expected = expectedParentOrigin();
    parentOrigin.current = expected;
    if (expected === null) {
      setState({ status: 'recovery', runtime: null });
      return;
    }
    setState({ status: 'connecting', runtime: null });
    window.parent.postMessage({ type: 'courseweave.runtime.request.v1' }, expected);
  }, []);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent) return;
      const expected = parentOrigin.current;
      if (expected !== null && event.origin === expected && activeRuntime.current === null) {
        const runtime = parseRuntimeMessage(event.data, expected);
        if (runtime !== null) {
          activeRuntime.current = runtime;
          setState({ status: 'ready', runtime });
          return;
        }
      }
      if (isContextChangedMessage(event.data)) {
        const current = activeRuntime.current;
        if (current !== null && event.origin === current.expectedParentOrigin && event.data.sourceId === current.sourceId) {
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
