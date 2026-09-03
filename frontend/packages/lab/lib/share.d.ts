import type { CourseSnapshot } from './surfaces';
interface LabCaptureProviderOptions {
    hostWindow: Window;
    childWindow: Window;
    serviceOrigin: string;
    course(): CourseSnapshot | null;
    activeCoordinate(): {
        moduleId: string;
        phaseId: string;
    } | null;
    activeWidget(): object | null;
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
}
type CourseReader = () => CourseSnapshot | null;
export declare class LabCaptureProvider {
    private readonly options;
    private listening;
    private pendingRequestId;
    private readonly consumed;
    private courseReader;
    constructor(options: LabCaptureProviderOptions);
    setCourse(course: CourseReader): void;
    private readonly listener;
    private reject;
    private allowed;
    private activeCell;
    private read;
    private capture;
    start(): void;
    dispose(): void;
}
export {};
