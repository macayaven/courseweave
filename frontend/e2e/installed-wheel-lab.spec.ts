import { expect, test, type Page } from 'playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { failingBootstrapProxy, launchInstalledWorkspace, prepareCommittedCourseCopy, usingTestResourceCustody } from './installed-wheel-helpers';
import { OwnedProcessTracker, stopOwnedProcess } from './process-cleanup';

const TINY_MP4 = Buffer.from(
  'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC7W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAHvdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAABi21kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAMgAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATZtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAD2c3RibAAAAKpzdHNkAAAAAAAAAAEAAACaYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAwIGxpYngyNjQAAAAAAAAAAAAAABj//wAAADRhdmNDAWQACv/hABdnZAAKrNlewEQAAAMABAAAAwDIPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNvAAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAACIbW9vZgAAABBtZmhkAAAAAAAAAAEAAABwdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADEQAAAgAAAALFAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAMHRydW4AAAoFAAAAAwAAAJACAAAAAAACxQAABAAAAAAMAAAGAAAAAAwAAAIAAAAC5W1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAPZYiEADP//vbsvgU2FMjBAAAACEGaImxCv/7AAAAACAGeQXkK/8SBAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAEAAAAAAAAAAMRAQEBAAAAEG1mcm8AAAAAAAAAQw==',
  'base64'
);

async function bootstrap(page: Page, tokenlessUrl: string): Promise<void> {
  try {
    const response = await page.goto(tokenlessUrl, { waitUntil: 'domcontentloaded' });
    if (response === null || !response.ok()) throw new Error('unsafe bootstrap detail');
  } catch {
    throw new Error('Installed-wheel bootstrap navigation failed.');
  }
}

const PALETTE_STEP_TIMEOUT_MS = 10_000;
const DASHBOARD_COMMAND = 'Open CourseWeave Dashboard';

async function invokePaletteCommand(page: Page, command: string, timeout = PALETTE_STEP_TIMEOUT_MS): Promise<void> {
  await page.getByRole('menuitem', { name: 'View', exact: true }).click({ timeout });
  const activatePalette = page.getByRole('menuitem', { name: /^Activate Command Palette(?:\s|$)/ });
  await expect(activatePalette).toHaveCount(1, { timeout });
  await activatePalette.click({ timeout });
  const palette = page.locator('.jp-ModalCommandPalette');
  const input = palette.locator('.lm-CommandPalette-input');
  await expect(palette).toBeVisible({ timeout });
  await expect(input).toBeVisible({ timeout });
  await input.focus({ timeout });
  await expect(input).toBeFocused({ timeout });
  await input.pressSequentially(command, { delay: 10, timeout });
  await expect(input).toHaveValue(command, { timeout });
  await expect(palette.getByRole('menuitem', { name: command, exact: true })).toBeVisible({ timeout });
  await input.press('Enter', { timeout });
  await expect(palette).toBeHidden({ timeout });
}

async function credentialSnapshot(page: Page, runtimeId: string) {
  const credential = await page.evaluate(async (id) => {
    const pageConfig = JSON.parse(document.querySelector('#jupyter-config-data')?.textContent ?? '{}') as Record<string, unknown>;
    const runtime = await (await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': id } })).json() as { capabilityToken: string };
    return { capabilityToken: runtime.capabilityToken, pageConfig };
  }, runtimeId);
  const storage = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => ({
        url: location.href,
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage)
      }));
    } catch {
      return { url: frame.url(), inaccessible: true };
    }
  }));
  return { ...credential, storage: JSON.stringify(storage) };
}

function assertAuthorBrowserClean(
  pageErrors: string[],
  consoleMessages: Array<{ type: string; text: string; url: string }>
): void {
  if (pageErrors.length > 0 || consoleMessages.some((message) => message.type === 'error')) {
    throw new Error('Installed Author reported unexpected browser errors.');
  }
}

test.describe.configure({ timeout: 300_000, mode: 'serial' });

test('resource custody cleans every acquired resource when the next acquisition fails', async () => {
  const cleaned: string[] = [];

  await expect(usingTestResourceCustody(async (custody) => {
    await custody.acquire(async () => 'source verification', async (name) => { cleaned.push(name); }, 5);
    await custody.acquire(async () => 'workspace', async (name) => { cleaned.push(name); }, 0);
    await custody.acquire(async () => 'context', async (name) => { cleaned.push(name); }, 10);
    await custody.acquire(async () => { throw new Error('page acquisition failed'); }, async () => undefined, 20);
  })).rejects.toThrow('page acquisition failed');

  expect(cleaned).toEqual(['workspace', 'source verification', 'context']);
});

test('resource custody preserves the primary failure and surfaces every cleanup failure', async () => {
  const attempted: string[] = [];
  let failure: unknown;

  try {
    await usingTestResourceCustody(async (custody) => {
      await custody.acquire(async () => 'workspace', async (name) => {
        attempted.push(name);
        throw new Error('workspace cleanup failed');
      }, 0);
      await custody.acquire(async () => 'context', async (name) => {
        attempted.push(name);
        throw new Error('context cleanup failed');
      }, 10);
      throw new Error('primary test failure');
    });
  } catch (error) {
    failure = error;
  }

  expect(attempted).toEqual(['workspace', 'context']);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).cause).toEqual(expect.objectContaining({ message: 'primary test failure' }));
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: 'primary test failure' }),
    expect.objectContaining({ message: 'workspace cleanup failed' }),
    expect.objectContaining({ message: 'context cleanup failed' }),
  ]);
});

test('committed adapter copy disables optional Git locks for every source operation', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-readonly-git-proof-'));
  const source = join(owned, 'source');
  const bin = join(owned, 'bin');
  let copy: Awaited<ReturnType<typeof prepareCommittedCourseCopy>> | undefined;
  const previousPath = process.env.PATH;
  try {
    await mkdir(source);
    await mkdir(bin);
    await writeFile(join(source, 'courseweave.json'), '{}\n', 'utf8');
    const git = (args: string[]) => {
      const result = spawnSync('/usr/bin/git', ['-C', source, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Read-only Git proof fixture setup failed.');
      return result.stdout.trim();
    };
    git(['init', '--quiet']);
    git(['add', 'courseweave.json']);
    git(['-c', 'user.name=CourseWeave Test', '-c', 'user.email=courseweave@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    await writeFile(join(bin, 'git'), '#!/bin/sh\ntest "$GIT_OPTIONAL_LOCKS" = 0 || exit 91\nexec /usr/bin/git "$@"\n', 'utf8');
    await chmod(join(bin, 'git'), 0o700);
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    copy = await prepareCommittedCourseCopy(source, {
      head: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
      manifestSha256: createHash('sha256').update('{}\n').digest('hex'),
    });
    await expect(copy.verifySourceUnchanged()).resolves.toEqual(expect.objectContaining({ status: '' }));
  } finally {
    process.env.PATH = previousPath;
    const cleanup = await Promise.allSettled([
      copy === undefined ? Promise.resolve() : copy.close(),
      rm(owned, { recursive: true, force: true }),
    ]);
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Read-only Git proof cleanup failed.');
  }
});

test('final credential audit detects a canary created only at shutdown and still deletes the owned root', async ({ browser }) => {
  const shutdownCanary = 'courseweave-dummy-shutdown-only-canary';
  let workspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let page: Page | undefined;
  let closeFailure: unknown;
  try {
    workspace = await launchInstalledWorkspace('learn', {
      shutdownCredentialCanary: { value: shutdownCanary, fileName: 'shutdown-only-canary.txt' },
    });
    context = await browser.newContext();
    page = await context.newPage();
    await bootstrap(page, await workspace.bootstrapUrl());
    const pageConfig = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
    expect(typeof pageConfig.courseweaveRuntimeId).toBe('string');
    const credential = await credentialSnapshot(page, pageConfig.courseweaveRuntimeId as string);
    workspace.scheduleFinalCredentialAudit({
      ...credential,
      browserOutput: '',
      locations: page.frames().map((frame) => frame.url()),
    });
    await expect(workspace.shutdownCredentialCanaryExists()).resolves.toBe(false);
    try { await workspace.close(); } catch (error) { closeFailure = error; }
  } finally {
    const cleanup = await Promise.allSettled([
      page === undefined ? Promise.resolve() : page.close(),
      context === undefined ? Promise.resolve() : context.close(),
      workspace === undefined || closeFailure !== undefined ? Promise.resolve() : workspace.close(),
    ]);
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Shutdown-canary test cleanup failed.');
  }

  expect(closeFailure).toEqual(expect.objectContaining({ message: 'Installed-wheel credential scan found a retained credential.' }));
  await expect(workspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });
});

test('Author browser telemetry rejects arbitrary page and error-level console failures', () => {
  const message = 'Installed Author reported unexpected browser errors.';
  expect(() => assertAuthorBrowserClean(['arbitrary page failure'], [])).toThrow(message);
  expect(() => assertAuthorBrowserClean([], [
    { type: 'error', text: 'arbitrary console failure', url: 'http://127.0.0.1/' }
  ])).toThrow(message);
  expect(() => assertAuthorBrowserClean([], [
    { type: 'warning', text: 'non-error console message', url: 'http://127.0.0.1/' }
  ])).not.toThrow();
});

test('focused command-palette proof requires native keyboard input and Enter', async ({ page }) => {
  await page.setContent(`
    <button role="menuitem" id="view">View</button>
    <button role="menuitem" id="activate" hidden>
      <span>Activate Command Palette</span> <span>⇧ ⌘ C</span>
    </button>
    <div class="jp-ModalCommandPalette" id="palette" hidden>
      <input class="lm-CommandPalette-input" aria-label="SEARCH" />
      <div class="lm-CommandPalette-item" role="menuitem">${DASHBOARD_COMMAND}</div>
    </div>
    <div id="courseweave-dashboard" hidden>Installed wheel rich course</div>
    <script>
      const command = ${JSON.stringify(DASHBOARD_COMMAND)};
      const activate = document.querySelector('#activate');
      const palette = document.querySelector('#palette');
      const input = document.querySelector('.lm-CommandPalette-input');
      const dashboard = document.querySelector('#courseweave-dashboard');
      let keyboardQuery = '';
      document.querySelector('#view').addEventListener('click', () => { activate.hidden = false; });
      activate.addEventListener('click', () => {
        palette.hidden = false;
        input.focus();
        input.select();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key.length === 1) keyboardQuery += event.key;
        if (event.key === 'Enter' && keyboardQuery === command) {
          dashboard.hidden = false;
          palette.hidden = true;
        }
      });
      input.addEventListener('input', () => {
        if (input.value !== keyboardQuery) input.value = '';
      });
    </script>
  `);

  await invokePaletteCommand(page, DASHBOARD_COMMAND, 500);

  await expect(page.locator('#courseweave-dashboard')).toBeVisible({ timeout: 500 });
});

test('a bounded palette failure still stops its live supervisor and removes its owned root in finally', async ({ page }) => {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-bounded-palette-cleanup-'));
  const supervisor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    detached: true,
    stdio: 'ignore'
  });
  if (supervisor.pid === undefined) throw new Error('Bounded cleanup proof supervisor did not start.');
  const tracker = new OwnedProcessTracker(supervisor.pid);
  let interactionError: unknown;
  let cleanupError: unknown;

  expect(tracker.live().some((process) => process.pid === supervisor.pid)).toBe(true);
  try {
    await invokePaletteCommand(page, DASHBOARD_COMMAND, 100);
  } catch (error) {
    interactionError = error;
  } finally {
    const cleanup = await Promise.allSettled([page.close(), stopOwnedProcess(supervisor, tracker)]);
    if (cleanup[1]?.status === 'fulfilled') {
      await rm(owned, { recursive: true, force: true });
    } else {
      cleanupError = cleanup[1]?.reason;
    }
  }

  expect(interactionError).toBeInstanceOf(Error);
  expect((interactionError as Error).message).toContain('Timeout 100ms exceeded');
  expect(cleanupError).toBeUndefined();
  expect(tracker.live()).toEqual([]);
  await expect(access(owned)).rejects.toThrow();
});

test('cleanup fails closed when a supervisor exits after spawning an unobserved detached child', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-unobserved-cleanup-proof-'));
  const start = join(owned, 'start');
  const ready = join(owned, 'ready');
  let descendantPid = 0;
  try {
    const script = `
      const { existsSync, writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const timer = setInterval(() => {
        if (!existsSync(process.argv[1])) return;
        clearInterval(timer);
        const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { detached: true, stdio: 'ignore' });
        descendant.unref();
        writeFileSync(process.argv[2], String(descendant.pid));
        process.exit(0);
      }, 10);
    `;
    const supervisor = spawn(process.execPath, ['-e', script, start, ready], { detached: true, stdio: 'ignore' });
    if (supervisor.pid === undefined) throw new Error('Unobserved cleanup proof supervisor did not start.');
    const tracker = new OwnedProcessTracker(supervisor.pid);
    const supervisorExit = new Promise<void>((resolveExit) => supervisor.once('exit', () => resolveExit()));
    await writeFile(start, 'spawn\n', 'utf8');
    await expect.poll(async () => Number(await readFile(ready, 'utf8').catch(() => '0'))).toBeGreaterThan(0);
    descendantPid = Number(await readFile(ready, 'utf8'));
    await supervisorExit;
    expect(tracker.snapshot().some((process) => process.pid === descendantPid)).toBe(false);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    await expect(stopOwnedProcess(supervisor, tracker)).rejects.toThrow(
      'CourseWeave supervisor exited before its owned descendants.'
    );
  } finally {
    if (descendantPid > 0) {
      await expect.poll(() => {
        try { process.kill(descendantPid, 0); return true; } catch { return false; }
      }, { timeout: 5_000 }).toBe(false);
    }
    await rm(owned, { recursive: true, force: true });
  }
});

test('a failed bootstrap keeps its one-time token out of navigation errors', async ({ page }) => {
  const secret = ['installed', 'bootstrap', 'sentinel'].join('-');
  const proxy = await failingBootstrapProxy(secret);
  try {
    await expect(bootstrap(page, proxy.url)).rejects.toThrow('Installed-wheel bootstrap navigation failed.');
    await expect(bootstrap(page, proxy.url)).rejects.not.toThrow(secret);
    expect(page.url()).not.toContain(secret);
  } finally {
    await proxy.close();
  }
});

test('cleanup fails closed when a separately sessioned descendant outlives its supervisor', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-cleanup-proof-'));
  const ready = join(owned, 'ready');
  const release = join(owned, 'release');
  let supervisor: ChildProcess | undefined;
  let tracker: OwnedProcessTracker | undefined;
  let descendantPid = 0;
  try {
    const script = `
      const { existsSync, writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { detached: true, stdio: 'ignore' });
      descendant.unref();
      writeFileSync(process.argv[1], String(descendant.pid));
      const timer = setInterval(() => {
        if (existsSync(process.argv[2])) { clearInterval(timer); process.exit(0); }
      }, 10);
    `;
    supervisor = spawn(process.execPath, ['-e', script, ready, release], { detached: true, stdio: 'ignore' });
    if (supervisor.pid === undefined) throw new Error('Cleanup proof supervisor did not start.');
    tracker = new OwnedProcessTracker(supervisor.pid);
    await expect.poll(async () => Number(await readFile(ready, 'utf8').catch(() => '0'))).toBeGreaterThan(0);
    descendantPid = Number(await readFile(ready, 'utf8'));
    expect(tracker.refresh().some((process) => process.pid === descendantPid)).toBe(true);
    const supervisorExit = new Promise<void>((resolveExit) => supervisor!.once('exit', () => resolveExit()));
    await writeFile(release, 'exit\n', 'utf8');
    await supervisorExit;
    expect(tracker.live().some((process) => process.pid === descendantPid)).toBe(true);
    await expect(stopOwnedProcess(supervisor, tracker)).rejects.toThrow(
      'CourseWeave supervisor exited before its owned descendants.'
    );
    await expect.poll(() => tracker!.live(), { timeout: 5_000 }).toEqual([]);
  } finally {
    if (supervisor !== undefined && tracker !== undefined) {
      await stopOwnedProcess(supervisor, tracker).catch(() => undefined);
    }
    await rm(owned, { recursive: true, force: true });
  }
});

test('fresh installed wheel opens an authenticated Learn workspace without Node in its runtime PATH', async ({ browser, request }, testInfo) => {
  let workspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
  await usingTestResourceCustody(async (custody) => {
  workspace = await custody.acquire(
    () => launchInstalledWorkspace('learn'),
    async (ownedWorkspace) => { await ownedWorkspace.close(); },
    0,
  );
  const context = await custody.acquire(
    () => browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] }),
    async (ownedContext) => { await ownedContext.close(); },
    20,
  );
  const page = await custody.acquire(() => context.newPage(), async (ownedPage) => { await ownedPage.close(); }, 10);
  const pageErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string; url: string }> = [];
  const publishedContexts: Array<Record<string, unknown>> = [];
  const contextResponses: Array<{ method: string; status: number; url: string; sourceId: string | null; order: number }> = [];
  let responseOrder = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text(), url: message.location().url }));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/courseweave/context')) {
      try { publishedContexts.push(request.postDataJSON() as Record<string, unknown>); } catch { /* asserted by the missing-XSRF probe */ }
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (!url.pathname.endsWith('/context')) return;
    let sourceId = url.searchParams.get('source_id');
    if (request.method() === 'POST') {
      try {
        const body = request.postDataJSON() as Record<string, unknown>;
        sourceId = typeof body.source_id === 'string' ? body.source_id : null;
      } catch { sourceId = null; }
    }
    contextResponses.push({ method: request.method(), status: response.status(), url: response.url(), sourceId, order: responseOrder++ });
  });
    const bootstrapUrl = await workspace.bootstrapUrl();
    const baseUrl = await workspace.jupyterBaseUrl();
    const unauthenticated = await context.request.get(`${baseUrl}lab`, { maxRedirects: 0 });
    expect([302, 403]).toContain(unauthenticated.status());

    await page.route('https://video.example.test/video.mp4', (route) => route.fulfill({ status: 200, contentType: 'video/mp4', body: TINY_MP4 }));
    await bootstrap(page, bootstrapUrl);
    expect(page.url()).not.toContain('token=');
    const config = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
    await page.evaluate(() => document.body.removeAttribute('data-jupyter-api-token'));
    expect(Object.keys(config).filter((key) => key.startsWith('courseweave')).sort()).toEqual([
      'courseweaveServiceUrl', 'courseweaveRuntimeId', 'courseweaveLaunchMode',
    ].sort());
    expect(config.token).toEqual(expect.any(String));
    expect({
      courseweaveServiceUrl: config.courseweaveServiceUrl,
      courseweaveRuntimeId: config.courseweaveRuntimeId,
      courseweaveLaunchMode: config.courseweaveLaunchMode,
    }).toEqual({
      courseweaveServiceUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      courseweaveRuntimeId: expect.any(String),
      courseweaveLaunchMode: 'learn',
    });
    expect(Object.prototype.hasOwnProperty.call(config, 'courseweaveCapabilityToken')).toBe(false);
    const unauthenticatedCourse = await request.get(`${baseUrl}courseweave/course`, { headers: { 'X-CourseWeave-Runtime-ID': config.courseweaveRuntimeId as string } });
    expect([401, 403]).toContain(unauthenticatedCourse.status());

    const relays = await page.evaluate(async (runtimeId) => {
      const headers = { 'X-CourseWeave-Runtime-ID': runtimeId };
      const response = await fetch('courseweave/runtime', { headers });
      const missingRuntime = await fetch('courseweave/runtime');
      const wrongRuntime = await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': 'wrong-runtime' } });
      const runtimeQuery = await fetch('courseweave/runtime?unexpected=1', { headers });
      const course = await fetch('courseweave/course');
      const courseQuery = await fetch('courseweave/course?unexpected=1');
      const missingXsrf = await fetch('courseweave/context', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CourseWeave-Runtime-ID': runtimeId }, body: '{}' });
      const responseHeaders = (item: Response) => ({ status: item.status, cache: item.headers.get('Cache-Control'), cors: item.headers.get('Access-Control-Allow-Origin') });
      return { runtime: responseHeaders(response), missingRuntime: responseHeaders(missingRuntime), wrongRuntime: responseHeaders(wrongRuntime), runtimeQuery: responseHeaders(runtimeQuery), course: responseHeaders(course), courseQuery: responseHeaders(courseQuery), missingXsrf: responseHeaders(missingXsrf) };
    }, config.courseweaveRuntimeId as string);
    expect(relays.runtime).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.course).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.missingRuntime.status).toBe(403);
    expect(relays.wrongRuntime.status).toBe(403);
    expect(relays.runtimeQuery.status).toBe(400);
    expect(relays.courseQuery.status).toBe(400);
    expect(relays.missingXsrf.status).toBe(403);

    const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(page.locator('iframe[title="CourseWeave guide"]')).toHaveCount(1);
    const guideReferrer = await guide.locator('body').evaluate(() => document.referrer);
    expect(guideReferrer).toMatch(/^https?:\/\/[^/]+\/$/);
    await expect(guide.locator('body')).toContainText('Installed wheel rich course');
    await expect(guide.getByRole('region', { name: 'Course dashboard' })).toContainText('Installed phase');
    await invokePaletteCommand(page, DASHBOARD_COMMAND);
    await expect(page.locator('#courseweave-dashboard')).toContainText('Installed wheel rich course', { timeout: PALETTE_STEP_TIMEOUT_MS });
    await expect.poll(() => publishedContexts.some((body) => body.sequence === 0 && typeof body.source_id === 'string')).toBe(true);
    const invalidationPromise = guide.locator('body').evaluate(() => new Promise<boolean>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data?.type === 'courseweave.context.changed.v1') {
          window.removeEventListener('message', listener);
          resolve(true);
        }
      };
      window.addEventListener('message', listener);
      setTimeout(() => resolve(false), 5_000);
    }));
    const markdownContextResponse = page.waitForResponse((response) => {
      if (response.request().method() !== 'POST' || !response.url().endsWith('/courseweave/context')) return false;
      try { return response.request().postDataJSON().active_path === 'lesson.md'; } catch { return false; }
    });
    await guide.getByRole('button', { name: 'Open markdown' }).click();
    const contextResponse = await markdownContextResponse;
    expect({ status: contextResponse.status(), cache: contextResponse.headers()['cache-control'], cors: contextResponse.headers()['access-control-allow-origin'] ?? null }).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(contextResponse.request().postDataJSON()).toMatchObject({ active_path: 'lesson.md', surface_kind: 'markdown' });
    expect(await invalidationPromise).toBe(true);
    await expect(page.locator('.lm-TabBar-tabLabel', { hasText: 'lesson.md' })).toBeVisible();
    await guide.getByRole('button', { name: 'Open html' }).click();
    const reader = page.locator('iframe[title="CourseWeave reader"]');
    await expect(reader).toHaveAttribute('src', /\/courseweave\/files\/lessons\/reader\.html$/);
    await expect(reader).toHaveAttribute('sandbox', 'allow-same-origin');
    await expect(reader).toHaveAttribute('referrerpolicy', 'same-origin');
    await expect.poll(() => page.frames().some((frame) => /\/courseweave\/files\/lessons\/reader\.html$/.test(frame.url()))).toBe(true);
    const htmlFrame = page.frames().find((frame) => /\/courseweave\/files\/lessons\/reader\.html$/.test(frame.url()));
    await htmlFrame!.evaluate(() => document.body.removeAttribute('data-jupyter-api-token'));
    await expect(htmlFrame!.locator('body')).toContainText('Reader fixture');
    await guide.getByRole('button', { name: 'Open video' }).click();
    await expect(reader).toHaveAttribute('src', 'https://video.example.test/video.mp4');
    await expect(reader).toHaveAttribute('sandbox', '');
    await expect(reader).toHaveAttribute('referrerpolicy', 'no-referrer');
    const video = page.frameLocator('iframe[title="CourseWeave reader"]').locator('video');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((element) => ({ readyState: element.readyState, error: element.error?.code ?? null }))).toMatchObject({ readyState: expect.any(Number), error: null });
    expect(await video.evaluate((element) => element.readyState)).toBeGreaterThanOrEqual(1);
    await guide.getByRole('button', { name: 'Open notebook' }).click({ timeout: 10_000 });
    await expect(page.locator('.jp-Notebook')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open source' }).click({ timeout: 10_000 });
    await expect(page.locator('.jp-CodeMirrorEditor')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open Terminal instructions' }).click({ timeout: 10_000 });
    await expect(page.locator('.jp-Terminal')).toHaveCount(1);
    workspace.trackOwnedProcesses();
    const terminalInstructions = page.locator('[data-courseweave-terminal-instructions]');
    const expectedInstructions = JSON.stringify({ cwd: '.', argv: ['/usr/bin/touch', 'terminal-argv-must-not-run'] }, null, 2);
    await expect(terminalInstructions).toContainText(expectedInstructions);
    const copyInstructions = terminalInstructions.getByRole('button', { name: 'Copy launch instructions' });
    await expect(copyInstructions).toBeVisible();
    await expect(copyInstructions).toBeEnabled();
    await copyInstructions.evaluate((button) => button.click());
    await expect(terminalInstructions.getByRole('status')).toHaveText('Terminal launch instructions copied.');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedInstructions);
    await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
    await page.waitForTimeout(250);
    await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
    expect(pageErrors).toEqual([]);
    const expectedConsoleError = (message: { type: string; text: string; url: string }) => {
      if (message.type !== 'error') return false;
      let parsed: URL | null = null;
      try { parsed = new URL(message.url); } catch { /* not an expected browser error */ }
      const path = parsed?.pathname ?? '';
      const sourceId = parsed?.searchParams.get('source_id') ?? null;
      const matchingContext404s = contextResponses.filter((response) =>
        response.method === 'GET' && response.status === 404 && response.url === parsed?.href
      );
      const firstPublishedContext = contextResponses.find((response) =>
        response.method === 'POST' && response.status === 200 && response.sourceId === sourceId
      );
      const startupContext404 = parsed !== null
        && parsed.origin === config.courseweaveServiceUrl
        && path === '/api/context'
        && [...parsed.searchParams.keys()].join(',') === 'source_id'
        && publishedContexts.some((body) => body.source_id === sourceId)
        && matchingContext404s.length > 0
        && firstPublishedContext !== undefined
        && matchingContext404s.every((missing) => missing.order < firstPublishedContext.order)
        && message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)';
      return ((/status of (400|403)/.test(message.text) && [
        '/courseweave/courseweave/runtime', '/courseweave/courseweave/course',
        '/courseweave/courseweave/context'
      ].includes(path))
        || (/status of 404/.test(message.text) && path.endsWith('/favicon.ico'))
        || startupContext404);
    };
    const unexpectedConsoleErrors = consoleMessages.filter((message) => message.type === 'error' && !expectedConsoleError(message));
    expect(unexpectedConsoleErrors).toEqual([]);
    const credential = await credentialSnapshot(page, config.courseweaveRuntimeId as string);
    workspace.scheduleFinalCredentialAudit({
      ...credential,
      browserOutput: JSON.stringify({ consoleMessages, pageErrors }),
      locations: page.frames().map((frame) => frame.url()),
      artifactRoots: [testInfo.outputDir]
    });
  });
  expect(workspace!.finalAuditResult()).toEqual({ filesScanned: expect.any(Number), retainedCredentials: 0 });
  expect(workspace!.finalAuditResult()!.filesScanned).toBeGreaterThan(0);
  await expect(workspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });
});

test('fresh installed wheel opens Author without materializing an empty course before Save', async ({ browser }, testInfo) => {
  let workspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
  await usingTestResourceCustody(async (custody) => {
  workspace = await custody.acquire(
    () => launchInstalledWorkspace('author', { emptyCourse: true }),
    async (ownedWorkspace) => { await ownedWorkspace.close(); },
    0,
  );
  const context = await custody.acquire(() => browser.newContext(), async (ownedContext) => { await ownedContext.close(); }, 20);
  const page = await custody.acquire(() => context.newPage(), async (ownedPage) => { await ownedPage.close(); }, 10);
  const pageErrors: string[] = [];
  const consoleMessages: Array<{ type: string; text: string; url: string }> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text(), url: message.location().url }));
    await bootstrap(page, await workspace.bootstrapUrl());
    const config = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
    await page.evaluate(() => document.body.removeAttribute('data-jupyter-api-token'));
    expect(config.courseweaveLaunchMode).toBe('author');
    expect(Object.prototype.hasOwnProperty.call(config, 'courseweaveCapabilityToken')).toBe(false);
    const author = page.frameLocator('iframe[title="CourseWeave author"]');
    await expect(page.locator('iframe[title="CourseWeave author"]')).toBeVisible();
    await expect(workspace.courseManifestExists()).resolves.toBe(false);
    await expect(workspace.coursePrivateStateExists()).resolves.toBe(false);
    await author.getByRole('button', { name: 'Save course' }).click();
    await expect(author.getByText('Saved exact canonical course bytes.', { exact: true })).toBeVisible();
    await expect(workspace.courseManifestExists()).resolves.toBe(true);
    await expect(workspace.courseFiles()).resolves.toEqual([
      '.courseweave/courseweave.db', '.courseweave/courseweave.db-shm',
      '.courseweave/courseweave.db-wal', '.courseweave/courseweave.lock',
      'courseweave.json',
    ]);
    const credential = await credentialSnapshot(page, config.courseweaveRuntimeId as string);
    workspace.scheduleFinalCredentialAudit({
      ...credential,
      browserOutput: JSON.stringify({ consoleMessages, pageErrors }),
      locations: page.frames().map((frame) => frame.url()),
      artifactRoots: [testInfo.outputDir]
    });
    assertAuthorBrowserClean(pageErrors, consoleMessages);
  });
  expect(workspace!.finalAuditResult()).toEqual({ filesScanned: expect.any(Number), retainedCredentials: 0 });
  expect(workspace!.finalAuditResult()!.filesScanned).toBeGreaterThan(0);
  await expect(workspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });
});
