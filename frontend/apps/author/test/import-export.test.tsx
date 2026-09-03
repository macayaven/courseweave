import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportExport, readImportFile } from '../src/import-export';

const valid = { schema_version: 1, id: 'course', title: 'C' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Author import and export', () => {
  it('fatally reads only a bounded UTF-8 schema-v1 object before validation', async () => {
    await expect(readImportFile(new File([JSON.stringify(valid)], 'courseweave.json', { type: 'application/json' }))).resolves.toEqual(valid);
    await expect(readImportFile(new File(['[1]'], 'array.json'))).rejects.toThrow('object');
    await expect(readImportFile(new File(['{"schema_version":2}'], 'future.json'))).rejects.toThrow('schema version');
    await expect(readImportFile(new File([new Uint8Array([0xc3, 0x28])], 'broken.json'))).rejects.toThrow('UTF-8');
    await expect(readImportFile(new File([new Uint8Array(1024 * 1024 + 1)], 'large.json'))).rejects.toThrow('1 MiB');
  });

  it('retains the current state on failed import and can import the same file twice', async () => {
    const validate = vi.fn().mockResolvedValue({ manifest: valid, formatted_json: '{\n  "schema_version": 1\n}\n' });
    const imported = vi.fn();
    render(<ImportExport manifest={valid} formattedJson={null} validate={validate} onImport={imported} />);
    const input = screen.getByLabelText('Import course file');
    const bad = new File(['[]'], 'bad.json');
    fireEvent.change(input, { target: { files: [bad] } });
    expect(await screen.findByText(/must be an object/i)).toBeInTheDocument();
    expect(imported).not.toHaveBeenCalled();
    const good = new File([JSON.stringify(valid)], 'courseweave.json');
    fireEvent.change(input, { target: { files: [good] } });
    await screen.findByText(/Imported into the local draft/i);
    fireEvent.change(input, { target: { files: [good] } });
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(2));
  });

  it('exports exactly server canonical bytes using a fixed safe filename and revokes its blob URL', () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:course');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<ImportExport manifest={valid} formattedJson={'{\n  "title": "café"\n}\n'} validate={vi.fn()} onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export courseweave.json' }));
    expect(create).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json;charset=utf-8');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:course');
  });
});
