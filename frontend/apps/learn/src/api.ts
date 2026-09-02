import type { CourseManifest, LearnerState, Proposal } from '@courseweave/ui/courseweave-types';

export interface RuntimeConfiguration {
  serviceOrigin: string;
  capabilityToken: string;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export class CourseweaveApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'CourseweaveApiError';
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
  }
}

function asErrorEnvelope(value: unknown): ErrorEnvelope {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as Partial<ErrorEnvelope>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return { code: candidate.code, message: candidate.message, details: candidate.details ?? {} };
    }
  }
  return { code: 'request_failed', message: 'CourseWeave could not complete that request.', details: {} };
}

function uuid(): string {
  return crypto.randomUUID();
}

export function createCourseweaveClient(runtime: RuntimeConfiguration) {
  const serviceOrigin = new URL(runtime.serviceOrigin).origin;
  const capabilityToken = runtime.capabilityToken;

  async function request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${capabilityToken}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${serviceOrigin}${path}`, {
      ...init,
      headers,
      signal,
      credentials: 'include',
      cache: 'no-store'
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new CourseweaveApiError(response.status, asErrorEnvelope(body));
    return body as T;
  }

  return {
    getCourse: (signal?: AbortSignal) => request<CourseManifest>('/api/course', {}, signal),
    getState: (signal?: AbortSignal) => request<LearnerState>('/api/state', {}, signal),
    getProposals: (signal?: AbortSignal) => request<Proposal[]>('/api/proposals', {}, signal),
    patchState: (
      body: { expected_revision: number; operation: Record<string, unknown> },
      signal?: AbortSignal
    ) => request<LearnerState>('/api/state', {
      method: 'PATCH',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify({ ...body, origin: 'student_requested' })
    }, signal)
  };
}
