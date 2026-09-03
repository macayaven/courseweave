import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LearnApp, LearnHeader, type LearnHeaderProps } from '../src/app';
import { IconButton } from '@courseweave/ui';

const props: LearnHeaderProps = {
  course: { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'orient', title: 'Orient', kind: 'orient', completion: { type: 'manual' }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }] },
  active: { moduleId: 's01', phaseId: 'orient' },
  provider: 'ready',
  timeBudget: 45
};

const LAB_ORIGIN = 'https://lab.test';

beforeEach(() => {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value: `${LAB_ORIGIN}/`
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
});

function dispatchRuntime(capabilityToken = 'runtime-test-token'): void {
  const reply = new MessageEvent('message', {
    data: { type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken, sourceId: 'notebook-a' },
    source: window.parent
  });
  Object.defineProperty(reply, 'origin', { value: LAB_ORIGIN });
  act(() => window.dispatchEvent(reply));
}

describe('learner shell header', () => {
  it('offers an explicit runtime retry while connecting', () => {
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    render(<LearnApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('renders course, module, phase, time budget, and provider status', () => {
    render(<LearnHeader {...props} />);
    expect(screen.getByRole('banner')).toHaveTextContent('Agent Harnessing');
    expect(screen.getByText('Foundations')).toBeInTheDocument();
    expect(screen.getByText('Orient')).toBeInTheDocument();
    expect(screen.getByText('45 min')).toBeInTheDocument();
    expect(screen.getByText('Teacher ready')).toBeInTheDocument();
  });

  it('renders no-document and empty-course states', () => {
    const { rerender } = render(<LearnHeader {...props} active={null} />);
    expect(screen.getByText('No active course document')).toBeInTheDocument();
    rerender(<LearnHeader {...props} course={{ title: 'New course', modules: [] }} active={null} />);
    expect(screen.queryByText('This course has no modules yet')).not.toBeInTheDocument();
  });

  it('renders the missing-provider recovery state without blocking navigation', async () => {
    const user = userEvent.setup();
    render(<LearnHeader {...props} provider="not_configured" />);
    expect(screen.getByText('Teacher unavailable')).toBeInTheDocument();
    expect(screen.getByText('Teacher unavailable')).toBeInTheDocument();
  });

  it('uses a usable 320px narrow-rail layout and semantic keyboard labels', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    render(<LearnHeader {...props} />);
    const rail = screen.getByTestId('learn-rail');
    expect(rail).toHaveClass('cw-rail--narrow');
    expect(getComputedStyle(rail).maxWidth).toBe('320px');
  });

  it('removes effective transition and animation under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<LearnHeader {...props} />);
    const rail = screen.getByTestId('learn-rail');
    expect(rail.style.transition).toBe('none');
    expect(rail.style.animation).toBe('none');
  });

  it('integrates trusted active context, durable updates, conflict recovery, and context invalidation without replay', async () => {
    const course = { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'predict', title: 'Predict', kind: 'predict', completion: { type: 'prediction_recorded', record_id: 'prediction-1' }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }] };
    const proposal = (id: string) => ({ id, revision: 4, type: 'workspace_file_replace', origin: 'teacher_suggested', status: 'pending', summary: id, created_at: '2026-09-02T00:00:00Z', target: 'lesson.md', payload: { diff: '-old\n+new' }, target_hash: 'abc', result: null });
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = url.endsWith('/course') ? course
        : url.includes('/context?') ? { context: { source_id: 'notebook-a' }, resolved: { module_id: 's01', phase_id: 'predict', surface_id: null, reason: 'explicit_phase' } }
          : url.endsWith('/state') && method === 'GET' ? { revision: 2, predictions: {} }
            : url.endsWith('/proposals') ? [proposal('proposal-1'), proposal('proposal-2')]
              : url.endsWith('/state') ? { revision: 3, predictions: { 's01/predict/prediction-1': { text: 'my prediction' } } }
                : url.includes('/proposal-1/accept') ? { ...proposal('proposal-1'), status: 'accepted' }
                  : { code: 'proposal_conflict', message: 'Proposal changed', details: {} };
      const status = url.includes('/proposal-2/edit') ? 409 : 200;
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();

    expect(await screen.findByRole('region', { name: 'Prediction' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'my prediction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prediction' }));
    expect(await screen.findByText('Prediction recorded')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0]!);
    expect(await screen.findByText('Status: accepted')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'retain this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Proposal changed; review refreshed proposals.')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Edit summary')[1]).toHaveValue('retain this draft');
    expect(fetch.mock.calls.filter(([url, init]) => String(url).includes('/proposal-2/edit') && (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(1);

    const contextChanged = new MessageEvent('message', { data: { type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, source: window.parent });
    Object.defineProperty(contextChanged, 'origin', { value: 'https://lab.test' });
    act(() => window.dispatchEvent(contextChanged));
    await vi.waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).includes('/context?'))).toHaveLength(2));
  });

  it('clears a prediction draft when trusted context resolves a different phase', async () => {
    const course = { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: ['predict-a', 'predict-b'].map((id) => ({ id, title: id, kind: 'predict', completion: { type: 'prediction_recorded', record_id: `${id}-record` }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] })) }] };
    let contextReads = 0;
    const fetch = vi.fn((url: string) => {
      const body = url.endsWith('/course') ? course
        : url.endsWith('/state') ? { revision: 2, predictions: {} }
          : url.endsWith('/proposals') ? []
            : { context: { source_id: 'notebook-a' }, resolved: { module_id: 's01', phase_id: contextReads++ === 0 ? 'predict-a' : 'predict-b', surface_id: null, reason: 'explicit_phase' } };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();
    expect(await screen.findByRole('heading', { name: 'predict-a', level: 2 })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your prediction'), { target: { value: 'only phase A' } });

    const changed = new MessageEvent('message', { data: { type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, source: window.parent });
    Object.defineProperty(changed, 'origin', { value: 'https://lab.test' });
    act(() => window.dispatchEvent(changed));

    expect(await screen.findByRole('heading', { name: 'predict-b', level: 2 })).toBeInTheDocument();
    expect(screen.getByLabelText('Your prediction')).toHaveValue('');
  });

  it('enters recovery after a 401 without retrying authenticated reads or mutations', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'forbidden', message: 'Expired capability', details: {} }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();

    expect(await screen.findByRole('heading', { name: 'Reconnect to CourseWeave' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps teacher and proposal drafts mounted through recovery, then reconnects with read-only durable refreshes', async () => {
    const course = { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'read', title: 'Read', kind: 'read', completion: { type: 'manual' }, capabilities: { chat: true, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }] };
    const proposal = { id: 'proposal-1', revision: 1, type: 'profile_patch', origin: 'teacher_suggested', status: 'pending', summary: 'Improve profile', created_at: '2026-09-02T00:00:00Z', target: 'profile', payload: {}, target_hash: null, result: null };
    let contextCalls = 0;
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/context?') && contextCalls++ === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'forbidden', message: 'Reconnect', details: {} }), { status: 401, headers: { 'content-type': 'application/json' } }));
      const body = url.endsWith('/course') ? course : url.endsWith('/state') ? { revision: 1 } : url.endsWith('/proposals') ? [proposal] : { context: { source_id: 'notebook-a' }, resolved: { module_id: 's01', phase_id: 'read', surface_id: null, reason: 'explicit_phase' } };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();
    expect(await screen.findByLabelText('Ask the teacher')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'unsent question' } });
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'unsent edit' } });
    const changed = new MessageEvent('message', { data: { type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, source: window.parent });
    Object.defineProperty(changed, 'origin', { value: 'https://lab.test' });
    act(() => window.dispatchEvent(changed));
    expect(await screen.findByRole('heading', { name: 'Reconnect to CourseWeave' })).toBeInTheDocument();
    expect(screen.getByText('Your draft is unsent.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the teacher')).toHaveValue('unsent question');
    expect(screen.getByLabelText('Edit summary')).toHaveValue('unsent edit');
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    dispatchRuntime();
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Reconnect to CourseWeave' })).not.toBeInTheDocument());
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/course'))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/state'))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/proposals'))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST' || (init as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(0);
  });

  it('rebootstraps with a fresh runtime and restores controlled drafts after a recovery 401', async () => {
    const course = { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'read', title: 'Read', kind: 'read', completion: { type: 'manual' }, capabilities: { chat: true, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }] };
    const proposal = { id: 'proposal-1', revision: 1, type: 'profile_patch', origin: 'teacher_suggested', status: 'pending', summary: 'Improve profile', created_at: '2026-09-02T00:00:00Z', target: 'profile', payload: {}, target_hash: null, result: null };
    let contextCalls = 0;
    const fetch = vi.fn((url: string) => {
      if (url.includes('/context?') && contextCalls++ === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'forbidden', message: 'Reconnect', details: {} }), { status: 401, headers: { 'content-type': 'application/json' } }));
      const body = url.endsWith('/course') ? course : url.endsWith('/state') ? { revision: 1 } : url.endsWith('/proposals') ? [proposal] : { context: { source_id: 'notebook-a' }, resolved: { module_id: 's01', phase_id: 'read', surface_id: null, reason: 'explicit_phase' } };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    const postMessage = vi.spyOn(window.parent, 'postMessage');
    render(<LearnApp />);
    dispatchRuntime('first-token');
    expect(await screen.findByLabelText('Ask the teacher')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ask the teacher'), { target: { value: 'survives rebootstrap' } });
    fireEvent.change(screen.getByLabelText('Edit summary'), { target: { value: 'orphan-safe edit' } });
    const changed = new MessageEvent('message', { data: { type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, source: window.parent });
    Object.defineProperty(changed, 'origin', { value: 'https://lab.test' });
    act(() => window.dispatchEvent(changed));
    await screen.findByRole('heading', { name: 'Reconnect to CourseWeave' });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    dispatchRuntime('second-token');
    expect(await screen.findByLabelText('Ask the teacher')).toHaveValue('survives rebootstrap');
    expect(screen.getByLabelText('Edit summary')).toHaveValue('orphan-safe edit');
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/course'))).toHaveLength(2);
  });

  it('uses neutral connecting copy rather than claiming a blank draft is unsent', async () => {
    const course = { title: 'Agent Harnessing', modules: [] };
    let contextCalls = 0;
    const fetch = vi.fn((url: string) => {
      if (url.includes('/context?') && contextCalls++ === 1) return Promise.resolve(new Response(JSON.stringify({ code: 'forbidden', message: 'Reconnect', details: {} }), { status: 401, headers: { 'content-type': 'application/json' } }));
      const body = url.endsWith('/course') ? course : url.endsWith('/state') ? { revision: 1 } : url.endsWith('/proposals') ? [] : { context: { source_id: 'notebook-a' }, resolved: { module_id: null, phase_id: null, surface_id: null, reason: 'empty_course' } };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();
    await screen.findByText('Teacher status unknown');
    const changed = new MessageEvent('message', { data: { type: 'courseweave.context.changed.v1', sourceId: 'notebook-a' }, source: window.parent });
    Object.defineProperty(changed, 'origin', { value: 'https://lab.test' });
    act(() => window.dispatchEvent(changed));
    await screen.findByRole('heading', { name: 'Reconnect to CourseWeave' });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(await screen.findByRole('button', { name: 'Retry connection' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Unsent drafts')).not.toBeInTheDocument();
    expect(screen.queryByText('Your draft is unsent.')).not.toBeInTheDocument();
  });

  it('keeps provider status unknown after successful read-side routes', async () => {
    const fetch = vi.fn((url: string) => {
      const body = url.endsWith('/course') ? { title: 'Agent Harnessing', modules: [] } : url.endsWith('/state') ? { revision: 1, time_budget_minutes: 45 } : url.includes('/context?') ? { context: { source_id: 'notebook-a' }, resolved: { module_id: null, phase_id: null, surface_id: null, reason: 'empty_course' } } : [];
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();

    expect(await screen.findByText('Teacher status unknown')).toBeInTheDocument();
    expect(screen.queryByText('Teacher ready')).not.toBeInTheDocument();
  });

  it('wires the manifest-ordered learner dashboard after trusted reads', async () => {
    const fetch = vi.fn((url: string) => {
      const body = url.endsWith('/course') ? { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'read', title: 'Read', kind: 'read', completion: { type: 'manual' }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [] }] }] } : url.endsWith('/state') ? { revision: 1 } : url.includes('/context?') ? { context: { source_id: 'notebook-a' }, resolved: { module_id: 's01', phase_id: 'read', surface_id: null, reason: 'explicit_phase' } } : [];
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();

    expect(await screen.findByRole('region', { name: 'Course dashboard' })).toBeInTheDocument();
  });

  it('renders IconButton with its required accessible name', () => {
    render(<IconButton aria-label="Close guide">×</IconButton>);
    expect(screen.getByRole('button', { name: 'Close guide' })).toBeInTheDocument();
  });

  it.each(['', '   '])('rejects an empty accessible IconButton name at runtime: %j', (label) => {
    expect(() => render(<IconButton aria-label={label}>×</IconButton>)).toThrow('IconButton requires a non-empty aria-label.');
  });

  // @ts-expect-error IconButton cannot omit its accessible name.
  const unnamedIconButton = <IconButton />;
  void unnamedIconButton;

  // @ts-expect-error IconButton cannot use a literal empty accessible name.
  const emptyIconButton = <IconButton aria-label="" />;
  void emptyIconButton;
});
