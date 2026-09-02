import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CourseweaveApiError,
  createCourseweaveClient
} from '../src/api';

const runtime = {
  serviceOrigin: 'http://127.0.0.1:8765',
  capabilityToken: 'test-capability-token'
};

afterEach(() => vi.unstubAllGlobals());

describe('createCourseweaveClient', () => {
  it('sends the bearer capability only in headers for all learner reads', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: true }), {
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch);
    const client = createCourseweaveClient(runtime);

    await Promise.all([client.getCourse(), client.getState(), client.getProposals()]);

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, request] of fetch.mock.calls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8765\/api\/(course|state|proposals)$/);
      expect(new Headers(request.headers).get('Authorization')).toBe(
        'Bearer test-capability-token'
      );
      expect(request.credentials).toBe('include');
      expect(request.cache).toBe('no-store');
    }
  });

  it('returns a typed secret-safe error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'not_configured',
            message: 'Provider unavailable',
            details: {}
          }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(createCourseweaveClient(runtime).getCourse()).rejects.toMatchObject({
      name: 'CourseweaveApiError',
      code: 'not_configured',
      message: 'Provider unavailable'
    } satisfies Partial<CourseweaveApiError>);
  });

  it('does not retry a rejected learner mutation', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'revision_mismatch', message: 'Refresh state', details: {} }), {
        status: 409,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch);

    await expect(
      createCourseweaveClient(runtime).patchState({ expected_revision: 1, operation: { type: 'complete_phase' } })
    ).rejects.toBeInstanceOf(CourseweaveApiError);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
