import { ServerConnection } from '@jupyterlab/services';
import { type RuntimeRelayPayload } from './protocol';
export interface WorkspaceContext {
    source_id: string;
    sequence: number;
    active_path: string | null;
    active_cell_id: string | null;
    active_cell_tags: string[];
    surface_kind: string | null;
    explicit_module_id: string | null;
    explicit_phase_id: string | null;
    video_seconds: number | null;
    terminal_surface_id: string | null;
}
export declare class CourseWeaveRelayClient {
    private readonly serviceOrigin;
    private readonly serverSettings;
    constructor(serviceOrigin: string, serverSettings?: ServerConnection.ISettings);
    private request;
    getRuntime(runtimeId: string): Promise<RuntimeRelayPayload>;
    getCourse(): Promise<Response>;
    postContext(context: WorkspaceContext): Promise<Response>;
}
interface RuntimeBrokerOptions {
    hostWindow: Window;
    iframe: HTMLIFrameElement;
    serviceOrigin: string;
    runtimeId: string;
    sourceId: string;
    relay: Pick<CourseWeaveRelayClient, 'getRuntime'>;
    beforeReply?: (childWindow: Window) => void;
}
export declare class RuntimeBroker {
    private readonly options;
    private listening;
    private inFlight;
    constructor(options: RuntimeBrokerOptions);
    private readonly listener;
    private reply;
    start(): void;
    dispose(): void;
}
export declare function createCourseWeaveIframe(serviceOrigin: string, mode: 'learn' | 'author'): HTMLIFrameElement;
export {};
