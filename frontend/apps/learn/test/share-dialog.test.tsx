import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShareDialog } from '../src/share-dialog';

afterEach(() => cleanup());

describe('ShareDialog', () => {
  it('requires an explicit bounded confirmation and never reflects shared content in its disclosure', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ShareDialog maxChars={4} allowedKinds={['selection']} onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText(/one run only/i)).toBeInTheDocument();
    expect(screen.getByText(/not saved to conversation history or proposals/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'secret' } });
    expect(screen.getByText('6 / 4 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share and ask' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'safe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ kind: 'selection', content: 'safe', label: undefined }));
  });
});
