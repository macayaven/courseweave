import { Widget } from '@lumino/widgets';
export type SurfaceType = 'html' | 'markdown' | 'video' | 'notebook' | 'source' | 'terminal' | 'external';
export interface CourseSurface {
    id: string;
    type: SurfaceType;
    path?: string;
    url?: string;
    cwd?: string;
    argv?: string[];
    label?: string;
}
export interface CourseSnapshot {
    id: string;
    title: string;
    policies: {
        max_shared_chars: number;
    };
    modules: Array<{
        id: string;
        title: string;
        phases: Array<{
            id: string;
            title: string;
            capabilities: {
                share_selection: boolean;
                share_cell: boolean;
                share_output: boolean;
            };
            surfaces: CourseSurface[];
        }>;
    }>;
}
export interface SurfaceCoordinate {
    moduleId: string;
    phaseId: string;
    surfaceId: string;
}
export declare function parseCourseSnapshot(value: unknown): CourseSnapshot | null;
export declare function localReaderUrl(path: string, jupyterOrigin: string, baseUrl: string): string;
export declare function canonicalJupyterBaseUrl(jupyterOrigin: string, baseUrl: string): string;
interface SurfaceShell {
    add(widget: Widget, area: 'main', options?: Record<string, unknown>): void;
    activateById(id: string): void;
    currentWidget: Widget | null;
}
interface SurfaceDocumentManager {
    openOrReveal(path: string, factory: string): Widget | undefined;
}
interface SurfaceCommands {
    execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
export interface SurfaceMetadata {
    activePath: string | null;
    surfaceKind: SurfaceType | null;
    terminalSurfaceId: string | null;
    explicitModuleId: string | null;
    explicitPhaseId: string | null;
}
interface CourseSurfaceFactoryOptions {
    shell: SurfaceShell;
    documents: SurfaceDocumentManager;
    commands: SurfaceCommands;
    serviceOrigin: string;
    jupyterOrigin: string;
    baseUrl: string;
    beforeAuthorAttach?: (widget: Widget, iframe: HTMLIFrameElement) => void;
    writeClipboard?: (text: string) => Promise<void>;
}
export interface SurfaceOpenResult {
    htmlSource: string | null;
    jupyterBaseUrl: string;
    terminalSurfaceId: string | null;
}
export declare function coordinateForCoursePath(course: CourseSnapshot, path: string): {
    moduleId: string;
    phaseId: string;
} | null;
export declare const COURSEWEAVE_COMMANDS: {
    readonly openGuide: "courseweave:open-guide";
    readonly openDashboard: "courseweave:open-dashboard";
    readonly openAuthor: "courseweave:open-author";
    readonly shareSelection: "courseweave:share-selection";
    readonly shareCell: "courseweave:share-cell";
    readonly shareOutput: "courseweave:share-output";
};
export declare const COURSEWEAVE_PALETTE_CATEGORY = "CourseWeave";
export declare function registerCoursePalette(palette: {
    addItem(options: {
        command: string;
        category: string;
    }): unknown;
}): void;
export declare function registerCourseCommands(commands: {
    addCommand(id: string, options: {
        label: string;
        execute(): unknown;
    }): void;
}, actions: {
    openGuide(): unknown;
    openDashboard(): unknown;
    openAuthor(): unknown;
    requestShare(kind: 'selection' | 'cell' | 'output'): unknown;
}): void;
export declare class CourseSurfaceFactory {
    private readonly options;
    private course;
    private reader;
    private dashboard;
    private author;
    private readonly terminals;
    private readonly terminalFlights;
    private readonly metadata;
    private readonly jupyterBaseUrl;
    constructor(options: CourseSurfaceFactoryOptions);
    setCourse(course: CourseSnapshot): void;
    private lookup;
    private activate;
    private nativeDocument;
    private createTerminal;
    open(coordinate: SurfaceCoordinate): Promise<SurfaceOpenResult>;
    openDashboard(): Widget;
    openAuthor(): Widget;
    metadataFor(widget: object | null): SurfaceMetadata | null;
}
export declare class SurfaceRequestBroker {
    private readonly options;
    private listening;
    private readonly flights;
    constructor(options: {
        hostWindow: Window;
        childWindow: Window;
        serviceOrigin: string;
        sourceId: string;
        factory: Pick<CourseSurfaceFactory, 'open'>;
    });
    private readonly listener;
    start(): void;
    dispose(): void;
}
export {};
