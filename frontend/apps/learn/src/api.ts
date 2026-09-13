import type {
  CourseManifest,
  LearnerState,
  Proposal,
} from "@courseweave/ui/courseweave-types";

export interface RuntimeConfiguration {
  serviceOrigin: string;
  capabilityToken: string;
  sourceId: string;
}

export interface StoredContext {
  context: { source_id: string; video_seconds?: number | null };
  resolved: {
    module_id: string | null;
    phase_id: string | null;
    surface_id: string | null;
    reason: string;
  };
}

export interface GuideActionResponse {
  thread_id: string;
  assistant_name: "Course assistant";
  module_id: string;
  phase_id: string;
  status: "hint" | "unavailable" | "blocked" | "declined";
  message: string;
  hint?: { id: string; text: string; objective_ids: string[] } | null;
  hint_index?: number;
}
export interface LessonResponse {
  status: "active" | "reset";
  scope: import("@courseweave/ui").LessonScopeMetadata | null;
  message?: string;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export type { StateOperation } from "@courseweave/ui/courseweave-types";
import type { StateOperation } from "@courseweave/ui/courseweave-types";

export interface ProposalEditRequest {
  summary?: string;
  payload?: Record<string, unknown>;
  target_hash?: string;
}

export class CourseweaveApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = "CourseweaveApiError";
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
  }
}

function containsCapability(value: unknown, capabilityToken: string): boolean {
  if (typeof value === "string") return value.includes(capabilityToken);
  if (Array.isArray(value))
    return value.some((item) => containsCapability(item, capabilityToken));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) =>
        containsCapability(key, capabilityToken) ||
        containsCapability(item, capabilityToken),
    );
  }
  return false;
}

function asErrorEnvelope(
  value: unknown,
  capabilityToken: string,
): ErrorEnvelope {
  const fallback: ErrorEnvelope = {
    code: "request_failed",
    message: "CourseWeave could not complete that request.",
    details: {},
  };
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ErrorEnvelope>;
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      if (containsCapability(candidate, capabilityToken)) return fallback;
      return {
        code: candidate.code,
        message: candidate.message,
        details: candidate.details ?? {},
      };
    }
  }
  return fallback;
}

function uuid(): string {
  return crypto.randomUUID();
}

function isStoredContext(
  value: unknown,
  sourceId: string,
): value is StoredContext {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const stored = value as Record<string, unknown>;
  if (
    typeof stored.context !== "object" ||
    stored.context === null ||
    Array.isArray(stored.context)
  )
    return false;
  if (
    typeof stored.resolved !== "object" ||
    stored.resolved === null ||
    Array.isArray(stored.resolved)
  )
    return false;
  const context = stored.context as Record<string, unknown>;
  const resolved = stored.resolved as Record<string, unknown>;
  const optionalString = (item: unknown) =>
    item === null || typeof item === "string";
  const videoSeconds = context.video_seconds;
  return (
    context.source_id === sourceId &&
    (videoSeconds === undefined ||
      videoSeconds === null ||
      (typeof videoSeconds === "number" &&
        Number.isFinite(videoSeconds) &&
        videoSeconds >= 0)) &&
    optionalString(resolved.module_id) &&
    optionalString(resolved.phase_id) &&
    optionalString(resolved.surface_id) &&
    typeof resolved.reason === "string"
  );
}

export function createCourseweaveClient(runtime: RuntimeConfiguration) {
  const serviceOrigin = new URL(runtime.serviceOrigin).origin;
  const capabilityToken = runtime.capabilityToken;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${capabilityToken}`);
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    const response = await fetch(`${serviceOrigin}${path}`, {
      ...init,
      headers,
      signal,
      credentials: "include",
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new CourseweaveApiError(
        response.status,
        asErrorEnvelope(body, capabilityToken),
      );
    return body as T;
  }

  async function streamRequest(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(`${serviceOrigin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${capabilityToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      throw new CourseweaveApiError(
        response.status,
        asErrorEnvelope(error, capabilityToken),
      );
    }
    if (response.body === null)
      throw new CourseweaveApiError(502, {
        code: "invalid_stream",
        message: "CourseWeave returned an invalid teacher stream.",
        details: {},
      });
    return response;
  }

  return {
    getBootstrap: (signal?: AbortSignal) =>
      request<LearnerState & { manifest: CourseManifest }>(
        "/api/bootstrap",
        {},
        signal,
      ),
    guideAction: (
      body: {
        thread_id: string;
        source_id: string;
        action: "hint" | "decline_revisit";
      },
      signal?: AbortSignal,
    ) =>
      request<GuideActionResponse>(
        "/api/guide/action",
        { method: "POST", body: JSON.stringify(body) },
        signal,
      ),
    guideLesson: (
      body: {
        thread_id: string;
        source_id?: string;
        action: "use_lesson" | "reset_lesson";
      },
      signal?: AbortSignal,
    ) =>
      request<LessonResponse>(
        "/api/guide/lesson",
        { method: "POST", body: JSON.stringify(body) },
        signal,
      ),
    getCourse: (signal?: AbortSignal) =>
      request<CourseManifest>("/api/course", {}, signal),
    getState: (signal?: AbortSignal) =>
      request<LearnerState>("/api/state", {}, signal),
    getProposals: (signal?: AbortSignal) =>
      request<Proposal[]>("/api/proposals", {}, signal),
    getContext: async (signal?: AbortSignal) => {
      const context = await request<unknown>(
        `/api/context?source_id=${encodeURIComponent(runtime.sourceId)}`,
        {},
        signal,
      );
      if (!isStoredContext(context, runtime.sourceId)) {
        throw new CourseweaveApiError(502, {
          code: "invalid_context",
          message: "CourseWeave returned an invalid active context.",
          details: {},
        });
      }
      return context;
    },
    postGuide: (
      body: {
        threadId: string;
        runId: string;
        messages: Array<{ id: string; role: "user"; content: string }>;
        tools: [];
        context: [];
        forwardedProps: { source_id?: string };
      },
      signal?: AbortSignal,
    ) => streamRequest("/api/guide", body, signal),
    share: (
      body: {
        run_id: string;
        kind: "selection" | "cell" | "output" | "text";
        content: string;
        label?: string;
        source_id?: string;
      },
      signal?: AbortSignal,
    ) =>
      request<{ run_id: string; kind: string; char_count: number }>(
        "/api/share",
        { method: "POST", body: JSON.stringify(body) },
        signal,
      ),
    createProposal: (candidateId: string, signal?: AbortSignal) =>
      request<Proposal>(
        "/api/proposals",
        {
          method: "POST",
          headers: { "Idempotency-Key": uuid() },
          body: JSON.stringify({ candidate_id: candidateId }),
        },
        signal,
      ),
    patchState: (
      body: { expected_revision: number; operation: StateOperation },
      signal?: AbortSignal,
    ) =>
      request<LearnerState>(
        "/api/state",
        {
          method: "PATCH",
          headers: { "Idempotency-Key": uuid() },
          body: JSON.stringify({ ...body, origin: "student_requested" }),
        },
        signal,
      ),
    refreshLearnerData: (signal?: AbortSignal) =>
      Promise.all([
        request<LearnerState>("/api/state", {}, signal),
        request<Proposal[]>("/api/proposals", {}, signal),
      ]),
    acceptProposal: (
      proposalId: string,
      body: { expected_revision: number },
      signal?: AbortSignal,
    ) =>
      request<Proposal>(
        `/api/proposals/${encodeURIComponent(proposalId)}/accept`,
        {
          method: "POST",
          headers: { "Idempotency-Key": uuid() },
          body: JSON.stringify(body),
        },
        signal,
      ),
    rejectProposal: (
      proposalId: string,
      body: { expected_revision: number },
      signal?: AbortSignal,
    ) =>
      request<Proposal>(
        `/api/proposals/${encodeURIComponent(proposalId)}/reject`,
        {
          method: "POST",
          headers: { "Idempotency-Key": uuid() },
          body: JSON.stringify(body),
        },
        signal,
      ),
    editProposal: (
      proposalId: string,
      body: { expected_revision: number; request: ProposalEditRequest },
      signal?: AbortSignal,
    ) =>
      request<Proposal>(
        `/api/proposals/${encodeURIComponent(proposalId)}/edit`,
        {
          method: "POST",
          headers: { "Idempotency-Key": uuid() },
          body: JSON.stringify(body),
        },
        signal,
      ),
  };
}
