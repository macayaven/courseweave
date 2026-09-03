import { describe, expect, it, vi } from 'vitest';

import {
  ContextObserver,
  ContextPublisher,
  collectWorkspaceMetadata,
  type WorkspaceMetadata
} from '../src/context';

class TestSignal {
  private slots: Array<() => void> = [];
  connect(slot: () => void) { this.slots.push(slot); }
  disconnect(slot: () => void) { this.slots = this.slots.filter((item) => item !== slot); }
  emit() { this.slots.forEach((slot) => slot()); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

const empty: WorkspaceMetadata = {
  active_path: null,
  active_cell_id: null,
  active_cell_tags: [],
  surface_kind: null,
  explicit_module_id: null,
  explicit_phase_id: null,
  video_seconds: null,
  terminal_surface_id: null
};

function ok() {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('active Jupyter metadata collection', () => {
  it('collects only normalized notebook path, cell ID, and string tags', () => {
    const current = { context: { path: 'notebooks/lesson.ipynb' } };
    const activeCell = {
      model: {
        id: 'cell-1',
        getMetadata: (key: string) => key === 'tags' ? ['exercise', 3, 'review'] : undefined,
        sharedModel: { getSource: () => 'must never enter context' }
      }
    };
    expect(collectWorkspaceMetadata({
      activeWidget: current,
      notebook: { currentWidget: current, activeCell },
      editor: { currentWidget: null },
      terminal: { currentWidget: null },
      surfaceMetadata: () => null
    })).toEqual({
      ...empty,
      active_path: 'notebooks/lesson.ipynb',
      active_cell_id: 'cell-1',
      active_cell_tags: ['exercise', 'review'],
      surface_kind: 'notebook'
    });
  });

  it('collects file editor, rendered Markdown, reader, and stable terminal metadata without contents', () => {
    const editor = { context: { path: 'src/main.py' } };
    expect(collectWorkspaceMetadata({
      activeWidget: editor,
      notebook: { currentWidget: null, activeCell: null },
      editor: { currentWidget: editor },
      terminal: { currentWidget: null },
      surfaceMetadata: () => null
    })).toEqual({ ...empty, active_path: 'src/main.py', surface_kind: 'source' });

    const markdown = {};
    expect(collectWorkspaceMetadata({
      activeWidget: markdown,
      notebook: { currentWidget: null, activeCell: null },
      editor: { currentWidget: null },
      terminal: { currentWidget: null },
      surfaceMetadata: () => ({ activePath: 'README.md', surfaceKind: 'markdown', terminalSurfaceId: null, explicitModuleId: null, explicitPhaseId: null })
    })).toEqual({ ...empty, active_path: 'README.md', surface_kind: 'markdown' });

    const terminal = {};
    expect(collectWorkspaceMetadata({
      activeWidget: terminal,
      notebook: { currentWidget: null, activeCell: null },
      editor: { currentWidget: null },
      terminal: { currentWidget: terminal },
      surfaceMetadata: () => ({ activePath: null, surfaceKind: 'terminal', terminalSurfaceId: 'term', explicitModuleId: 'm01', explicitPhaseId: 'p01' })
    })).toEqual({ ...empty, surface_kind: 'terminal', terminal_surface_id: 'term', explicit_module_id: 'm01', explicit_phase_id: 'p01' });
  });

  it('fails closed on traversal-shaped active paths', () => {
    const current = { context: { path: '../secret.py' } };
    expect(collectWorkspaceMetadata({
      activeWidget: current,
      notebook: { currentWidget: null, activeCell: null },
      editor: { currentWidget: current },
      terminal: { currentWidget: null },
      surfaceMetadata: () => null
    })).toEqual({ ...empty, surface_kind: 'source' });
  });
});

describe('ContextPublisher', () => {
  it('serializes/coalesces distinct observations with one source and increasing sequence', async () => {
    const first = deferred<Response>();
    const postContext = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok());
    const child = { postMessage: vi.fn() } as unknown as Window;
    const publisher = new ContextPublisher({ sourceId: 'source-a', relay: { postContext }, childWindow: child, serviceOrigin: 'https://courseweave.test' });
    const firstPublish = publisher.publish(empty);
    const latest = { ...empty, active_path: 'src/latest.py', surface_kind: 'source' } as WorkspaceMetadata;
    const latestPublish = publisher.publish({ ...empty, active_path: 'src/intermediate.py', surface_kind: 'source' });
    void publisher.publish(latest);
    expect(postContext).toHaveBeenCalledTimes(1);
    first.resolve(ok());
    await Promise.all([firstPublish, latestPublish]);

    expect(postContext).toHaveBeenCalledTimes(2);
    expect(postContext.mock.calls.map(([value]) => value)).toEqual([
      { source_id: 'source-a', sequence: 0, ...empty },
      { source_id: 'source-a', sequence: 1, ...latest }
    ]);
    expect(child.postMessage).toHaveBeenCalledTimes(2);
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'courseweave.context.changed.v1', sourceId: 'source-a' }, 'https://courseweave.test');
    expect(JSON.stringify(child.postMessage.mock.calls)).not.toContain('src/latest.py');
  });

  it('deduplicates exact accepted state and retains source/counter across an iframe replacement', async () => {
    const postContext = vi.fn().mockResolvedValue(ok());
    const firstChild = { postMessage: vi.fn() } as unknown as Window;
    const nextChild = { postMessage: vi.fn() } as unknown as Window;
    const publisher = new ContextPublisher({ sourceId: 'source-a', relay: { postContext }, childWindow: firstChild, serviceOrigin: 'https://courseweave.test' });
    await publisher.publish(empty);
    await publisher.publish(empty);
    publisher.setChildWindow(nextChild);
    await publisher.publish({ ...empty, surface_kind: 'source', active_path: 'src/new.py' });
    expect(postContext.mock.calls.map(([value]) => [value.source_id, value.sequence])).toEqual([['source-a', 0], ['source-a', 1]]);
    expect(firstChild.postMessage).toHaveBeenCalledOnce();
    expect(nextChild.postMessage).toHaveBeenCalledOnce();
  });

  it('retries an ambiguous backend failure with the same sequence and does not notify early', async () => {
    const onRecovery = vi.fn();
    const child = { postMessage: vi.fn() } as unknown as Window;
    const postContext = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok());
    const publisher = new ContextPublisher({ sourceId: 'source-a', relay: { postContext }, childWindow: child, serviceOrigin: 'https://courseweave.test', onRecovery });
    await publisher.publish(empty);
    expect(onRecovery).toHaveBeenCalledWith('backend');
    expect(child.postMessage).not.toHaveBeenCalled();
    await publisher.retry();
    expect(postContext.mock.calls.map(([value]) => value.sequence)).toEqual([0, 0]);
    expect(child.postMessage).toHaveBeenCalledOnce();
  });

  it('advances after one stale response and exposes repeated conflict for explicit recovery', async () => {
    const onRecovery = vi.fn();
    const stale = new Response(JSON.stringify({ code: 'stale_context', message: 'stale', details: {} }), { status: 409 });
    const conflict = new Response(JSON.stringify({ code: 'context_conflict', message: 'conflict', details: {} }), { status: 409 });
    const postContext = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(ok()).mockResolvedValueOnce(conflict).mockResolvedValueOnce(ok());
    const child = { postMessage: vi.fn() } as unknown as Window;
    const publisher = new ContextPublisher({ sourceId: 'source-a', relay: { postContext }, childWindow: child, serviceOrigin: 'https://courseweave.test', onRecovery });
    await publisher.publish(empty);
    expect(postContext.mock.calls.slice(0, 2).map(([value]) => value.sequence)).toEqual([0, 1]);
    await publisher.publish({ ...empty, active_path: 'next.py', surface_kind: 'source' });
    expect(onRecovery).toHaveBeenCalledWith('conflict');
    expect(child.postMessage).toHaveBeenCalledOnce();
    await publisher.retry();
    expect(postContext.mock.calls.slice(2).map(([value]) => value.sequence)).toEqual([2, 3]);
    expect(child.postMessage).toHaveBeenCalledTimes(2);
  });

  it('starts a full activation at sequence zero under its new source', async () => {
    const postContext = vi.fn().mockResolvedValue(ok());
    await new ContextPublisher({ sourceId: 'source-new', relay: { postContext }, childWindow: { postMessage: vi.fn() } as unknown as Window, serviceOrigin: 'https://courseweave.test' }).publish(empty);
    expect(postContext).toHaveBeenCalledWith({ source_id: 'source-new', sequence: 0, ...empty });
  });
});

describe('ContextObserver', () => {
  it('publishes initial, active-widget, and active-cell metadata and disconnects on disposal', async () => {
    const shellSignal = new TestSignal();
    const cellSignal = new TestSignal();
    const shell = { currentWidget: null as object | null, currentChanged: shellSignal };
    const notebook = { currentWidget: null as object | null, activeCell: null as object | null, currentChanged: new TestSignal(), activeCellChanged: cellSignal };
    const editor = { currentWidget: null as object | null, currentChanged: new TestSignal() };
    const terminal = { currentWidget: null as object | null, currentChanged: new TestSignal() };
    const publish = vi.fn().mockResolvedValue(undefined);
    const observer = new ContextObserver({ shell, notebook, editor, terminal, surfaceMetadata: () => null, publisher: { publish } });
    observer.start();
    expect(publish).toHaveBeenLastCalledWith(empty);

    const panel = { context: { path: 'notebooks/active.ipynb' } };
    const metadataSignal = new TestSignal();
    let tags = ['tag-a'];
    const cell = { model: { id: 'cell-a', getMetadata: () => tags, metadataChanged: metadataSignal } };
    shell.currentWidget = panel;
    notebook.currentWidget = panel;
    notebook.activeCell = cell;
    shellSignal.emit();
    cellSignal.emit();
    expect(publish).toHaveBeenLastCalledWith({ ...empty, active_path: 'notebooks/active.ipynb', active_cell_id: 'cell-a', active_cell_tags: ['tag-a'], surface_kind: 'notebook' });
    tags = ['tag-b'];
    metadataSignal.emit();
    expect(publish).toHaveBeenLastCalledWith({ ...empty, active_path: 'notebooks/active.ipynb', active_cell_id: 'cell-a', active_cell_tags: ['tag-b'], surface_kind: 'notebook' });

    observer.dispose();
    publish.mockClear();
    shellSignal.emit();
    cellSignal.emit();
    metadataSignal.emit();
    expect(publish).not.toHaveBeenCalled();
  });
});
