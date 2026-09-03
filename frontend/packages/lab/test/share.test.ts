import { afterEach, describe, expect, it, vi } from 'vitest';

import { LabCaptureProvider } from '../src/share';
import type { CourseSnapshot } from '../src/surfaces';
import { ContextPublisher, type WorkspaceMetadata } from '../src/context';

const course: CourseSnapshot = {
  id: 'course',
  title: 'Course',
  policies: { max_shared_chars: 4 },
  modules: [{
    id: 'm01',
    title: 'Module',
    phases: [{
      id: 'p01',
      title: 'Phase',
      capabilities: { share_selection: true, share_cell: true, share_output: true },
      surfaces: [{ id: 'notebook', type: 'notebook', path: 'lesson.ipynb' }]
    }]
  }]
};

function editor(source: string, start = 0, end = source.length) {
  return {
    getSelection: vi.fn(() => ({ start: { line: 0, column: start }, end: { line: 0, column: end } })),
    getOffsetAt: vi.fn((position: { column: number }) => position.column),
    model: { sharedModel: { getSource: vi.fn(() => source) } }
  };
}

function harness(options: { source?: string; tags?: string[]; outputs?: unknown[]; active?: 'editor' | 'notebook' | 'terminal'; path?: string; activeCoordinate?: () => { moduleId: string; phaseId: string } | null } = {}) {
  const child = { postMessage: vi.fn() } as unknown as Window;
  const fileEditor = editor(options.source ?? 'safe');
  const cellEditor = editor(options.source ?? 'safe');
  const panel = {
    context: { path: options.path ?? 'lesson.ipynb' },
    content: { activeCell: { editor: cellEditor, model: {
      id: 'cell-a',
      type: 'code',
      getMetadata: () => options.tags ?? [],
      sharedModel: { getSource: vi.fn(() => options.source ?? 'safe') },
      outputs: { toJSON: vi.fn(() => options.outputs ?? [{ output_type: 'stream', text: 'ok' }]) }
    } } }
  };
  const file = { context: { path: 'main.py' }, content: { editor: fileEditor } };
  const terminal = {};
  const active = options.active === 'editor' ? file : options.active === 'terminal' ? terminal : panel;
  const provider = new LabCaptureProvider({
    hostWindow: window,
    childWindow: child,
    serviceOrigin: 'https://courseweave.test',
    course: () => course,
    activeCoordinate: options.activeCoordinate ?? (() => ({ moduleId: 'm01', phaseId: 'p01' })),
    activeWidget: () => active,
    notebook: { currentWidget: panel, activeCell: panel.content.activeCell },
    editor: { currentWidget: file },
    terminal: { currentWidget: terminal }
  });
  provider.start();
  return { provider, child, fileEditor, cellEditor, panel };
}

function dispatch(child: Window, data: unknown, origin = 'https://courseweave.test', source: MessageEventSource | null = child): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

const request = { type: 'courseweave.share.capture.request.v1', requestId: 'request-a', kind: 'selection', maxChars: 4 } as const;

afterEach(() => vi.restoreAllMocks());

describe('LabCaptureProvider', () => {
  it('reads an active selection only after one exact owned-child request and returns it to the service origin', async () => {
    const { provider, child, cellEditor } = harness({ source: 'safe' });
    expect(cellEditor.model.sharedModel.getSource).not.toHaveBeenCalled();
    dispatch(child, request);
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(cellEditor.model.sharedModel.getSource).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'courseweave.share.capture.result.v1',
      requestId: 'request-a',
      kind: 'selection',
      label: 'lesson.ipynb#cell-a',
      content: 'safe'
    }, 'https://courseweave.test');
    provider.dispose();
  });

  it('ignores wrong source/origin/schema/kind and consumes a request ID only once', async () => {
    const { provider, child, cellEditor } = harness();
    dispatch(child, request, 'https://courseweave.test', {} as MessageEventSource);
    dispatch(child, request, 'https://attacker.test');
    dispatch(child, { ...request, kind: 'terminal' });
    dispatch(child, { ...request, extra: true });
    dispatch(child, request);
    dispatch(child, request);
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(cellEditor.model.sharedModel.getSource).toHaveBeenCalledOnce();
    provider.dispose();
  });

  it('captures active cell and output only through their allowed public notebook models', async () => {
    const { provider, child, panel } = harness({ source: 'cell', outputs: [{ output_type: 'stream', text: 'x' }] });
    provider.setCourse(() => ({ ...course, policies: { max_shared_chars: 100 } }));
    dispatch(child, { ...request, requestId: 'cell-request', kind: 'cell' });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'cell-request', kind: 'cell', content: 'cell' }), 'https://courseweave.test');
    await Promise.resolve();
    dispatch(child, { ...request, requestId: 'output-request', kind: 'output', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    expect(panel.content.activeCell.model.outputs.toJSON).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: 'output-request',
      kind: 'output',
      content: '[{"output_type":"stream","text":"x"}]'
    }), 'https://courseweave.test');
    provider.dispose();
  });

  it('counts Unicode code points and rejects rather than truncating over the exact policy/request cap', async () => {
    const boundary = harness({ source: '😀😀😀😀' });
    dispatch(boundary.child, request);
    await vi.waitFor(() => expect(boundary.child.postMessage).toHaveBeenCalledOnce());
    expect(boundary.child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: '😀😀😀😀' }), 'https://courseweave.test');
    boundary.provider.dispose();

    const over = harness({ source: '😀😀😀😀😀' });
    dispatch(over.child, { ...request, requestId: 'too-large' });
    await vi.waitFor(() => expect(over.child.postMessage).toHaveBeenCalledOnce());
    expect(over.child.postMessage).toHaveBeenCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'too-large', code: 'too_large' }, 'https://courseweave.test');
    expect(JSON.stringify(over.child.postMessage.mock.calls)).not.toContain('😀');
    over.provider.dispose();
  });

  it('enforces the manifest phase capability, server policy cap, active native surface, and disposal', async () => {
    const disabled = structuredClone(course);
    disabled.modules[0]!.phases[0]!.capabilities.share_selection = false;
    const { provider, child } = harness({ active: 'terminal' });
    provider.setCourse(() => disabled);
    dispatch(child, request);
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'request-a', code: 'forbidden' }, 'https://courseweave.test');
    dispatch(child, { ...request, requestId: 'over-cap', maxChars: 5 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'over-cap', code: 'forbidden' }, 'https://courseweave.test');
    provider.dispose();
    dispatch(child, { ...request, requestId: 'disposed' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.postMessage).toHaveBeenCalledTimes(2);
  });

  it('never reads or returns terminal output', async () => {
    const { provider, child } = harness({ active: 'terminal' });
    dispatch(child, request);
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'request-a', code: 'unavailable' }, 'https://courseweave.test');
    provider.dispose();
  });

  it('rejects a throwing selection accessor once and clears pending for a retry', async () => {
    const { provider, child, cellEditor } = harness({ source: 'safe' });
    cellEditor.getSelection.mockImplementationOnce(() => { throw new Error('widget exposed secret details'); });
    dispatch(child, request);
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenLastCalledWith({
      type: 'courseweave.share.capture.rejected.v1',
      requestId: 'request-a',
      code: 'unavailable'
    }, 'https://courseweave.test');
    expect(JSON.stringify(child.postMessage.mock.calls)).not.toContain('secret details');

    dispatch(child, { ...request, requestId: 'request-b' });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'request-b', content: 'safe' }), 'https://courseweave.test');
    provider.dispose();
  });

  it('rejects a throwing output serializer without reflecting the exception', async () => {
    const { provider, child, panel } = harness();
    provider.setCourse(() => ({ ...course, policies: { max_shared_chars: 100 } }));
    panel.content.activeCell.model.outputs.toJSON.mockImplementationOnce(() => { throw new Error('serialized secret detail'); });
    dispatch(child, { ...request, requestId: 'output-error', kind: 'output', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledOnce());
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'courseweave.share.capture.rejected.v1',
      requestId: 'output-error',
      code: 'unavailable'
    }, 'https://courseweave.test');
    expect(JSON.stringify(child.postMessage.mock.calls)).not.toContain('serialized secret detail');
    provider.dispose();
  });

  it('captures a shared notebook only under its currently accepted resolver phase', async () => {
    const sharedCourse = structuredClone(course);
    sharedCourse.policies.max_shared_chars = 100;
    sharedCourse.modules[0]!.phases = [
      { ...structuredClone(sharedCourse.modules[0]!.phases[0]!), id: 'cell-one', surfaces: [{ id: 'shared-one', type: 'notebook', path: 'notebooks/shared.ipynb' }] },
      { ...structuredClone(sharedCourse.modules[0]!.phases[0]!), id: 'cell-two', surfaces: [{ id: 'shared-two', type: 'notebook', path: 'notebooks/shared.ipynb' }] }
    ];
    let resolveSecond!: (response: Response) => void;
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const resolved = (phase: string, reason: 'cell_id' | 'cell_tag') => new Response(JSON.stringify({ module_id: 'm01', phase_id: phase, surface_id: phase === 'cell-one' ? 'shared-one' : 'shared-two', reason }), { status: 200 });
    const postContext = vi.fn().mockResolvedValueOnce(resolved('cell-one', 'cell_id')).mockReturnValueOnce(second).mockResolvedValueOnce(new Response(JSON.stringify({ module_id: 'm01', phase_id: 'cell-two', surface_id: 'shared-two', reason: 'cell_tag', unexpected: true }), { status: 200 }));
    const contextChild = { postMessage: vi.fn() } as unknown as Window;
    const publisher = new ContextPublisher({ sourceId: 'source-a', relay: { postContext }, childWindow: contextChild, serviceOrigin: 'https://courseweave.test' });
    const { provider, child, panel } = harness({ source: 'safe', path: 'notebooks/shared.ipynb', activeCoordinate: () => publisher.acceptedCoordinate() });
    provider.setCourse(() => sharedCourse);
    const metadata = (cell: { id: string | null; tags: string[] }): WorkspaceMetadata => ({
      active_path: 'notebooks/shared.ipynb', active_cell_id: cell.id, active_cell_tags: cell.tags,
      surface_kind: 'notebook', explicit_module_id: null, explicit_phase_id: null,
      video_seconds: null, terminal_surface_id: null
    });

    dispatch(child, { ...request, requestId: 'before', kind: 'cell', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1));
    expect(panel.content.activeCell.model.sharedModel.getSource).not.toHaveBeenCalled();

    await publisher.publish(metadata({ id: 'real-cell-one', tags: [] }));
    dispatch(child, { ...request, requestId: 'cell-one', kind: 'cell', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'cell-one', content: 'safe' }), 'https://courseweave.test');

    const transition = publisher.publish(metadata({ id: null, tags: ['second-tag'] }));
    await Promise.resolve();
    dispatch(child, { ...request, requestId: 'during-transition', kind: 'cell', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(3));
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'during-transition', code: 'forbidden' }, 'https://courseweave.test');
    resolveSecond(resolved('cell-two', 'cell_tag'));
    await transition;
    dispatch(child, { ...request, requestId: 'cell-two', kind: 'cell', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(4));
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'cell-two', content: 'safe' }), 'https://courseweave.test');

    await publisher.publish(metadata({ id: 'unknown-cell', tags: [] }));
    dispatch(child, { ...request, requestId: 'after-invalid', kind: 'cell', maxChars: 100 });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(5));
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'courseweave.share.capture.rejected.v1', requestId: 'after-invalid', code: 'forbidden' }, 'https://courseweave.test');
    expect(contextChild.postMessage).toHaveBeenCalledTimes(2);
    provider.dispose();
  });
});
