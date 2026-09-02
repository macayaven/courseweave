import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReconnectPanel } from '../src/reconnect';

afterEach(() => cleanup());

describe('ReconnectPanel', () => {
  it('requires an explicit reconnect and labels preserved drafts as unsent', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    render(<ReconnectPanel hasDraft onReconnect={reconnect} />);
    expect(screen.getByText('Your draft is unsent.')).toBeInTheDocument();
    expect(reconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await vi.waitFor(() => expect(reconnect).toHaveBeenCalledOnce());
  });
});
