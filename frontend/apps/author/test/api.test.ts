import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorApiError, createAuthorClient } from "../src/api";

const runtime = {
  serviceOrigin: "http://127.0.0.1:8765",
  capabilityToken: "author-token",
  sourceId: "author-window",
};
afterEach(() => vi.unstubAllGlobals());

describe("Author API", () => {
  it("uses authenticated GET and PUT requests with ETags, raw JSON, and caller signals", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response('{"id":"course"}', { headers: { etag: '"etag"' } }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const client = createAuthorClient(runtime);
    const getController = new AbortController();
    const putController = new AbortController();
    expect((await client.getCourse(getController.signal)).etag).toBe('"etag"');
    await client.putCourse(
      '{\n  "id": "course"\n}\n',
      '"etag"',
      putController.signal,
    );
    const get = fetch.mock.calls[0]?.[1] as RequestInit;
    const request = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(get.method).toBe("GET");
    expect(get.signal).toBe(getController.signal);
    expect(new Headers(get.headers).get("Authorization")).toBe(
      "Bearer author-token",
    );
    expect(new Headers(get.headers).get("Content-Type")).toBeNull();
    expect(request.method).toBe("PUT");
    expect(request.signal).toBe(putController.signal);
    expect(request.body).toBe('{\n  "id": "course"\n}\n');
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer author-token",
    );
    expect(new Headers(request.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(new Headers(request.headers).get("If-Match")).toBe('"etag"');
    expect(new Headers(request.headers).get("Idempotency-Key")).toBeTruthy();
    expect(String(fetch.mock.calls[1]?.[0])).not.toContain("author-token");
  });

  it("preserves the quoted empty ETag sentinel, required origin, and fresh Save idempotency keys", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("{}", { headers: { etag: '"next"' } })),
      );
    vi.stubGlobal("fetch", fetch);
    const client = createAuthorClient(runtime);
    await client.putCourse("{}\n", '""');
    await client.putCourse("{}\n", '"next"');
    const first = new Headers(
      (fetch.mock.calls[0]?.[1] as RequestInit).headers,
    );
    const second = new Headers(
      (fetch.mock.calls[1]?.[1] as RequestInit).headers,
    );
    expect(first.get("If-Match")).toBe('""');
    expect(first.get("X-CourseWeave-Origin")).toBe("student_requested");
    expect(first.get("Idempotency-Key")).toBeTruthy();
    expect(first.get("Idempotency-Key")).not.toBe(
      second.get("Idempotency-Key"),
    );
  });

  it("does not disclose a token from a hostile error and does not retry a mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "bad",
          message: "Bearer author-token",
          details: { token: "author-token" },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const failure = await createAuthorClient(runtime)
      .putCourse("{}", '"x"')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthorApiError);
    expect(String(failure)).not.toContain("author-token");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses exact authenticated JSON bodies, methods, fresh keys, and signals for every Author action", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    const client = createAuthorClient(runtime);
    const controllers = Array.from({ length: 7 }, () => new AbortController());
    const manifest = { schema_version: 2, title: "Draft" };
    const guide = { messages: [{ role: "user", content: "Help" }] };
    const edit = { expected_revision: 1, request: { summary: "Edited" } };
    const accept = { expected_revision: 2 };
    const reject = { expected_revision: 3 };
    await client.validateCourse(manifest, "structural", controllers[0]?.signal);
    await client.postGuide(guide, controllers[1]?.signal);
    await client.getProposals(controllers[2]?.signal);
    await client.createProposal("candidate-a", controllers[3]?.signal);
    await client.editProposal("proposal/a", edit, controllers[4]?.signal);
    await client.acceptProposal("proposal/a", accept, controllers[5]?.signal);
    await client.rejectProposal("proposal/a", reject, controllers[6]?.signal);

    const durable = fetch.mock.calls.slice(3);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:8765/api/author/validate",
      "http://127.0.0.1:8765/api/author/guide",
      "http://127.0.0.1:8765/api/proposals",
      "http://127.0.0.1:8765/api/proposals",
      "http://127.0.0.1:8765/api/proposals/proposal%2Fa/edit",
      "http://127.0.0.1:8765/api/proposals/proposal%2Fa/accept",
      "http://127.0.0.1:8765/api/proposals/proposal%2Fa/reject",
    ]);
    const requests = fetch.mock.calls.map(
      ([, request]) => request as RequestInit,
    );
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
    expect(requests.map((request) => request.signal)).toEqual(
      controllers.map((controller) => controller.signal),
    );
    expect(
      requests.every(
        (request) =>
          new Headers(request.headers).get("Authorization") ===
          "Bearer author-token",
      ),
    ).toBe(true);
    expect(new Headers(requests[2]?.headers).get("Content-Type")).toBeNull();
    for (const request of [...requests.slice(0, 2), ...requests.slice(3)]) {
      expect(new Headers(request.headers).get("Content-Type")).toBe(
        "application/json",
      );
    }
    expect(requests.map((request) => request.body)).toEqual([
      JSON.stringify({ manifest, mode: "structural" }),
      JSON.stringify(guide),
      undefined,
      JSON.stringify({ candidate_id: "candidate-a" }),
      JSON.stringify(edit),
      JSON.stringify(accept),
      JSON.stringify(reject),
    ]);
    const keys = durable.map(([, request]) =>
      new Headers(request.headers).get("Idempotency-Key"),
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys.every(Boolean)).toBe(true);
  });
});

it("registers and confirms a separately owned activity context and exact saved ETag", async () => {
  const context = {
    source_id: "author-learning-owned",
    sequence: 1,
    explicit_module_id: "m",
    explicit_phase_id: "p",
  };
  const resolved = {
    module_id: "m",
    phase_id: "p",
    surface_id: null,
    reason: "explicit_phase",
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(resolved)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ context, resolved })))
    .mockResolvedValueOnce(
      new Response("{}", { headers: { etag: '"saved"' } }),
    );
  vi.stubGlobal("fetch", fetch);
  await createAuthorClient(runtime).confirmActivity({
    source_id: context.source_id,
    sequence: 1,
    module_id: "m",
    phase_id: "p",
    manifest_etag: '"saved"',
  });
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(context);
  expect(fetch.mock.calls[1]![0]).toContain(
    "/api/context?source_id=author-learning-owned",
  );
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    method: "POST",
    credentials: "include",
  });
  expect(
    new Headers(fetch.mock.calls[0]![1].headers).get("Authorization"),
  ).toBe("Bearer author-token");
});
it("rejects mismatched context confirmation and changed byte ETags before guide dispatch", async () => {
  const selection = {
    source_id: "author-learning-owned",
    sequence: 1,
    module_id: "m",
    phase_id: "p",
    manifest_etag: '"saved"',
  };
  const resolved = {
    module_id: "m",
    phase_id: "p",
    surface_id: null,
    reason: "explicit_phase",
  };
  const context = {
    source_id: selection.source_id,
    sequence: 1,
    explicit_module_id: "m",
    explicit_phase_id: "p",
  };
  for (const [stored, etag] of [
    [{ context: { ...context, sequence: 2 }, resolved }, '"saved"'],
    [{ context, resolved }, '"changed"'],
  ] as const) {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(resolved)))
      .mockResolvedValueOnce(new Response(JSON.stringify(stored)))
      .mockResolvedValueOnce(new Response("{}", { headers: { etag } }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      createAuthorClient(runtime).confirmActivity(selection),
    ).rejects.toMatchObject({ code: "context_changed" });
  }
});
