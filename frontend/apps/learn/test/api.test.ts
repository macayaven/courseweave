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

  it('never exposes the closure-held bearer in a malicious error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'provider_error',
            message: 'Bearer test-capability-token was rejected',
            details: { nested: { authorization: 'Bearer test-capability-token' } }
          }),
          { status: 502, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const error = await createCourseweaveClient(runtime).getCourse().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CourseweaveApiError);
    expect(String(error)).not.toContain('test-capability-token');
    expect((error as Error).message).not.toContain('test-capability-token');
    expect(JSON.stringify(error)).not.toContain('test-capability-token');
    expect(JSON.stringify((error as CourseweaveApiError).details)).not.toContain('test-capability-token');
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
      createCourseweaveClient(runtime).patchState({ expected_revision: 1, operation: { type: 'complete_phase', module_id: 's01', phase_id: 'orient', record_id: 'complete' } })
    ).rejects.toBeInstanceOf(CourseweaveApiError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('accepts only Task 3 state operations', () => {
    const client = createCourseweaveClient(runtime);
    if (false) {
      // @ts-expect-error Unsupported state operations are not part of the client contract.
      void client.patchState({ expected_revision: 1, operation: { type: 'invented_operation' } });
    }
  });
});
