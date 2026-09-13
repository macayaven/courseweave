export interface WorkspaceMetadata {
    active_path: string | null;
    active_cell_id: string | null;
    active_cell_tags: string[];
    surface_kind: string | null;
    explicit_module_id: string | null;
    explicit_phase_id: string | null;
    video_seconds: number | null;
    terminal_surface_id: string | null;
}
interface SurfaceMetadata {
    activePath: string | null;
    surfaceKind: string | null;
    terminalSurfaceId: string | null;
    explicitModuleId: string | null;
    explicitPhaseId: string | null;
}
interface MetadataCollectionOptions {
    activeWidget: object | null;
    notebook: {
        currentWidget: object | null;
        activeCell: object | null;
    };
    editor: {
        currentWidget: object | null;
    };
    terminal: {
        currentWidget: object | null;
    };
    surfaceMetadata(widget: object | null): SurfaceMetadata | null;
}
export declare function collectWorkspaceMetadata(options: MetadataCollectionOptions): WorkspaceMetadata;
interface ContextPublisherOptions {
    sourceId: string;
    relay: {
        postContext(context: {
            source_id: string;
            sequence: number;
        } & WorkspaceMetadata): Promise<Response>;
    };
    childWindow: Window;
    serviceOrigin: string;
    onRecovery?(reason: "backend" | "stale" | "conflict"): void;
    onConfirmed?(): void;
}
export declare class ContextPublisher {
    private readonly options;
    private desired;
    private accepted;
    private nextSequence;
    private flight;
    private blocked;
    private childWindow;
    constructor(options: ContextPublisherOptions);
    publish(metadata: WorkspaceMetadata): Promise<void>;
    retry(metadata?: WorkspaceMetadata): Promise<void>;
    setChildWindow(childWindow: Window): void;
    acceptedCoordinate(): {
        moduleId: string;
        phaseId: string;
    } | null;
    private ensureDrain;
    private drain;
}
interface SignalLike {
    connect(slot: () => void): void;
    disconnect(slot: () => void): void;
}
interface ContextObserverOptions {
    shell: {
        currentWidget: object | null;
        currentChanged: SignalLike;
    };
    notebook: {
        currentWidget: object | null;
        activeCell: object | null;
        currentChanged: SignalLike;
        activeCellChanged: SignalLike;
    };
    editor: {
        currentWidget: object | null;
        currentChanged: SignalLike;
    };
    terminal: {
        currentWidget: object | null;
        currentChanged: SignalLike;
    };
    surfaceMetadata(widget: object | null): SurfaceMetadata | null;
    publisher: {
        publish(metadata: WorkspaceMetadata): Promise<void>;
        retry?(metadata: WorkspaceMetadata): Promise<void>;
    };
}
export declare class ContextObserver {
    private readonly options;
    private started;
    private cellMetadata;
    constructor(options: ContextObserverOptions);
    private currentMetadata;
    publishCurrent(): Promise<void>;
    retryCurrent(): Promise<void>;
    private readonly changed;
    private bindCellMetadata;
    private readonly activeCellChanged;
    start(): void;
    dispose(): void;
}
export {};
