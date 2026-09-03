"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoundedLruSet = void 0;
exports.parseOpenSurfaceRequest = parseOpenSurfaceRequest;
exports.parseCaptureRequest = parseCaptureRequest;
exports.parseRuntimeRequest = parseRuntimeRequest;
exports.parseLaunchConfiguration = parseLaunchConfiguration;
exports.parseRuntimeRelayPayload = parseRuntimeRelayPayload;
function exactObject(value, keys) {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function canonicalHttpOrigin(value) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
        return null;
    try {
        const parsed = new URL(value);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            || parsed.username.length > 0
            || parsed.password.length > 0
            || parsed.origin !== value)
            return null;
        return parsed.origin;
    }
    catch {
        return null;
    }
}
function boundedNonBlank(value, maxLength) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maxLength
        && value.trim() === value;
}
function parseOpenSurfaceRequest(value) {
    if (!exactObject(value, ['moduleId', 'phaseId', 'surfaceId', 'type']))
        return null;
    if (value.type !== 'courseweave.open-surface.v1')
        return null;
    for (const key of ['moduleId', 'phaseId', 'surfaceId']) {
        if (!boundedNonBlank(value[key], 240))
            return null;
    }
    return value;
}
function parseCaptureRequest(value) {
    if (!exactObject(value, ['kind', 'maxChars', 'requestId', 'type']))
        return null;
    if (value.type !== 'courseweave.share.capture.request.v1'
        || !boundedNonBlank(value.requestId, 240)
        || (value.kind !== 'selection' && value.kind !== 'cell' && value.kind !== 'output')
        || !Number.isInteger(value.maxChars)
        || value.maxChars < 1
        || value.maxChars > 131072)
        return null;
    return value;
}
function parseRuntimeRequest(value) {
    return exactObject(value, ['type']) && value.type === 'courseweave.runtime.request.v1'
        ? { type: 'courseweave.runtime.request.v1' }
        : null;
}
function parseLaunchConfiguration(getOption) {
    const serviceOrigin = canonicalHttpOrigin(getOption('courseweaveServiceUrl'));
    const runtimeId = getOption('courseweaveRuntimeId');
    const launchMode = getOption('courseweaveLaunchMode');
    if (serviceOrigin === null
        || !boundedNonBlank(runtimeId, 240)
        || (launchMode !== 'learn' && launchMode !== 'author'))
        return null;
    return { serviceOrigin, runtimeId, launchMode };
}
function parseRuntimeRelayPayload(value, serviceOrigin) {
    if (!exactObject(value, ['capabilityToken', 'serviceOrigin']))
        return null;
    const parsedOrigin = canonicalHttpOrigin(value.serviceOrigin);
    if (parsedOrigin === null
        || parsedOrigin !== serviceOrigin
        || !boundedNonBlank(value.capabilityToken, 4096))
        return null;
    return { serviceOrigin: parsedOrigin, capabilityToken: value.capabilityToken };
}
class BoundedLruSet {
    constructor(limit) {
        this.limit = limit;
        this.values = new Set();
        if (!Number.isInteger(limit) || limit < 1)
            throw new RangeError('LRU limit must be positive.');
    }
    get size() {
        return this.values.size;
    }
    accept(key) {
        if (this.values.delete(key)) {
            this.values.add(key);
            return false;
        }
        this.values.add(key);
        if (this.values.size > this.limit) {
            const oldest = this.values.values().next().value;
            if (oldest !== undefined)
                this.values.delete(oldest);
        }
        return true;
    }
}
exports.BoundedLruSet = BoundedLruSet;
