import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorApiError, createAuthorClient } from '../src/api';

const runtime = { serviceOrigin: 'http://127.0.0.1:8765', capabilityToken: 'author-token', sourceId: 'author-window' };
afterEach(() => vi.unstubAllGlobals());

describe('Author API', () => {
  it('keeps the token in headers, captures ETags, and writes exact raw JSON once', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"id":"course"}', { headers: { etag: '"etag"' } })));
    vi.stubGlobal('fetch', fetch);
    const client = createAuthorClient(runtime);
    expect((await client.getCourse()).etag).toBe('"etag"');
    await client.putCourse('{\n  "id": "course"\n}\n', '"etag"');
    const request = fetch.mock.calls[1]?.[1] as RequestInit;
    expect(request.body).toBe('{\n  "id": "course"\n}\n');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer author-token');
    expect(new Headers(request.headers).get('If-Match')).toBe('"etag"');
    expect(new Headers(request.headers).get('Idempotency-Key')).toBeTruthy();
    expect(String(fetch.mock.calls[1]?.[0])).not.toContain('author-token');
  });

  it('does not disclose a token from a hostile error and does not retry a mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'bad', message: 'Bearer author-token', details: { token: 'author-token' } }), { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const failure = await createAuthorClient(runtime).putCourse('{}', '"x"').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthorApiError);
    expect(String(failure)).not.toContain('author-token');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('uses the exact Author proposal routes, fresh keys, and caller AbortSignals', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetch);
    const client = createAuthorClient(runtime);
    const controller = new AbortController();
    await client.validateCourse({ schema_version: 1 }, 'structural', controller.signal);
    await client.postGuide({ messages: [] }, controller.signal);
    await client.createProposal('candidate-a', controller.signal);
    await client.editProposal('proposal/a', { expected_revision: 1, request: {} }, controller.signal);
    await client.acceptProposal('proposal/a', { expected_revision: 2 }, controller.signal);
    await client.rejectProposal('proposal/a', { expected_revision: 3 }, controller.signal);

    const durable = fetch.mock.calls.slice(2);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:8765/api/author/validate',
      'http://127.0.0.1:8765/api/author/guide',
      'http://127.0.0.1:8765/api/proposals',
      'http://127.0.0.1:8765/api/proposals/proposal%2Fa/edit',
      'http://127.0.0.1:8765/api/proposals/proposal%2Fa/accept',
      'http://127.0.0.1:8765/api/proposals/proposal%2Fa/reject',
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get('Authorization')).toBe('Bearer author-token');
    expect(fetch.mock.calls.every(([, request]) => request.signal === controller.signal)).toBe(true);
    const keys = durable.map(([, request]) => new Headers(request.headers).get('Idempotency-Key'));
    expect(new Set(keys).size).toBe(4);
    expect(keys.every(Boolean)).toBe(true);
  });
});
