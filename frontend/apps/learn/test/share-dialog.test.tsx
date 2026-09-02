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

  it('uses a modal consent dialog, focuses its first control, escapes, and counts Unicode code points', () => {
    const cancel = vi.fn();
    render(<ShareDialog maxChars={1} allowedKinds={['selection']} onCancel={cancel} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Share with teacher' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByLabelText('Share kind')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: '😀' } });
    expect(screen.getByText('1 / 1 characters')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('contains Tab and Shift+Tab within the modal controls', () => {
    render(<ShareDialog maxChars={20} allowedKinds={['selection']} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByLabelText('Share kind')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(cancel).toHaveFocus();
  });

  it('restores focus through its cleanup path when the parent closes the dialog', () => {
    const restoreFocus = vi.fn();
    const view = render(<ShareDialog maxChars={20} allowedKinds={['selection']} onCancel={vi.fn()} onConfirm={vi.fn()} restoreFocus={restoreFocus} />);
    view.unmount();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });
});
