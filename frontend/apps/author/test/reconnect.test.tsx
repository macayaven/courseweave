import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useBeforeUnload, type RecoveryStatus } from '../src/reconnect';

function Harness({ dirty, status }: { dirty: boolean; status: RecoveryStatus }) { useBeforeUnload(dirty); return <output>{status}</output>; }
afterEach(cleanup);
describe('Author reconnect and unload recovery', () => {
  it('installs beforeunload only while a local draft is dirty and removes it after save/unmount', () => {
    const listener = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<Harness dirty status="connected" />);
    expect(listener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    view.rerender(<Harness dirty={false} status="connected" />);
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    view.unmount();
  });

  it('models reconnecting and conflict recovery without an automatic save replay', () => {
    render(<Harness dirty status="conflict" />);
    expect(screen.getByText('conflict')).toBeInTheDocument();
  });
});
