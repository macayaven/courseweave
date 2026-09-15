import { authenticatedHeaders } from "@courseweave/ui";
import type { AuthorRuntime } from "./runtime";
import type { CompatibilityReport } from "./compatibility";
import type { Inventory, Project, ProjectList, ProjectRequest, SourceRecord, SourceDecision } from "./project-panel";
import type { ContentApply, ContentChange, ContentClient, ContentEdit, ContentReview, ContentSnapshot } from "./content-panel";
import type { AuthorAssistantClient, ContextPreview } from "./curriculum-thread";
import type { ResearchClient, ResearchRequest, ResearchReport, ResearchStatus, SourceText } from "./source-panel";
import type { ReviewClient, ReviewDecision, ReviewReport } from "./review-panel";
import type { CoverageReport } from "./coverage-panel";
import type { DeliveryClient, DeliveryInventory, CourseExportRequest, CourseExportReceipt, StudentBundleReceipt } from "./delivery-panel";

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

export function createAuthorClient(runtime: AuthorRuntime, projectId?: string | null) {
  const serviceOrigin = new URL(runtime.serviceOrigin).origin;
  const capabilityToken = runtime.capabilityToken;
  const request = async (
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> => {
    const headers = authenticatedHeaders(capabilityToken, init.headers);
    if (projectId) headers.set("X-CourseWeave-Project", projectId);
    const response = await fetch(`${serviceOrigin}${path}`, {
      ...init,
      signal,
      headers,
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
    inspectDelivery: (signal?: AbortSignal) => json<DeliveryInventory>("/api/author/delivery", {}, signal),
    buildStudentBundle: (body: Parameters<DeliveryClient["buildStudentBundle"]>[0], signal?: AbortSignal) => json<StudentBundleReceipt>("/api/author/student-bundles", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    getExports: (offset = 0, signal?: AbortSignal) => json<Awaited<ReturnType<DeliveryClient["getExports"]>>>("/api/author/exports?offset=" + offset, {}, signal),
    exportCourse: (body: CourseExportRequest, signal?: AbortSignal) => json<CourseExportReceipt>("/api/author/exports", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    getReviews: (offset = 0, signal?: AbortSignal) => json<Awaited<ReturnType<ReviewClient["getReviews"]>>>("/api/author/reviews?offset=" + offset, {}, signal),
    getReview: (id: string, signal?: AbortSignal) => json<ReviewReport>("/api/author/reviews/" + encodeURIComponent(id), {}, signal),
    updateReviewFinding: (id: string, claimId: string, body: ReviewDecision, signal?: AbortSignal) => json<ReviewReport>(
      `/api/author/reviews/${encodeURIComponent(id)}/findings/${encodeURIComponent(claimId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, signal),
    deleteReview: async (id: string, reviewed_revision: number, signal?: AbortSignal): Promise<void> => {
      await request("/api/author/reviews/" + encodeURIComponent(id), {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewed_revision }),
      }, signal);
    },
    exportReview: (id: string, revision: number, signal?: AbortSignal) => request("/api/author/reviews/" + encodeURIComponent(id) + "/export?revision=" + revision, {}, signal).then(response => response.blob()),
    getCoverage: (offset = 0, signal?: AbortSignal) => json<CoverageReport>("/api/author/coverage?offset=" + offset, {}, signal),
    getResearchStatus: (signal?: AbortSignal) => json<ResearchStatus>("/api/author/research", {}, signal),
    getResearchReports: (offset = 0, signal?: AbortSignal) => json<Awaited<ReturnType<ResearchClient["getResearchReports"]>>>("/api/author/research/reports?offset=" + offset, {}, signal),
    getResearchReport: (id: string, signal?: AbortSignal) => json<ResearchReport>("/api/author/research/reports/" + encodeURIComponent(id), {}, signal),
    runResearch: (body: ResearchRequest, signal?: AbortSignal) => json<ResearchReport>("/api/author/research", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    cancelResearch: (signal?: AbortSignal) => json("/api/author/research/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }, signal),
    importReference: (path: string, signal?: AbortSignal) => json<SourceRecord>("/api/author/sources/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
    }, signal),
    getSourceText: (id: string, revision: number, start = 0, signal?: AbortSignal) => json<SourceText>("/api/author/sources/" + encodeURIComponent(id) + "/text?revision=" + revision + "&start=" + start, {}, signal),
    previewAuthorContext: (body: Parameters<AuthorAssistantClient["previewAuthorContext"]>[0], signal?: AbortSignal) => json<ContextPreview>("/api/author/assistant/context", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    saveAuthorDraft: (id: string, signal?: AbortSignal) => json<ContentChange>("/api/author/assistant/drafts/" + encodeURIComponent(id) + "/save", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }, signal),
    saveAuthorReview: (id: string, signal?: AbortSignal) => json<ReviewReport>("/api/author/assistant/drafts/" + encodeURIComponent(id) + "/save-review", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }, signal),
    getContentFiles: (signal?: AbortSignal) => json<Awaited<ReturnType<ContentClient["getContentFiles"]>>>("/api/author/content/files", {}, signal),
    getContent: (path: string, signal?: AbortSignal) => json<ContentSnapshot>("/api/author/content?path=" + encodeURIComponent(path), {}, signal),
    getChanges: (offset = 0, signal?: AbortSignal) => json<{ changes: ContentChange[]; total: number }>("/api/author/changes?offset=" + offset, {}, signal),
    stageContent: (body: ContentEdit, signal?: AbortSignal) => json<ContentChange>("/api/author/changes", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    getChange: (id: string, signal?: AbortSignal) => json<ContentReview>("/api/author/changes/" + encodeURIComponent(id), {}, signal),
    applyChange: (id: string, body: ContentApply, signal?: AbortSignal) => json("/api/author/changes/" + encodeURIComponent(id) + "/apply", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    rejectChange: (id: string, reviewed_revision: number, signal?: AbortSignal) => json<ContentChange>("/api/author/changes/" + encodeURIComponent(id) + "/reject", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewed_revision }),
    }, signal),
    getProjects: (signal?: AbortSignal) => json<ProjectList>("/api/author/projects", {}, signal),
    inspectSource: (source_root: string, signal?: AbortSignal) => json<Inventory>("/api/author/projects/inventory", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_root }),
    }, signal),
    createProject: (body: ProjectRequest, signal?: AbortSignal) => json<Project>("/api/author/projects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
    getSources: (signal?: AbortSignal) => json<{ sources: SourceRecord[] }>("/api/author/sources", {}, signal),
    updateSource: (id: string, body: SourceDecision, signal?: AbortSignal) => json<SourceRecord>(`/api/author/sources/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, signal),
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
