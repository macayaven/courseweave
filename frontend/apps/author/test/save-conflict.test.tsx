import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SaveConflict } from '../src/save-conflict';

afterEach(cleanup);
describe('Author Save and stale recovery', () => {
  it('validates before one exact save and leaves a stale draft for an explicit later decision', async () => {
    const validate = vi.fn().mockResolvedValue({ manifest: { schema_version: 1 }, formatted_json: '{\n  "schema_version": 1\n}\n' });
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('stale'), { status: 409 }));
    const latest = vi.fn().mockResolvedValue({ manifest: { schema_version: 1, title: 'Remote' }, raw: '{\n  "title": "Remote"\n}\n', etag: '"remote"' });
    const saved = vi.fn();
    render(<SaveConflict manifest={{ schema_version: 1 }} etag={'"old"'} exists dirty validate={validate} put={put} getLatest={latest} onSaved={saved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }));
    expect(await screen.findByText(/remote version changed/i)).toBeInTheDocument();
    expect(validate).toHaveBeenCalledBefore(put as never);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('{\n  "schema_version": 1\n}\n', '"old"', expect.anything());
    expect(latest).toHaveBeenCalledOnce();
    expect(screen.getByText(/"Remote"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my draft after review' }));
    expect(saved).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
  });

  it('does not create a missing manifest until the explicit Save click', () => {
    render(<SaveConflict manifest={{ schema_version: 1 }} etag="" exists={false} dirty={false} validate={vi.fn(() => new Promise<{ manifest: unknown; formatted_json: string }>(() => {}))} put={vi.fn()} getLatest={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save course' })).toBeEnabled();
  });

  it('does not overwrite a newer local edit when its save response arrives late', async () => {
    let finishValidation: ((value: { manifest: unknown; formatted_json: string }) => void) | undefined;
    const validate = vi.fn(() => new Promise<{ manifest: unknown; formatted_json: string }>((resolve) => { finishValidation = resolve; }));
    const put = vi.fn().mockResolvedValue({ manifest: { schema_version: 1, title: 'Saved' }, raw: '{\n  "title": "Saved"\n}\n', etag: '"saved"' });
    const saved = vi.fn();
    const props = { manifest: { schema_version: 1 }, etag: '"old"', exists: true, dirty: true, validate, put, getLatest: vi.fn(), onSaved: saved, requestGeneration: 0, onRemoteSaved: vi.fn() };
    const view = render(<SaveConflict {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save course' }));
    view.rerender(<SaveConflict {...props} requestGeneration={1} />);
    finishValidation?.({ manifest: { schema_version: 1 }, formatted_json: '{}\n' });
    await Promise.resolve();
    expect(put).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
});
