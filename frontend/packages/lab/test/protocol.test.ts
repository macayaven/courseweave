import { describe, expect, it } from 'vitest';

import {
  BoundedLruSet,
  parseLaunchConfiguration,
  parseRuntimeRelayPayload,
  parseRuntimeRequest
} from '../src/protocol';

describe('CourseWeave Lab protocol', () => {
  it('accepts only the exact runtime request object', () => {
    expect(parseRuntimeRequest({ type: 'courseweave.runtime.request.v1' })).toEqual({
      type: 'courseweave.runtime.request.v1'
    });
    for (const value of [
      null,
      [],
      'courseweave.runtime.request.v1',
      {},
      { type: 'courseweave.runtime.request.v1', extra: true },
      { type: 'courseweave.runtime.request.v2' }
    ]) {
      expect(parseRuntimeRequest(value)).toBeNull();
    }
  });

  it('accepts exactly three non-secret PageConfig launch values', () => {
    const capability = 'must-not-enter-page-config';
    const options = new Map<string, string>([
      ['courseweaveServiceUrl', 'http://127.0.0.1:8765'],
      ['courseweaveRuntimeId', 'runtime-123'],
      ['courseweaveLaunchMode', 'learn'],
      ['courseweaveCapabilityToken', capability]
    ]);
    const config = parseLaunchConfiguration({
      getOption(key) {
        return options.get(key) ?? '';
      }
    });
    expect(config).toEqual({
      serviceOrigin: 'http://127.0.0.1:8765',
      runtimeId: 'runtime-123',
      launchMode: 'learn'
    });
    expect(JSON.stringify(config)).not.toContain(capability);
  });

  it.each([
    ['https://courseweave.test/', 'runtime-1', 'learn'],
    ['https://user:secret@courseweave.test', 'runtime-1', 'learn'],
    ['file:///tmp/course', 'runtime-1', 'learn'],
    ['https://courseweave.test', '', 'learn'],
    ['https://courseweave.test', ' x ', 'learn'],
    ['https://courseweave.test', 'runtime-1', 'preview']
  ])('rejects invalid launch settings', (serviceOrigin, runtimeId, launchMode) => {
    const values: Record<string, string> = {
      courseweaveServiceUrl: serviceOrigin,
      courseweaveRuntimeId: runtimeId,
      courseweaveLaunchMode: launchMode
    };
    expect(parseLaunchConfiguration({
      getOption(key) {
        return values[key] ?? '';
      }
    })).toBeNull();
  });

  it('reads valid launch values through the PageConfig receiver', () => {
    const pageConfig = {
      values: {
        courseweaveServiceUrl: 'https://courseweave.test',
        courseweaveRuntimeId: 'runtime-123',
        courseweaveLaunchMode: 'learn'
      },
      getOption(key: string) {
        return this.values[key as keyof typeof this.values] ?? '';
      }
    };

    expect(parseLaunchConfiguration(pageConfig)).toEqual({
      serviceOrigin: 'https://courseweave.test',
      runtimeId: 'runtime-123',
      launchMode: 'learn'
    });
  });

  it('accepts only the exact runtime relay payload for the configured service origin', () => {
    expect(parseRuntimeRelayPayload({
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token'
    }, 'https://courseweave.test')).toEqual({
      serviceOrigin: 'https://courseweave.test',
      capabilityToken: 'runtime-token'
    });
    for (const value of [
      { serviceOrigin: 'https://other.test', capabilityToken: 'runtime-token' },
      { serviceOrigin: 'https://courseweave.test/', capabilityToken: 'runtime-token' },
      { serviceOrigin: 'https://courseweave.test', capabilityToken: ' runtime-token ' },
      { serviceOrigin: 'https://courseweave.test', capabilityToken: 'x'.repeat(4097) },
      { serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-token', extra: true }
    ]) {
      expect(parseRuntimeRelayPayload(value, 'https://courseweave.test')).toBeNull();
    }
  });

  it('bounds duplicate memory and evicts the least-recently accepted key', () => {
    const seen = new BoundedLruSet(2);
    expect(seen.accept('first')).toBe(true);
    expect(seen.accept('second')).toBe(true);
    expect(seen.accept('first')).toBe(false);
    expect(seen.accept('third')).toBe(true);
    expect(seen.accept('second')).toBe(true);
    expect(seen.size).toBe(2);
  });
});
