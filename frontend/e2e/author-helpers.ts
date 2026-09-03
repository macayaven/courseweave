import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, type FrameLocator, type Page, type Route } from "playwright/test";

export type JsonObject = Record<string, unknown>;
type ValidationIssue = { path: string; code: string; message: string };

export type ProposalFixture = JsonObject & {
  id: string;
  revision: number;
  status: "pending" | "accepted" | "rejected" | "superseded" | "failed";
  payload: { manifest: JsonObject };
  target_hash: string | null;
};

export type AuthorApiFixture = {
  manifest: JsonObject;
  raw: string;
  etag: string;
  proposals: ProposalFixture[];
  candidates: Map<string, JsonObject>;
  guideManifests: JsonObject[];
  providerNotConfigured: boolean;
  staleRemote: JsonObject | null;
  validationIssue(manifest: JsonObject, mode: "structural" | "runnable"): ValidationIssue[];
  counts: {
    courseGets: number;
    proposalGets: number;
    structuralValidations: number;
    runnableValidations: number;
    puts: number;
    guides: number;
    candidates: number;
    edits: number;
    accepts: number;
    rejects: number;
  };
  authenticatedRequests: number;
  mutations: string[];
  violations: string[];
};

const serviceOrigin = "http://127.0.0.1:4174";
const capabilityToken = "browser-test-capability";

export function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function loadExample(name: "minimal-course" | "cli-course"): JsonObject {
  return JSON.parse(
    readFileSync(new URL(`../../examples/${name}/courseweave.json`, import.meta.url), "utf8"),
  ) as JsonObject;
}

export function minimalManifest(): JsonObject {
  return loadExample("minimal-course");
}

export function emptyManifest(): JsonObject {
  return {
    schema_version: 1,
    id: "new-course",
    title: "New Course",
    description: "",
    entry_module_id: null,
    policies: {
      content_sharing: "explicit_only",
      durable_mutation: "proposal_or_direct_student_action",
      terminal_execution: "student_only",
      conversation_memory: "session_only",
      max_shared_chars: 8192,
      workspace_write_globs: [],
    },
    modules: [],
  };
}

function ordinaryValidationIssues(manifest: JsonObject): ValidationIssue[] {
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex] as JsonObject;
    const phases = Array.isArray(module.phases) ? module.phases : [];
    if (phases.length === 0) {
      return [{
        path: `/modules/${moduleIndex}/phases`,
        code: "schema_validation",
        message: "A module needs at least one phase.",
      }];
    }
    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
      const phase = phases[phaseIndex] as JsonObject;
      if (typeof phase.title !== "string" || phase.title.trim().length === 0) {
        return [{
          path: `/modules/${moduleIndex}/phases/${phaseIndex}/title`,
          code: "schema_validation",
          message: "Phase title must contain text.",
        }];
      }
    }
  }
  return [];
}

export function createAuthorApi(
  manifest: JsonObject,
  options: {
    exists?: boolean;
    providerNotConfigured?: boolean;
    proposals?: ProposalFixture[];
    guideManifests?: JsonObject[];
    validationIssue?: AuthorApiFixture["validationIssue"];
  } = {},
): AuthorApiFixture {
  const raw = canonical(manifest);
  return {
    manifest,
    raw,
    etag: options.exists === false ? '""' : `"${sha256(raw)}"`,
    proposals: options.proposals ?? [],
    candidates: new Map(),
    guideManifests: [...(options.guideManifests ?? [])],
    providerNotConfigured: options.providerNotConfigured ?? false,
    staleRemote: null,
    validationIssue: options.validationIssue ?? ((value) => ordinaryValidationIssues(value)),
    counts: {
      courseGets: 0,
      proposalGets: 0,
      structuralValidations: 0,
      runnableValidations: 0,
      puts: 0,
      guides: 0,
      candidates: 0,
      edits: 0,
      accepts: 0,
      rejects: 0,
    },
    authenticatedRequests: 0,
    mutations: [],
    violations: [],
  };
}

export function seedProposal(
  api: AuthorApiFixture,
  manifest: JsonObject,
  id = `browser-proposal-${api.proposals.length + 1}`,
  summary = "Review the browser proposal",
): ProposalFixture {
  const targetHash = api.etag === '""' ? null : api.etag.slice(1, -1);
  const proposal: ProposalFixture = {
    id,
    revision: 1,
    type: "manifest_replace",
    origin: "teacher_suggested",
    status: "pending",
    summary,
    created_at: "2026-09-03T00:00:00Z",
    target: "courseweave.json",
    payload: { manifest },
    target_hash: targetHash,
    result: null,
  };
  api.proposals.push(proposal);
  return proposal;
}

export function proposalFixture(manifest: JsonObject): AuthorApiFixture {
  const api = createAuthorApi(manifest);
  seedProposal(api, manifest, "browser-proposal");
  return api;
}

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
}

function exactJson(request: ReturnType<Route["request"]>): JsonObject | null {
  try {
    const parsed = request.postDataJSON() as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function mutationHeaders(route: Route, api: AuthorApiFixture): boolean {
  const headers = route.request().headers();
  if (
    headers["content-type"] !== "application/json" ||
    typeof headers["idempotency-key"] !== "string" ||
    headers["idempotency-key"].length === 0
  ) {
    api.violations.push(`mutation-headers:${route.request().url()}`);
    return false;
  }
  return true;
}

function updateCourse(api: AuthorApiFixture, manifest: JsonObject): void {
  api.manifest = manifest;
  api.raw = canonical(manifest);
  api.etag = `"${sha256(api.raw)}"`;
}

function findProposal(api: AuthorApiFixture, id: string): ProposalFixture | null {
  return api.proposals.find((proposal) => proposal.id === id) ?? null;
}

function replaceProposal(api: AuthorApiFixture, next: ProposalFixture): void {
  api.proposals = api.proposals.map((proposal) => proposal.id === next.id ? next : proposal);
}

async function handleApi(route: Route, api: AuthorApiFixture): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  if (url.origin !== serviceOrigin) {
    api.violations.push(`external:${method}:${request.url()}`);
    await route.abort();
    return;
  }
  if (request.headers().authorization !== `Bearer ${capabilityToken}`) {
    api.violations.push(`auth:${method}:${url.pathname}`);
    await route.abort();
    return;
  }
  api.authenticatedRequests += 1;

  if (method === "GET" && url.pathname === "/api/course" && url.search === "") {
    api.counts.courseGets += 1;
    await route.fulfill({ contentType: "application/json", headers: { etag: api.etag }, body: api.raw });
    return;
  }
  if (method === "GET" && url.pathname === "/api/proposals" && url.search === "") {
    api.counts.proposalGets += 1;
    await json(route, api.proposals);
    return;
  }
  if (method === "POST" && url.pathname === "/api/author/validate" && url.search === "") {
    const body = exactJson(request);
    if (
      request.headers()["content-type"] !== "application/json" ||
      body === null ||
      Object.keys(body).sort().join(",") !== "manifest,mode" ||
      (body.mode !== "structural" && body.mode !== "runnable") ||
      typeof body.manifest !== "object" || body.manifest === null || Array.isArray(body.manifest)
    ) {
      api.violations.push(`validate-contract:${request.postData() ?? ""}`);
      await route.abort();
      return;
    }
    const mode = body.mode;
    api.counts[mode === "structural" ? "structuralValidations" : "runnableValidations"] += 1;
    const manifest = body.manifest as JsonObject;
    const issues = api.validationIssue(manifest, mode);
    if (issues.length > 0) {
      await json(route, { code: "validation_error", message: "Course validation failed.", details: { issues } }, 422);
      return;
    }
    await json(route, { manifest, formatted_json: canonical(manifest) });
    return;
  }
  if (method === "PUT" && url.pathname === "/api/course" && url.search === "") {
    api.counts.puts += 1;
    const headers = request.headers();
    const raw = request.postData() ?? "";
    let manifest: JsonObject | null = null;
    try { manifest = JSON.parse(raw) as JsonObject; } catch { /* contract tripwire below */ }
    if (
      headers["content-type"] !== "application/json" ||
      headers["if-match"] !== api.etag ||
      headers["x-courseweave-origin"] !== "student_requested" ||
      typeof headers["idempotency-key"] !== "string" || headers["idempotency-key"].length === 0 ||
      manifest === null || canonical(manifest) !== raw
    ) {
      api.violations.push(`put-contract:${headers["if-match"] ?? "missing"}:${raw}`);
      await route.abort();
      return;
    }
    api.mutations.push(`put:${headers["idempotency-key"]}`);
    if (api.staleRemote !== null) {
      const remote = api.staleRemote;
      api.staleRemote = null;
      updateCourse(api, remote);
      await json(route, { code: "etag_mismatch", message: "The course changed.", details: {} }, 409);
      return;
    }
    updateCourse(api, manifest);
    await route.fulfill({ contentType: "application/json", headers: { etag: api.etag }, body: api.raw });
    return;
  }
  if (method === "POST" && url.pathname === "/api/author/guide" && url.search === "") {
    const body = exactJson(request);
    api.counts.guides += 1;
    if (
      request.headers()["content-type"] !== "application/json" || body === null ||
      Object.keys(body).sort().join(",") !== "context,forwardedProps,messages,runId,threadId,tools" ||
      !Array.isArray(body.messages) || body.messages.length !== 1 ||
      !Array.isArray(body.tools) || body.tools.length !== 0 ||
      !Array.isArray(body.context) || body.context.length !== 0 ||
      typeof body.threadId !== "string" || typeof body.runId !== "string" ||
      JSON.stringify(body.forwardedProps) !== JSON.stringify({ source_id: "browser-author-source" })
    ) {
      api.violations.push(`guide-contract:${request.postData() ?? ""}`);
      await route.abort();
      return;
    }
    if (api.providerNotConfigured) {
      await json(route, { code: "not_configured", message: "Teacher unavailable.", details: {} }, 503);
      return;
    }
    const proposalManifest = api.guideManifests.shift();
    const candidateId = `candidate-${api.counts.guides}`;
    const candidate = proposalManifest === undefined ? "" :
      `data: ${JSON.stringify({
        type: "CUSTOM", name: "courseweave.proposal_candidate",
        value: { candidate: {
          id: candidateId, type: "manifest_replace", origin: "teacher_suggested",
          summary: "Local fake model suggestion", target: "courseweave.json",
          payload: { manifest: proposalManifest },
          target_hash: api.etag === '""' ? null : api.etag.slice(1, -1),
        } },
      })}\n\n`;
    if (proposalManifest !== undefined) api.candidates.set(candidateId, proposalManifest);
    const wire =
      `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: body.threadId, runId: body.runId })}\n\n` +
      `data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\n` +
      `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"Local fixture advice"}\n\n` +
      `data: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n` + candidate +
      `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId })}\n\n`;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: wire });
    return;
  }
  if (method === "POST" && url.pathname === "/api/proposals" && url.search === "") {
    const body = exactJson(request);
    if (!mutationHeaders(route, api) || body === null || Object.keys(body).join(",") !== "candidate_id" || typeof body.candidate_id !== "string") {
      api.violations.push(`candidate-contract:${request.postData() ?? ""}`);
      await route.abort();
      return;
    }
    const candidate = api.candidates.get(body.candidate_id);
    if (candidate === undefined) {
      api.violations.push(`unknown-candidate:${body.candidate_id}`);
      await route.abort();
      return;
    }
    api.counts.candidates += 1;
    api.mutations.push(`candidate:${body.candidate_id}`);
    const proposal = seedProposal(api, candidate, `proposal-${api.counts.candidates}`, "Local fake model suggestion");
    await json(route, proposal);
    return;
  }

  const action = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(edit|accept|reject)$/);
  if (method === "POST" && action !== null && url.search === "") {
    const id = decodeURIComponent(action[1]!);
    const kind = action[2] as "edit" | "accept" | "reject";
    const proposal = findProposal(api, id);
    const body = exactJson(request);
    if (!mutationHeaders(route, api) || proposal === null || body === null) {
      api.violations.push(`${kind}-contract:${id}:${request.postData() ?? ""}`);
      await route.abort();
      return;
    }
    if (kind === "edit") {
      const requestBody = body.request as JsonObject | undefined;
      const payload = requestBody?.payload as JsonObject | undefined;
      const manifest = payload?.manifest;
      if (
        Object.keys(body).sort().join(",") !== "expected_revision,request" || body.expected_revision !== proposal.revision ||
        requestBody === undefined || Object.keys(requestBody).sort().join(",") !== "payload,target_hash" ||
        requestBody.target_hash !== proposal.target_hash || typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
      ) {
        api.violations.push(`edit-body:${request.postData() ?? ""}`);
        await route.abort();
        return;
      }
      api.counts.edits += 1;
      api.mutations.push(`edit:${id}:${proposal.revision}`);
      const next: ProposalFixture = { ...proposal, revision: proposal.revision + 1, status: "pending", payload: { manifest: manifest as JsonObject } };
      replaceProposal(api, next);
      await json(route, next);
      return;
    }
    if (Object.keys(body).join(",") !== "expected_revision" || body.expected_revision !== proposal.revision) {
      api.violations.push(`${kind}-body:${request.postData() ?? ""}`);
      await route.abort();
      return;
    }
    if (kind === "reject") {
      api.counts.rejects += 1;
      api.mutations.push(`reject:${id}:${proposal.revision}`);
      const next: ProposalFixture = { ...proposal, status: "rejected" };
      replaceProposal(api, next);
      await json(route, next);
      return;
    }
    api.counts.accepts += 1;
    api.mutations.push(`accept:${id}:${proposal.revision}`);
    updateCourse(api, proposal.payload.manifest);
    const next: ProposalFixture = { ...proposal, status: "accepted", result: { etag: api.etag } };
    replaceProposal(api, next);
    await json(route, next);
    return;
  }

  api.violations.push(`unhandled-api:${method}:${url.pathname}${url.search}`);
  await route.abort();
}

export async function mountAuthor(page: Page, api: AuthorApiFixture, options: { width?: number } = {}): Promise<FrameLocator> {
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === serviceOrigin && (url.pathname === "/author/" || url.pathname.startsWith("/author/assets/"))) {
      await route.continue();
      return;
    }
    api.violations.push(`unhandled-network:${route.request().method()}:${route.request().url()}`);
    await route.abort();
  });
  await page.route("**/api/**", (route) => handleApi(route, api));
  await page.goto("/author/");
  await page.evaluate((width) => {
    document.body.replaceChildren();
    document.body.style.margin = "0";
    document.documentElement.dataset.unexpectedAuthorMessages = "0";
    document.documentElement.dataset.runtimeRequests = "0";
    const frame = document.createElement("iframe");
    frame.id = "author-frame";
    frame.title = "CourseWeave Author host";
    frame.style.border = "0";
    frame.style.width = `${width}px`;
    frame.style.height = "1400px";
    frame.src = "/author/";
    window.addEventListener("message", (event) => {
      if (event.source === window) return;
      const data = event.data as Record<string, unknown>;
      if (data?.type === "courseweave.runtime.request.v1" && Object.keys(data).join(",") === "type") {
        document.documentElement.dataset.runtimeRequests = String(Number(document.documentElement.dataset.runtimeRequests ?? "0") + 1);
        (event.source as Window).postMessage({
          type: "courseweave.runtime.v1", serviceOrigin: window.location.origin,
          capabilityToken: "browser-test-capability", sourceId: "browser-author-source",
        }, event.origin);
        return;
      }
      document.documentElement.dataset.unexpectedAuthorMessages = String(Number(document.documentElement.dataset.unexpectedAuthorMessages ?? "0") + 1);
    });
    document.body.append(frame);
  }, options.width ?? 1024);

  const author = page.frameLocator("#author-frame");
  await expect(author.getByText("Draft matches the loaded course.")).toBeVisible();
  return author;
}

export async function reloadAuthor(page: Page, author: FrameLocator): Promise<void> {
  await page.locator("#author-frame").evaluate((frame) => { (frame as HTMLIFrameElement).contentWindow?.location.reload(); });
  await expect(author.getByText("Draft matches the loaded course.")).toBeVisible();
}

export async function expectNoBoundaryViolations(page: Page, api: AuthorApiFixture): Promise<void> {
  expect(api.violations).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.unexpectedAuthorMessages)).toBe("0");
}
