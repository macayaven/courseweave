import { BoundedLruSet, parseCaptureRequest, type CaptureKind, type CaptureRequest } from './protocol';
import type { CourseSnapshot } from './surfaces';

interface EditorLike {
  getSelection(): { start: unknown; end: unknown };
  getOffsetAt(position: unknown): number;
  model: { sharedModel: { getSource(): string } };
}

interface CellLike {
  editor?: EditorLike | null;
  model?: {
    id?: unknown;
    type?: unknown;
    sharedModel?: { getSource(): string };
    outputs?: { toJSON(): unknown };
  };
}

interface PanelLike {
  context?: { path?: unknown };
  content?: { editor?: EditorLike; activeCell?: CellLike | null };
}

interface LabCaptureProviderOptions {
  hostWindow: Window;
  childWindow: Window;
  serviceOrigin: string;
  course(): CourseSnapshot | null;
  activeCoordinate(): { moduleId: string; phaseId: string } | null;
  activeWidget(): object | null;
  notebook: { currentWidget: object | null; activeCell: object | null };
  editor: { currentWidget: object | null };
  terminal: { currentWidget: object | null };
}

type CourseReader = () => CourseSnapshot | null;

function labelFor(panel: PanelLike, cell: CellLike | null): string {
  const path = typeof panel.context?.path === 'string' ? panel.context.path : 'active document';
  const cellId = typeof cell?.model?.id === 'string' ? cell.model.id : null;
  return cellId === null ? path : `${path}#${cellId}`;
}

function selectionFrom(editor: EditorLike): string | null {
  const range = editor.getSelection();
  const first = editor.getOffsetAt(range.start);
  const second = editor.getOffsetAt(range.end);
  if (!Number.isInteger(first) || !Number.isInteger(second)) return null;
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  if (start === end) return null;
  return editor.model.sharedModel.getSource().slice(start, end);
}

export class LabCaptureProvider {
  private listening = false;
  private pendingRequestId: string | null = null;
  private readonly consumed = new BoundedLruSet(256);
  private courseReader: CourseReader;

  constructor(private readonly options: LabCaptureProviderOptions) {
    this.courseReader = options.course;
  }

  setCourse(course: CourseReader): void {
    this.courseReader = course;
  }

  private readonly listener = (event: MessageEvent<unknown>): void => {
    if (!this.listening || event.source !== this.options.childWindow || event.origin !== this.options.serviceOrigin) return;
    const request = parseCaptureRequest(event.data);
    if (request === null || !this.consumed.accept(request.requestId)) return;
    if (this.pendingRequestId !== null) {
      this.reject(request.requestId, 'busy');
      return;
    }
    this.pendingRequestId = request.requestId;
    void this.capture(request).catch(() => {
      this.reject(request.requestId, 'unavailable');
    }).finally(() => {
      if (this.pendingRequestId === request.requestId) this.pendingRequestId = null;
    });
  };

  private reject(requestId: string, code: 'busy' | 'forbidden' | 'too_large' | 'unavailable'): void {
    if (!this.listening) return;
    this.options.childWindow.postMessage({ type: 'courseweave.share.capture.rejected.v1', requestId, code }, this.options.serviceOrigin);
  }

  private allowed(request: CaptureRequest): boolean {
    const course = this.courseReader();
    const coordinate = this.options.activeCoordinate();
    if (course === null || coordinate === null || request.maxChars > course.policies.max_shared_chars) return false;
    const phase = course.modules.find((item) => item.id === coordinate.moduleId)?.phases.find((item) => item.id === coordinate.phaseId);
    if (phase === undefined) return false;
    return request.kind === 'selection' ? phase.capabilities.share_selection
      : request.kind === 'cell' ? phase.capabilities.share_cell
        : phase.capabilities.share_output;
  }

  private activeCell(): { panel: PanelLike; cell: CellLike } | null {
    const panel = this.options.notebook.currentWidget as PanelLike | null;
    const cell = this.options.notebook.activeCell as CellLike | null;
    return this.options.activeWidget() === panel && panel !== null && cell !== null ? { panel, cell } : null;
  }

  private read(kind: CaptureKind): { label: string; content: string } | null {
    if (this.options.activeWidget() === this.options.terminal.currentWidget) return null;
    const notebook = this.activeCell();
    if (kind === 'selection') {
      if (notebook !== null && notebook.cell.editor !== undefined && notebook.cell.editor !== null) {
        const content = selectionFrom(notebook.cell.editor);
        return content === null ? null : { label: labelFor(notebook.panel, notebook.cell), content };
      }
      const panel = this.options.editor.currentWidget as PanelLike | null;
      if (this.options.activeWidget() === panel && panel?.content?.editor !== undefined) {
        const content = selectionFrom(panel.content.editor);
        return content === null ? null : { label: labelFor(panel, null), content };
      }
      return null;
    }
    if (notebook === null) return null;
    if (kind === 'cell') {
      const content = notebook.cell.model?.sharedModel?.getSource();
      return typeof content === 'string' && content.length > 0 ? { label: labelFor(notebook.panel, notebook.cell), content } : null;
    }
    if (notebook.cell.model?.type !== 'code' || notebook.cell.model.outputs === undefined) return null;
    const content = JSON.stringify(notebook.cell.model.outputs.toJSON());
    return content.length > 0 ? { label: labelFor(notebook.panel, notebook.cell), content } : null;
  }

  private async capture(request: CaptureRequest): Promise<void> {
    await Promise.resolve();
    if (!this.listening) return;
    if (!this.allowed(request)) {
      this.reject(request.requestId, 'forbidden');
      return;
    }
    const captured = this.read(request.kind);
    if (captured === null) {
      this.reject(request.requestId, 'unavailable');
      return;
    }
    if (Array.from(captured.content).length > request.maxChars) {
      this.reject(request.requestId, 'too_large');
      return;
    }
    if (!this.listening) return;
    this.options.childWindow.postMessage({
      type: 'courseweave.share.capture.result.v1',
      requestId: request.requestId,
      kind: request.kind,
      label: captured.label,
      content: captured.content
    }, this.options.serviceOrigin);
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.hostWindow.addEventListener('message', this.listener);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    this.pendingRequestId = null;
    this.options.hostWindow.removeEventListener('message', this.listener);
  }
}
