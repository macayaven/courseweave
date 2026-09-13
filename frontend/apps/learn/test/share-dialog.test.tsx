import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShareDialog } from '../src/share-dialog';

afterEach(() => cleanup());

describe('ShareDialog', () => {
  it('requires an explicit bounded confirmation and never reflects shared content in its disclosure', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ShareDialog maxChars={4} allowedKinds={['text']} onCancel={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText(/one run only/i)).toBeInTheDocument();
    expect(screen.getByText(/excludes it from server conversation replay and saved proposals/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'secret' } });
    expect(screen.getByText('6 / 4 characters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share and ask' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: 'safe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ kind: 'text', content: 'safe', label: undefined }));
  });

  it('uses a modal consent dialog, focuses its first control, escapes, and counts Unicode code points', () => {
    const cancel = vi.fn();
    render(<ShareDialog maxChars={1} allowedKinds={['text']} onCancel={cancel} onConfirm={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Share with Course assistant' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-describedby');
    expect(screen.getByLabelText('Share kind')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Share content'), { target: { value: '😀' } });
    expect(screen.getByText('1 / 1 characters')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('contains Tab and Shift+Tab within the modal controls', () => {
    render(<ShareDialog maxChars={20} allowedKinds={['text']} onCancel={vi.fn()} onConfirm={vi.fn()} />);
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
    const view = render(<ShareDialog maxChars={20} allowedKinds={['text']} onCancel={vi.fn()} onConfirm={vi.fn()} restoreFocus={restoreFocus} />);
    view.unmount();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it('discloses before requesting one non-text capture and never renders captured content', async () => {
    let resolveCapture!: (value: { kind: 'selection'; content: string; label: string }) => void;
    const onCapture = vi.fn().mockReturnValue(new Promise((resolve) => { resolveCapture = resolve; }));
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ShareDialog maxChars={4} allowedKinds={['selection', 'text']} onCancel={vi.fn()} onConfirm={onConfirm} onCapture={onCapture} />);
    expect(screen.getByText(/one run only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Share content')).not.toBeInTheDocument();
    expect(onCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    expect(onCapture).toHaveBeenCalledWith('selection', 4);
    resolveCapture({ kind: 'selection', content: 'safe', label: 'file.py' });
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ kind: 'selection', content: 'safe', label: 'file.py' }));
    expect(screen.queryByText('safe')).not.toBeInTheDocument();
  });

  it('does not confirm on capture rejection and can retry with no retained prior value', async () => {
    const onCapture = vi.fn().mockRejectedValueOnce(new Error('too_large')).mockResolvedValueOnce({ kind: 'cell', content: 'next', label: 'cell' });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ShareDialog maxChars={4} allowedKinds={['cell']} onCancel={vi.fn()} onConfirm={onConfirm} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not capture that content. Nothing was shared.');
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Share and ask' }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ kind: 'cell', content: 'next', label: 'cell' }));
  });
});
