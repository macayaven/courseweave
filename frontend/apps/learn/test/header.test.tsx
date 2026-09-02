import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LearnApp, LearnHeader, type LearnHeaderProps } from '../src/app';
import { IconButton } from '@courseweave/ui';

const props: LearnHeaderProps = {
  course: { title: 'Agent Harnessing', modules: [{ id: 's01', title: 'Foundations', phases: [{ id: 'orient', title: 'Orient' }] }] },
  active: { moduleId: 's01', phaseId: 'orient' },
  provider: 'ready',
  timeBudget: 45
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function dispatchRuntime(): void {
  const reply = new MessageEvent('message', {
    data: { type: 'courseweave.runtime.v1', serviceOrigin: 'https://courseweave.test', capabilityToken: 'runtime-test-token' },
    source: window.parent
  });
  Object.defineProperty(reply, 'origin', { value: 'https://courseweave.test' });
  act(() => window.dispatchEvent(reply));
}

describe('learner shell header', () => {
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
    expect(screen.getByText('This course has no modules yet')).toBeInTheDocument();
  });

  it('renders the missing-provider recovery state without blocking navigation', async () => {
    const user = userEvent.setup();
    render(<LearnHeader {...props} provider="not_configured" />);
    expect(screen.getByText('Teacher unavailable')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open course dashboard' })).toHaveFocus();
  });

  it('uses a usable 320px narrow-rail layout and semantic keyboard labels', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    const user = userEvent.setup();
    render(<LearnHeader {...props} />);
    const dashboard = screen.getByRole('button', { name: 'Open course dashboard' });
    expect(dashboard).toBeVisible();
    await user.tab();
    expect(dashboard).toHaveFocus();
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

  it.todo('interrupted stream placeholder/recovery');
  it.todo('prediction lock');
  it.todo('hint ladder');
  it.todo('proposal Accept/Edit/Reject');
  it.todo('stale conflict recovery');

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
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps provider status unknown after successful read-side routes', async () => {
    const fetch = vi.fn((url: string) => {
      const body = url.endsWith('/course') ? { title: 'Agent Harnessing', modules: [] } : url.endsWith('/state') ? { revision: 1, time_budget_minutes: 45 } : [];
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<LearnApp />);
    dispatchRuntime();

    expect(await screen.findByText('Teacher status unknown')).toBeInTheDocument();
    expect(screen.queryByText('Teacher ready')).not.toBeInTheDocument();
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
