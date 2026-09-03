export type LaunchMode = 'learn' | 'author';

export interface LaunchConfiguration {
  serviceOrigin: string;
  runtimeId: string;
  launchMode: LaunchMode;
}

export interface RuntimeRelayPayload {
  serviceOrigin: string;
  capabilityToken: string;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function canonicalHttpOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.origin !== value
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function boundedNonBlank(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value;
}

export function parseRuntimeRequest(value: unknown): { type: 'courseweave.runtime.request.v1' } | null {
  return exactObject(value, ['type']) && value.type === 'courseweave.runtime.request.v1'
    ? { type: 'courseweave.runtime.request.v1' }
    : null;
}

export function parseLaunchConfiguration(getOption: (key: string) => string): LaunchConfiguration | null {
  const serviceOrigin = canonicalHttpOrigin(getOption('courseweaveServiceUrl'));
  const runtimeId = getOption('courseweaveRuntimeId');
  const launchMode = getOption('courseweaveLaunchMode');
  if (
    serviceOrigin === null
    || !boundedNonBlank(runtimeId, 240)
    || (launchMode !== 'learn' && launchMode !== 'author')
  ) return null;
  return { serviceOrigin, runtimeId, launchMode };
}

export function parseRuntimeRelayPayload(
  value: unknown,
  serviceOrigin: string
): RuntimeRelayPayload | null {
  if (!exactObject(value, ['capabilityToken', 'serviceOrigin'])) return null;
  const parsedOrigin = canonicalHttpOrigin(value.serviceOrigin);
  if (
    parsedOrigin === null
    || parsedOrigin !== serviceOrigin
    || !boundedNonBlank(value.capabilityToken, 4096)
  ) return null;
  return { serviceOrigin: parsedOrigin, capabilityToken: value.capabilityToken };
}

export class BoundedLruSet {
  private readonly values = new Set<string>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('LRU limit must be positive.');
  }

  get size(): number {
    return this.values.size;
  }

  accept(key: string): boolean {
    if (this.values.delete(key)) {
      this.values.add(key);
      return false;
    }
    this.values.add(key);
    if (this.values.size > this.limit) {
      const oldest = this.values.values().next().value as string | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    return true;
  }
}
