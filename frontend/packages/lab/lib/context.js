"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextObserver = exports.ContextPublisher = void 0;
exports.collectWorkspaceMetadata = collectWorkspaceMetadata;
const EMPTY_METADATA = {
    active_path: null,
    active_cell_id: null,
    active_cell_tags: [],
    surface_kind: null,
    explicit_module_id: null,
    explicit_phase_id: null,
    video_seconds: null,
    terminal_surface_id: null,
};
function normalizedPath(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value.length > 1024 ||
        value.trim() !== value ||
        value.startsWith("/") ||
        value.includes("\\") ||
        value.includes("%") ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))
        return null;
    const segments = value.split("/");
    return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ? null
        : value;
}
function boundedString(value, max) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= max &&
        value.trim() === value
        ? value
        : null;
}
function collectWorkspaceMetadata(options) {
    const active = options.activeWidget;
    if (active === null)
        return { ...EMPTY_METADATA, active_cell_tags: [] };
    const surface = options.surfaceMetadata(active);
    const metadata = {
        ...EMPTY_METADATA,
        active_cell_tags: [],
        active_path: surface?.activePath === null || surface === null
            ? null
            : normalizedPath(surface.activePath),
        surface_kind: surface?.surfaceKind ?? null,
        terminal_surface_id: surface?.terminalSurfaceId ?? null,
        explicit_module_id: surface?.explicitModuleId ?? null,
        explicit_phase_id: surface?.explicitPhaseId ?? null,
    };
    if (active === options.notebook.currentWidget) {
        metadata.active_path =
            normalizedPath(active.context?.path) ??
                metadata.active_path;
        metadata.surface_kind = "notebook";
        const cell = options.notebook.activeCell;
        metadata.active_cell_id = boundedString(cell?.model?.id, 160);
        const tags = cell?.model?.getMetadata?.("tags");
        metadata.active_cell_tags = Array.isArray(tags)
            ? [
                ...new Set(tags.filter((tag) => boundedString(tag, 160) !== null)),
            ]
            : [];
    }
    else if (active === options.editor.currentWidget) {
        metadata.active_path =
            normalizedPath(active.context?.path) ??
                metadata.active_path;
        metadata.surface_kind ?? (metadata.surface_kind = "source");
    }
    else if (active === options.terminal.currentWidget) {
        metadata.surface_kind = "terminal";
    }
    else {
        metadata.active_path ?? (metadata.active_path = normalizedPath(active.context?.path));
    }
    return metadata;
}
function metadataKey(metadata) {
    return JSON.stringify(metadata);
}
const RESOLUTION_REASONS = new Set([
    "explicit_phase",
    "cell_id",
    "cell_tag",
    "video_segment",
    "active_path",
    "terminal_surface",
    "surface_kind",
    "last_phase",
    "entry_phase",
    "empty_course",
]);
function slugOrNull(value) {
    return (value === null ||
        (typeof value === "string" &&
            value.length <= 80 &&
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)));
}
async function resolvedContext(response) {
    try {
        const value = (await response.json());
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return null;
        const data = value;
        if (Object.keys(data).sort().join(",") !==
            "module_id,phase_id,reason,surface_id")
            return null;
        if (!slugOrNull(data.module_id) ||
            !slugOrNull(data.phase_id) ||
            !slugOrNull(data.surface_id) ||
            typeof data.reason !== "string" ||
            !RESOLUTION_REASONS.has(data.reason))
            return null;
        return data;
    }
    catch {
        return null;
    }
}
async function responseCode(response) {
    try {
        const value = (await response.json());
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return null;
        const code = value.code;
        return typeof code === "string" ? code : null;
    }
    catch {
        return null;
    }
}
class ContextPublisher {
    constructor(options) {
        this.options = options;
        this.desired = null;
        this.accepted = null;
        this.nextSequence = 0;
        this.flight = null;
        this.blocked = false;
        this.childWindow = options.childWindow;
    }
    publish(metadata) {
        this.desired = {
            ...metadata,
            active_cell_tags: [...metadata.active_cell_tags],
        };
        if (metadataKey(this.desired) === this.accepted?.key)
            return this.flight ?? Promise.resolve();
        this.childWindow.postMessage({
            type: "courseweave.context.pending.v1",
            sourceId: this.options.sourceId,
        }, this.options.serviceOrigin);
        return this.ensureDrain();
    }
    async retry(metadata) {
        if (metadata !== undefined) {
            this.desired = {
                ...metadata,
                active_cell_tags: [...metadata.active_cell_tags],
            };
            this.accepted = null;
            this.childWindow.postMessage({
                type: "courseweave.context.pending.v1",
                sourceId: this.options.sourceId,
            }, this.options.serviceOrigin);
        }
        // A prior request may still report failure after the recovery command.
        // Finish it before unblocking, then drain the latest observed metadata.
        if (this.flight !== null)
            await this.flight;
        this.blocked = false;
        return this.ensureDrain();
    }
    setChildWindow(childWindow) {
        this.childWindow = childWindow;
    }
    acceptedCoordinate() {
        const accepted = this.accepted;
        if (accepted === null ||
            this.desired === null ||
            metadataKey(this.desired) !== accepted.key ||
            accepted.resolved.module_id === null ||
            accepted.resolved.phase_id === null)
            return null;
        return {
            moduleId: accepted.resolved.module_id,
            phaseId: accepted.resolved.phase_id,
        };
    }
    ensureDrain() {
        if (this.flight !== null)
            return this.flight;
        if (this.blocked ||
            this.desired === null ||
            metadataKey(this.desired) === this.accepted?.key)
            return Promise.resolve();
        const drain = this.drain();
        this.flight = drain.finally(() => {
            this.flight = null;
        });
        return this.flight;
    }
    async drain() {
        let staleRetried = false;
        while (!this.blocked &&
            this.desired !== null &&
            metadataKey(this.desired) !== this.accepted?.key) {
            const current = this.desired;
            const key = metadataKey(current);
            let response;
            try {
                response = await this.options.relay.postContext({
                    source_id: this.options.sourceId,
                    sequence: this.nextSequence,
                    ...current,
                });
            }
            catch {
                this.blocked = true;
                this.options.onRecovery?.("backend");
                return;
            }
            if (response.status === 200) {
                const resolved = await resolvedContext(response);
                if (resolved === null) {
                    this.blocked = true;
                    this.options.onRecovery?.("backend");
                    return;
                }
                this.accepted = { key, sequence: this.nextSequence, resolved };
                this.nextSequence += 1;
                staleRetried = false;
                if (this.desired !== null && metadataKey(this.desired) === key) {
                    this.childWindow.postMessage({
                        type: "courseweave.context.changed.v1",
                        sourceId: this.options.sourceId,
                    }, this.options.serviceOrigin);
                    this.options.onConfirmed?.();
                }
                continue;
            }
            const code = response.status === 409 ? await responseCode(response) : null;
            if (code === "stale_context" && !staleRetried) {
                this.nextSequence += 1;
                staleRetried = true;
                continue;
            }
            if (code === "stale_context") {
                this.blocked = true;
                this.options.onRecovery?.("stale");
                return;
            }
            if (code === "context_conflict") {
                this.nextSequence += 1;
                this.blocked = true;
                this.options.onRecovery?.("conflict");
                return;
            }
            this.blocked = true;
            this.options.onRecovery?.("backend");
            return;
        }
    }
}
exports.ContextPublisher = ContextPublisher;
class ContextObserver {
    constructor(options) {
        this.options = options;
        this.started = false;
        this.cellMetadata = null;
        this.changed = () => {
            void this.publishCurrent();
        };
        this.activeCellChanged = () => {
            this.bindCellMetadata();
            this.changed();
        };
    }
    currentMetadata() {
        return collectWorkspaceMetadata({
            activeWidget: this.options.shell.currentWidget,
            notebook: this.options.notebook,
            editor: this.options.editor,
            terminal: this.options.terminal,
            surfaceMetadata: this.options.surfaceMetadata,
        });
    }
    publishCurrent() {
        return this.options.publisher.publish(this.currentMetadata());
    }
    retryCurrent() {
        const metadata = this.currentMetadata();
        return (this.options.publisher.retry?.(metadata) ??
            this.options.publisher.publish(metadata));
    }
    bindCellMetadata() {
        this.cellMetadata?.disconnect(this.changed);
        const cell = this.options.notebook.activeCell;
        this.cellMetadata = cell?.model?.metadataChanged ?? null;
        this.cellMetadata?.connect(this.changed);
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        for (const signal of [
            this.options.shell.currentChanged,
            this.options.notebook.currentChanged,
            this.options.editor.currentChanged,
            this.options.terminal.currentChanged,
        ])
            signal.connect(this.changed);
        this.options.notebook.activeCellChanged.connect(this.activeCellChanged);
        this.bindCellMetadata();
        this.changed();
    }
    dispose() {
        if (!this.started)
            return;
        this.started = false;
        for (const signal of [
            this.options.shell.currentChanged,
            this.options.notebook.currentChanged,
            this.options.editor.currentChanged,
            this.options.terminal.currentChanged,
        ])
            signal.disconnect(this.changed);
        this.options.notebook.activeCellChanged.disconnect(this.activeCellChanged);
        this.cellMetadata?.disconnect(this.changed);
        this.cellMetadata = null;
    }
}
exports.ContextObserver = ContextObserver;
