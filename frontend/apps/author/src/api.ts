import { authenticatedHeaders } from "@courseweave/ui";
import type { AuthorRuntime } from "./runtime";
import type { CompatibilityReport } from "./compatibility";

export interface AuthorActivitySelection {
  module_id: string;
  phase_id: string;
  title: string;
  manifest_etag: string;
}
export interface AuthorActivityConfirmation {
  source_id: string;
  sequence: number;
  module_id: string;
  phase_id: string;
  manifest_etag: string;
}
export interface CourseResponse {
  manifest: unknown;
  etag: string;
  raw: string;
}
export interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export class AuthorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = "AuthorApiError";
  }
}

function freshKey(): string {
  return crypto.randomUUID();
}

function containsSecret(value: unknown, capabilityToken: string): boolean {
  if (typeof value === "string") return value.includes(capabilityToken);
  if (Array.isArray(value))
    return value.some((item) => containsSecret(item, capabilityToken));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.entries(value).some(
      ([key, item]) =>
        containsSecret(key, capabilityToken) ||
        containsSecret(item, capabilityToken),
    )
  );
}

function safeEnvelope(value: unknown, capabilityToken: string): ErrorEnvelope {
  const fallback = {
    code: "request_failed",
    message: "CourseWeave could not complete that request.",
    details: {},
  };
  if (
    typeof value !== "object" ||
    value === null ||
    containsSecret(value, capabilityToken)
  )
    return fallback;
  const candidate = value as Partial<ErrorEnvelope>;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string"
    ? {
        code: candidate.code,
        message: candidate.message,
        details: candidate.details ?? {},
      }
    : fallback;
}

export function createAuthorClient(runtime: AuthorRuntime) {
  const serviceOrigin = new URL(runtime.serviceOrigin).origin;
  const capabilityToken = runtime.capabilityToken;
  const request = async (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> => {
    const response = await fetch(`${serviceOrigin}${path}`, {
      ...init,
      signal,
      headers: authenticatedHeaders(capabilityToken, init.headers),
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const envelope = safeEnvelope(body, capabilityToken);
      throw new AuthorApiError(
        response.status,
        envelope.code,
        envelope.details,
        envelope.message,
      );
    }
    return response;
  };
  const json = <T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ) =>
    request(path, init, signal).then(
      async (response) => (await response.json()) as T,
    );
  const mutation = (path: string, body: unknown, signal?: AbortSignal) =>
    json(
      path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": freshKey(),
        },
        body: JSON.stringify(body),
      },
      signal,
    );
  return {
    async getCourse(signal?: AbortSignal): Promise<CourseResponse> {
      const response = await request("/api/course", { method: "GET" }, signal);
      const raw = await response.text();
      return {
        manifest: JSON.parse(raw),
        raw,
        etag: response.headers.get("etag") ?? "",
      };
    },
    async putCourse(
      raw: string,
      etag: string,
      signal?: AbortSignal,
    ): Promise<CourseResponse> {
      const response = await request(
        "/api/course",
        {
          method: "PUT",
          body: raw,
          headers: {
            "Content-Type": "application/json",
            "If-Match": etag,
            "Idempotency-Key": freshKey(),
            "X-CourseWeave-Origin": "student_requested",
          },
        },
        signal,
      );
      const result = await response.text();
      return {
        manifest: JSON.parse(result),
        raw: result,
        etag: response.headers.get("etag") ?? "",
      };
    },
    validateCourse: (
      manifest: unknown,
      mode: "structural" | "runnable",
      signal?: AbortSignal,
    ) =>
      json<{ manifest: unknown; formatted_json: string }>(
        "/api/author/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manifest, mode }),
        },
        signal,
      ),
    checkCompatibility: (manifest: unknown, student_version: "0.2.0" | "0.3.0", signal?: AbortSignal) =>
      json<CompatibilityReport>("/api/author/compatibility", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifest, student_version }),
      }, signal),
    async confirmActivity(
      selection: AuthorActivityConfirmation,
      signal?: AbortSignal,
    ): Promise<void> {
      const context = {
        source_id: selection.source_id,
        sequence: selection.sequence,
        explicit_module_id: selection.module_id,
        explicit_phase_id: selection.phase_id,
      };
      const changed = () =>
        new AuthorApiError(
          409,
          "context_changed",
          {},
          "The saved course or activity changed. Reload before asking again.",
        );
      const matches = (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        (value as { module_id?: unknown }).module_id === selection.module_id &&
        (value as { phase_id?: unknown }).phase_id === selection.phase_id &&
        (value as { reason?: unknown }).reason === "explicit_phase";
      const resolved = await json<unknown>(
        "/api/context",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(context),
        },
        signal,
      );
      if (!matches(resolved)) throw changed();
      const stored = await json<{
        context?: typeof context;
        resolved?: unknown;
      }>(
        `/api/context?source_id=${encodeURIComponent(selection.source_id)}`,
        {},
        signal,
      );
      if (
        !stored?.context ||
        stored.context.source_id !== selection.source_id ||
        stored.context.sequence !== selection.sequence ||
        stored.context.explicit_module_id !== selection.module_id ||
        stored.context.explicit_phase_id !== selection.phase_id ||
        !matches(stored.resolved)
      )
        throw changed();
      const course = await request("/api/course", { method: "GET" }, signal);
      const etag = course.headers.get("etag");
      await course.body?.cancel();
      if (etag !== selection.manifest_etag) throw changed();
    },
    postGuide: (body: unknown, signal?: AbortSignal) =>
      request(
        "/api/author/guide",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        signal,
      ),
    getProposals: (signal?: AbortSignal) =>
      json<unknown[]>("/api/proposals", { method: "GET" }, signal),
    createProposal: (candidateId: string, signal?: AbortSignal) =>
      mutation("/api/proposals", { candidate_id: candidateId }, signal),
    editProposal: (proposalId: string, body: unknown, signal?: AbortSignal) =>
      mutation(
        `/api/proposals/${encodeURIComponent(proposalId)}/edit`,
        body,
        signal,
      ),
    acceptProposal: (proposalId: string, body: unknown, signal?: AbortSignal) =>
      mutation(
        `/api/proposals/${encodeURIComponent(proposalId)}/accept`,
        body,
        signal,
      ),
    rejectProposal: (proposalId: string, body: unknown, signal?: AbortSignal) =>
      mutation(
        `/api/proposals/${encodeURIComponent(proposalId)}/reject`,
        body,
        signal,
      ),
  };
}
