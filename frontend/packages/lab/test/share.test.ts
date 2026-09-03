import { afterEach, describe, expect, it, vi } from 'vitest';

import { LabCaptureProvider } from '../src/share';
import type { CourseSnapshot } from '../src/surfaces';

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

function harness(options: { source?: string; tags?: string[]; outputs?: unknown[]; active?: 'editor' | 'notebook' | 'terminal' } = {}) {
  const child = { postMessage: vi.fn() } as unknown as Window;
  const fileEditor = editor(options.source ?? 'safe');
  const cellEditor = editor(options.source ?? 'safe');
  const panel = {
    context: { path: 'lesson.ipynb' },
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
    activeCoordinate: () => ({ moduleId: 'm01', phaseId: 'p01' }),
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
});
