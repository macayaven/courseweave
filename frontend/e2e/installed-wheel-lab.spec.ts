import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { expect, test, type Page } from 'playwright/test';

import { installedWheelTestOnly, launchInstalledWorkspace } from './installed-wheel-helpers';

async function bootstrap(page: Page, tokenlessUrl: string): Promise<void> {
  try {
    await page.goto(tokenlessUrl, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new Error('Installed-wheel bootstrap navigation failed.');
  }
}

test.describe.configure({ timeout: 180_000, mode: 'serial' });

test('owned cleanup handles setup, bootstrap, and navigation faults before rethrowing them', async () => {
  for (const stage of ['setup', 'bootstrap', 'navigation']) {
    const owned = await mkdtemp(`${tmpdir()}/courseweave-installed-wheel-fault-`);
    const events: string[] = [];
    const closer = (name: string) => ({ close: async () => { events.push(name); } });
    const failure = new Error(`${stage} fault`);
    await expect(installedWheelTestOnly.cleanupAfterFailure(
      { child: null, handoff: closer('handoff'), bootstrapProxy: closer('proxy'), owned },
      failure,
      undefined,
      async (path) => { events.push('remove'); await rm(path, { recursive: true, force: true }); },
    )).rejects.toThrow(`${stage} fault`);
    expect(events).toEqual(['handoff', 'proxy', 'remove']);
    await expect(access(owned)).rejects.toThrow();
  }
});

test('owned cleanup reports a stop fault after closing helpers and preserves its recovery directory', async () => {
  const owned = await mkdtemp(`${tmpdir()}/courseweave-installed-wheel-stop-fault-`);
  const events: string[] = [];
  const closer = (name: string) => ({ close: async () => { events.push(name); } });
  try {
    await expect(installedWheelTestOnly.cleanupAfterFailure(
      { child: {} as never, handoff: closer('handoff'), bootstrapProxy: closer('proxy'), owned },
      new Error('navigation fault'),
      async () => { events.push('stop'); throw new Error('stop fault'); },
      async () => { events.push('remove'); await rm(owned, { recursive: true, force: true }); },
    )).rejects.toThrow('Owned CourseWeave supervisor cleanup failed.');
    expect(events).toEqual(['stop', 'handoff', 'proxy']);
    await expect(access(owned)).resolves.toBeUndefined();
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
});

test('owned detached process-group cleanup waits for its supervisor and descendants to disappear', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => child.once('spawn', resolve).once('error', reject));
  const groupId = child.pid!;
  const groupAlive = () => {
    const inspection = spawnSync('/bin/kill', ['-0', `-${groupId}`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    return inspection.status === 0;
  };
  try {
    await installedWheelTestOnly.stop(child);
    await expect.poll(groupAlive, { timeout: 1_000 }).toBe(false);
  } finally {
    if (groupAlive()) {
      spawnSync('/bin/kill', ['-KILL', `-${groupId}`], { stdio: 'ignore' });
    }
  }
});

test('owned workspace cleanup still runs after browser cleanup fails and reports both failures', async () => {
  const events: string[] = [];
  await expect(installedWheelTestOnly.closeBrowserAndWorkspace(
    async () => { events.push('browser'); throw new Error('browser fault'); },
    async () => { events.push('workspace'); throw new Error('workspace fault'); },
  )).rejects.toThrow('Browser and owned workspace cleanup failed.');
  expect(events).toEqual(['browser', 'workspace']);
});

test('fresh installed wheel opens an authenticated Learn workspace without Node in its runtime PATH', async ({ browser, request }) => {
  const workspace = await launchInstalledWorkspace('learn');
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: Array<{ text: string; url: string }> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); });
  try {
    const bootstrapUrl = await workspace.bootstrapUrl();
    const baseUrl = await workspace.jupyterBaseUrl();
    const unauthenticated = await context.request.get(`${baseUrl}lab`, { maxRedirects: 0 });
    expect([302, 403, 404]).toContain(unauthenticated.status());

    await bootstrap(page, bootstrapUrl);
    expect(page.url()).not.toContain('token=');
    const config = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
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
    expect(config).not.toHaveProperty('courseweaveCapabilityToken');
    const credentialProbe = await page.evaluate(async (runtimeId) => {
      const pageConfig = JSON.parse(document.querySelector('#jupyter-config-data')?.textContent ?? '{}') as Record<string, unknown>;
      const runtime = await (await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': runtimeId } })).json() as { capabilityToken: string };
      const capabilityToken = runtime.capabilityToken;
      const jupyterToken = String(pageConfig.token ?? '');
      const storage = JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      });
      return {
        capabilityToken,
        capabilityInPageConfig: JSON.stringify(pageConfig).includes(capabilityToken),
        capabilityInLocation: location.href.includes(capabilityToken),
        capabilityInStorage: storage.includes(capabilityToken),
        jupyterTokenInLocation: jupyterToken !== '' && location.href.includes(jupyterToken),
        jupyterTokenInStorage: jupyterToken !== '' && storage.includes(jupyterToken),
      };
    }, config.courseweaveRuntimeId as string);
    const { capabilityToken, ...credentialExposure } = credentialProbe;
    expect(credentialExposure).toEqual({
      capabilityInPageConfig: false,
      capabilityInLocation: false,
      capabilityInStorage: false,
      jupyterTokenInLocation: false,
      jupyterTokenInStorage: false,
    });
    await expect(workspace.assertCredentialsAbsent(capabilityToken)).resolves.toMatchObject({ credentialHits: 0 });
    const unauthenticatedCourse = await request.get(`${baseUrl}courseweave/course`, { headers: { 'X-CourseWeave-Runtime-ID': config.courseweaveRuntimeId as string } });
    expect([401, 403, 404]).toContain(unauthenticatedCourse.status());

    const relays = await page.evaluate(async (runtimeId) => {
      const headers = { 'X-CourseWeave-Runtime-ID': runtimeId };
      const response = await fetch('courseweave/runtime', { headers });
      const missingRuntime = await fetch('courseweave/runtime');
      const wrongRuntime = await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': 'wrong-runtime' } });
      const runtimeQuery = await fetch('courseweave/runtime?unexpected=1', { headers });
      const course = await fetch('courseweave/course');
      const courseQuery = await fetch('courseweave/course?unexpected=1');
      const xsrf = document.cookie.match(/(?:^|; )_xsrf=([^;]+)/)?.[1] ?? '';
      const context = await fetch('courseweave/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': decodeURIComponent(xsrf) },
        body: JSON.stringify({ source_id: 'installed-wheel-proof', sequence: 1, active_path: null, active_cell_id: null, active_cell_tags: [], surface_kind: 'markdown', explicit_module_id: 'module', explicit_phase_id: 'phase', video_seconds: null, terminal_surface_id: null }),
      });
      const missingXsrf = await fetch('courseweave/context', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CourseWeave-Runtime-ID': runtimeId }, body: '{}' });
      const responseHeaders = (item: Response) => ({ status: item.status, cache: item.headers.get('Cache-Control'), cors: item.headers.get('Access-Control-Allow-Origin') });
      return { runtime: responseHeaders(response), missingRuntime: responseHeaders(missingRuntime), wrongRuntime: responseHeaders(wrongRuntime), runtimeQuery: responseHeaders(runtimeQuery), course: responseHeaders(course), courseQuery: responseHeaders(courseQuery), context: responseHeaders(context), missingXsrf: responseHeaders(missingXsrf) };
    }, config.courseweaveRuntimeId as string);
    expect(relays.runtime).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.course).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.context).toEqual({ status: 200, cache: 'no-store', cors: null });
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
    await page.getByRole('menuitem', { name: 'View' }).click({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: 'Activate Command Palette' }).click({ timeout: 10_000 });
    const commandPalette = page.locator('.jp-CommandPalette input').first();
    await commandPalette.fill('Open CourseWeave Dashboard');
    await page.getByRole('menuitem', { name: 'Open CourseWeave Dashboard' }).click();
    await expect(page.locator('.jp-Widget#courseweave-dashboard')).toContainText('Installed wheel rich course');
    const contextRequestPromise = page.waitForRequest((request) => request.url().endsWith('/courseweave/context') && request.method() === 'POST', { timeout: 10_000 });
    await guide.locator('body').evaluate(() => {
      (window as Window & { courseweaveInvalidated?: boolean }).courseweaveInvalidated = false;
      window.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'courseweave.context.changed.v1') {
          (window as Window & { courseweaveInvalidated?: boolean }).courseweaveInvalidated = true;
        }
      }, { once: true });
    });
    await page.locator('.jp-Widget#courseweave-dashboard').getByRole('button', { name: 'Open markdown' }).click();
    const contextRequest = await contextRequestPromise;
    expect(contextRequest.postDataJSON()).toMatchObject({ active_path: 'lesson.md', surface_kind: 'markdown' });
    await expect.poll(() => guide.locator('body').evaluate(() => (window as Window & { courseweaveInvalidated?: boolean }).courseweaveInvalidated)).toBe(true);
    await guide.getByRole('button', { name: 'Open markdown' }).click();
    await expect(page.locator('.lm-TabBar-tabLabel', { hasText: 'lesson.md' })).toBeVisible();
    await guide.getByRole('button', { name: 'Open html' }).click();
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', /\/courseweave\/files\/lessons\/reader\.html$/);
    const htmlFixture = await page.locator('iframe[title="CourseWeave reader"]').evaluate(async (frame) => {
      const response = await fetch((frame as HTMLIFrameElement).src);
      return { status: response.status, text: await response.text() };
    });
    expect(htmlFixture).toEqual({ status: 200, text: expect.stringContaining('Reader fixture') });
    await guide.getByRole('button', { name: 'Open video' }).click();
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', 'https://video.example.test/video.mp4');
    await guide.getByRole('button', { name: 'Open notebook' }).click();
    await expect(page.locator('.jp-Notebook')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open source' }).click();
    await expect(page.locator('.jp-CodeMirrorEditor')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open Terminal instructions' }).click();
    await expect(page.locator('.jp-Terminal')).toHaveCount(1);
    const terminalInstructions = page.locator('[data-courseweave-terminal-instructions]');
    await expect(terminalInstructions).toContainText(JSON.stringify({ cwd: '.', argv: ['/usr/bin/touch', 'terminal-argv-must-not-run'] }, null, 2));
    await terminalInstructions.getByRole('button', { name: 'Copy launch instructions' }).click();
    await expect(terminalInstructions.getByRole('status')).toHaveText('Terminal launch instructions copied.');
    await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
    await page.waitForTimeout(250);
    await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
    expect(pageErrors).toEqual([]);
    const expectedConsoleErrors = (message: { text: string; url: string }) => {
      return ((message.text === 'Failed to load resource: the server responded with a status of 400 (Bad Request)' ||
        message.text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') && message.url.startsWith(baseUrl)) ||
       (message.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)' && message.url.endsWith('/favicon.ico')) ||
       (message.text.startsWith("Framing 'http://127.0.0.1:") && message.text.endsWith("/' violates the following Content Security Policy directive: \"frame-ancestors 'self'\". The request has been blocked.") && message.url.startsWith(baseUrl)) ||
       (message.text.startsWith("WebSocket connection to 'ws://127.0.0.1:") && message.text.endsWith("/courseweave/terminals/websocket/courseweave-module-phase-terminal' failed: Error during WebSocket handshake: Unexpected response code: 404") && message.url.startsWith(baseUrl)) ||
       (message.text === 'Connection lost, reconnecting in 0 seconds.' && message.url.startsWith(baseUrl)) ||
       (message.text === 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED' && message.url === 'https://video.example.test/video.mp4');
    };
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !expectedConsoleErrors(message));
    expect(unexpectedConsoleErrors).toEqual([]);
  } finally {
    await installedWheelTestOnly.closeBrowserAndWorkspace(
      () => context.close(),
      () => workspace.close(),
    );
  }
});

test('fresh installed wheel opens Author without materializing an empty course before Save', async ({ browser }) => {
  const workspace = await launchInstalledWorkspace('author', { emptyCourse: true });
  const page = await browser.newPage();
  try {
    await bootstrap(page, await workspace.bootstrapUrl());
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
  } finally {
    await installedWheelTestOnly.closeBrowserAndWorkspace(
      () => page.close(),
      () => workspace.close(),
    );
  }
});
