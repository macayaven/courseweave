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

interface ResolvedContext {
  module_id: string | null;
  phase_id: string | null;
  surface_id: string | null;
  reason: 'explicit_phase' | 'cell_id' | 'cell_tag' | 'video_segment' | 'active_path' | 'terminal_surface' | 'surface_kind' | 'last_phase' | 'entry_phase' | 'empty_course';
}

interface SurfaceMetadata {
  activePath: string | null;
  surfaceKind: string | null;
  terminalSurfaceId: string | null;
  explicitModuleId: string | null;
  explicitPhaseId: string | null;
}

interface TrackedDocument {
  context?: { path?: unknown };
}

interface TrackedCell {
  model?: {
    id?: unknown;
    getMetadata?(key: string): unknown;
    metadataChanged?: SignalLike;
  };
}

interface MetadataCollectionOptions {
  activeWidget: object | null;
  notebook: { currentWidget: object | null; activeCell: object | null };
  editor: { currentWidget: object | null };
  terminal: { currentWidget: object | null };
  surfaceMetadata(widget: object | null): SurfaceMetadata | null;
}

const EMPTY_METADATA: WorkspaceMetadata = {
  active_path: null,
  active_cell_id: null,
  active_cell_tags: [],
  surface_kind: null,
  explicit_module_id: null,
  explicit_phase_id: null,
  video_seconds: null,
  terminal_surface_id: null
};

function normalizedPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.trim() !== value || value.startsWith('/') || value.includes('\\') || value.includes('%') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  const segments = value.split('/');
  return segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ? null : value;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value ? value : null;
}

export function collectWorkspaceMetadata(options: MetadataCollectionOptions): WorkspaceMetadata {
  const active = options.activeWidget;
  if (active === null) return { ...EMPTY_METADATA, active_cell_tags: [] };
  const surface = options.surfaceMetadata(active);
  const metadata: WorkspaceMetadata = {
    ...EMPTY_METADATA,
    active_cell_tags: [],
    active_path: surface?.activePath === null || surface === null ? null : normalizedPath(surface.activePath),
    surface_kind: surface?.surfaceKind ?? null,
    terminal_surface_id: surface?.terminalSurfaceId ?? null,
    explicit_module_id: surface?.explicitModuleId ?? null,
    explicit_phase_id: surface?.explicitPhaseId ?? null
  };

  if (active === options.notebook.currentWidget) {
    metadata.active_path = normalizedPath((active as TrackedDocument).context?.path) ?? metadata.active_path;
    metadata.surface_kind = 'notebook';
    const cell = options.notebook.activeCell as TrackedCell | null;
    metadata.active_cell_id = boundedString(cell?.model?.id, 160);
    const tags = cell?.model?.getMetadata?.('tags');
    metadata.active_cell_tags = Array.isArray(tags)
      ? [...new Set(tags.filter((tag): tag is string => boundedString(tag, 160) !== null))]
      : [];
  } else if (active === options.editor.currentWidget) {
    metadata.active_path = normalizedPath((active as TrackedDocument).context?.path) ?? metadata.active_path;
    metadata.surface_kind ??= 'source';
  } else if (active === options.terminal.currentWidget) {
    metadata.surface_kind = 'terminal';
  } else {
    metadata.active_path ??= normalizedPath((active as TrackedDocument).context?.path);
  }
  return metadata;
}

interface ContextPublisherOptions {
  sourceId: string;
  relay: { postContext(context: { source_id: string; sequence: number } & WorkspaceMetadata): Promise<Response> };
  childWindow: Window;
  serviceOrigin: string;
  onRecovery?(reason: 'backend' | 'stale' | 'conflict'): void;
}

function metadataKey(metadata: WorkspaceMetadata): string {
  return JSON.stringify(metadata);
}

const RESOLUTION_REASONS = new Set<ResolvedContext['reason']>([
  'explicit_phase', 'cell_id', 'cell_tag', 'video_segment', 'active_path',
  'terminal_surface', 'surface_kind', 'last_phase', 'entry_phase', 'empty_course'
]);

function slugOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value));
}

async function resolvedContext(response: Response): Promise<ResolvedContext | null> {
  try {
    const value = await response.json() as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).sort().join(',') !== 'module_id,phase_id,reason,surface_id') return null;
    if (!slugOrNull(data.module_id) || !slugOrNull(data.phase_id) || !slugOrNull(data.surface_id) || typeof data.reason !== 'string' || !RESOLUTION_REASONS.has(data.reason as ResolvedContext['reason'])) return null;
    return data as unknown as ResolvedContext;
  } catch {
    return null;
  }
}

async function responseCode(response: Response): Promise<string | null> {
  try {
    const value = await response.json() as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const code = (value as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export class ContextPublisher {
  private desired: WorkspaceMetadata | null = null;
  private accepted: { key: string; sequence: number; resolved: ResolvedContext } | null = null;
  private nextSequence = 0;
  private flight: Promise<void> | null = null;
  private blocked = false;
  private childWindow: Window;

  constructor(private readonly options: ContextPublisherOptions) {
    this.childWindow = options.childWindow;
  }

  publish(metadata: WorkspaceMetadata): Promise<void> {
    this.desired = { ...metadata, active_cell_tags: [...metadata.active_cell_tags] };
    if (metadataKey(this.desired) === this.accepted?.key) return this.flight ?? Promise.resolve();
    return this.ensureDrain();
  }

  retry(): Promise<void> {
    this.blocked = false;
    return this.ensureDrain();
  }

  setChildWindow(childWindow: Window): void {
    this.childWindow = childWindow;
  }

  acceptedCoordinate(): { moduleId: string; phaseId: string } | null {
    const accepted = this.accepted;
    if (accepted === null || this.desired === null || metadataKey(this.desired) !== accepted.key || accepted.resolved.module_id === null || accepted.resolved.phase_id === null) return null;
    return { moduleId: accepted.resolved.module_id, phaseId: accepted.resolved.phase_id };
  }

  private ensureDrain(): Promise<void> {
    if (this.flight !== null) return this.flight;
    if (this.blocked || this.desired === null || metadataKey(this.desired) === this.accepted?.key) return Promise.resolve();
    const drain = this.drain();
    this.flight = drain.finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  private async drain(): Promise<void> {
    let staleRetried = false;
    while (!this.blocked && this.desired !== null && metadataKey(this.desired) !== this.accepted?.key) {
      const current = this.desired;
      const key = metadataKey(current);
      let response: Response;
      try {
        response = await this.options.relay.postContext({ source_id: this.options.sourceId, sequence: this.nextSequence, ...current });
      } catch {
        this.blocked = true;
        this.options.onRecovery?.('backend');
        return;
      }
      if (response.status === 200) {
        const resolved = await resolvedContext(response);
        if (resolved === null) {
          this.blocked = true;
          this.options.onRecovery?.('backend');
          return;
        }
        this.accepted = { key, sequence: this.nextSequence, resolved };
        this.nextSequence += 1;
        staleRetried = false;
        this.childWindow.postMessage({ type: 'courseweave.context.changed.v1', sourceId: this.options.sourceId }, this.options.serviceOrigin);
        continue;
      }
      const code = response.status === 409 ? await responseCode(response) : null;
      if (code === 'stale_context' && !staleRetried) {
        this.nextSequence += 1;
        staleRetried = true;
        continue;
      }
      if (code === 'stale_context') {
        this.blocked = true;
        this.options.onRecovery?.('stale');
        return;
      }
      if (code === 'context_conflict') {
        this.nextSequence += 1;
        this.blocked = true;
        this.options.onRecovery?.('conflict');
        return;
      }
      this.blocked = true;
      this.options.onRecovery?.('backend');
      return;
    }
  }
}

interface SignalLike {
  connect(slot: () => void): void;
  disconnect(slot: () => void): void;
}

interface ContextObserverOptions {
  shell: { currentWidget: object | null; currentChanged: SignalLike };
  notebook: { currentWidget: object | null; activeCell: object | null; currentChanged: SignalLike; activeCellChanged: SignalLike };
  editor: { currentWidget: object | null; currentChanged: SignalLike };
  terminal: { currentWidget: object | null; currentChanged: SignalLike };
  surfaceMetadata(widget: object | null): SurfaceMetadata | null;
  publisher: { publish(metadata: WorkspaceMetadata): Promise<void> };
}

export class ContextObserver {
  private started = false;
  private cellMetadata: SignalLike | null = null;

  constructor(private readonly options: ContextObserverOptions) {}

  private readonly changed = (): void => {
    void this.options.publisher.publish(collectWorkspaceMetadata({
      activeWidget: this.options.shell.currentWidget,
      notebook: this.options.notebook,
      editor: this.options.editor,
      terminal: this.options.terminal,
      surfaceMetadata: this.options.surfaceMetadata
    }));
  };

  private bindCellMetadata(): void {
    this.cellMetadata?.disconnect(this.changed);
    const cell = this.options.notebook.activeCell as TrackedCell | null;
    this.cellMetadata = cell?.model?.metadataChanged ?? null;
    this.cellMetadata?.connect(this.changed);
  }

  private readonly activeCellChanged = (): void => {
    this.bindCellMetadata();
    this.changed();
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const signal of [this.options.shell.currentChanged, this.options.notebook.currentChanged, this.options.editor.currentChanged, this.options.terminal.currentChanged]) signal.connect(this.changed);
    this.options.notebook.activeCellChanged.connect(this.activeCellChanged);
    this.bindCellMetadata();
    this.changed();
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    for (const signal of [this.options.shell.currentChanged, this.options.notebook.currentChanged, this.options.editor.currentChanged, this.options.terminal.currentChanged]) signal.disconnect(this.changed);
    this.options.notebook.activeCellChanged.disconnect(this.activeCellChanged);
    this.cellMetadata?.disconnect(this.changed);
    this.cellMetadata = null;
  }
}
