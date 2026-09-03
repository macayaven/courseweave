import { ICommandPalette } from '@jupyterlab/apputils';
import { describe, expect, it, vi } from 'vitest';
import {
  COURSEWEAVE_COMMANDS,
  COURSEWEAVE_PALETTE_CATEGORY
} from '../src/surfaces';

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'DragEvent', {
    configurable: true,
    value: class extends Event {}
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: false,
      media: '',
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined
    })
  });
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: class {
      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      unobserve(): void {}
    }
  });
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    }
  });
});

describe('CourseWeave Lab activation', () => {
  it('requires the public palette service and exposes every registered command after registration', async () => {
    const { default: plugin } = await import('../src/index');
    expect(plugin.requires).toContain(ICommandPalette);

    const operations: string[] = [];
    const commandIds = Object.values(COURSEWEAVE_COMMANDS);
    const app = {
      commands: {
        addCommand: vi.fn((id: string) => {
          operations.push(`command:${id}`);
          return { dispose: vi.fn() };
        })
      }
    };
    const shell = {
      add: vi.fn(),
      activateById: vi.fn(),
      currentWidget: null
    };
    const paletteItems: Array<{ command: string; category: string }> = [];
    const palette = {
      addItem: vi.fn((item: { command: string; category: string }) => {
        operations.push(`palette:${item.command}`);
        paletteItems.push(item);
        return { dispose: vi.fn() };
      })
    };

    await plugin.activate(
      app as never,
      shell as never,
      palette as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null
    );

    expect(app.commands.addCommand.mock.calls.map(([id]) => id)).toEqual(commandIds);
    expect(paletteItems).toEqual(commandIds.map((command) => ({
      command,
      category: COURSEWEAVE_PALETTE_CATEGORY
    })));
    expect(new Set(paletteItems.map(({ command }) => command)).size).toBe(paletteItems.length);
    expect(operations).toEqual([
      ...commandIds.map((command) => `command:${command}`),
      ...commandIds.map((command) => `palette:${command}`)
    ]);
  });
});
