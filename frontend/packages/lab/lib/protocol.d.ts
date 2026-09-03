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
export interface OpenSurfaceRequest {
    type: 'courseweave.open-surface.v1';
    moduleId: string;
    phaseId: string;
    surfaceId: string;
}
export type CaptureKind = 'selection' | 'cell' | 'output';
export interface CaptureRequest {
    type: 'courseweave.share.capture.request.v1';
    requestId: string;
    kind: CaptureKind;
    maxChars: number;
}
export declare function parseOpenSurfaceRequest(value: unknown): OpenSurfaceRequest | null;
export declare function parseCaptureRequest(value: unknown): CaptureRequest | null;
export declare function parseRuntimeRequest(value: unknown): {
    type: 'courseweave.runtime.request.v1';
} | null;
export declare function parseLaunchConfiguration(getOption: (key: string) => string): LaunchConfiguration | null;
export declare function parseRuntimeRelayPayload(value: unknown, serviceOrigin: string): RuntimeRelayPayload | null;
export declare class BoundedLruSet {
    private readonly limit;
    private readonly values;
    constructor(limit: number);
    get size(): number;
    accept(key: string): boolean;
}
