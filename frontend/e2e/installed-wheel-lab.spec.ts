import { expect, test, type Page } from 'playwright/test';

import { failingBootstrapProxy, launchInstalledWorkspace } from './installed-wheel-helpers';

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

async function credentialSnapshot(page: Page, runtimeId: string) {
  return page.evaluate(async (id) => {
    const pageConfig = JSON.parse(document.querySelector('#jupyter-config-data')?.textContent ?? '{}') as Record<string, unknown>;
    const runtime = await (await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': id } })).json() as { capabilityToken: string };
    return {
      capabilityToken: runtime.capabilityToken,
      pageConfig,
      storage: JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }),
    };
  }, runtimeId);
}

test.describe.configure({ timeout: 300_000, mode: 'serial' });

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

test('fresh installed wheel opens an authenticated Learn workspace without Node in its runtime PATH', async ({ browser, request }, testInfo) => {
  const workspace = await launchInstalledWorkspace('learn');
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: Array<{ text: string; url: string }> = [];
  const publishedContexts: Array<Record<string, unknown>> = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url }); });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/courseweave/context')) {
      try { publishedContexts.push(request.postDataJSON() as Record<string, unknown>); } catch { /* asserted by the missing-XSRF probe */ }
    }
  });
  try {
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
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', /\/courseweave\/files\/lessons\/reader\.html$/);
    await expect.poll(() => page.frames().some((frame) => /\/courseweave\/files\/lessons\/reader\.html$/.test(frame.url()))).toBe(true);
    const htmlFrame = page.frames().find((frame) => /\/courseweave\/files\/lessons\/reader\.html$/.test(frame.url()));
    await htmlFrame!.evaluate(() => document.body.removeAttribute('data-jupyter-api-token'));
    expect((await htmlFrame!.locator('body').innerText()).includes('Reader fixture')).toBe(true);
    await guide.getByRole('button', { name: 'Open video' }).click();
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', 'https://video.example.test/video.mp4');
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
    const expectedConsoleError = (message: { text: string; url: string }) => {
      const path = (() => { try { return new URL(message.url).pathname; } catch { return ''; } })();
      return ((/status of (400|403)/.test(message.text) && message.url.startsWith(baseUrl))
        || (/status of 404/.test(message.text) && (path === '/api/context' || path.endsWith('/favicon.ico')))
        || (/Content Security Policy/.test(message.text) && message.url.startsWith(baseUrl))
        || (/WebSocket connection/.test(message.text) && message.url.startsWith(baseUrl))
        || (/Connection lost, reconnecting/.test(message.text) && message.url.startsWith(baseUrl)));
    };
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !expectedConsoleError(message));
    expect(unexpectedConsoleErrors).toEqual([]);
    const credential = await credentialSnapshot(page, config.courseweaveRuntimeId as string);
    await expect(workspace.auditCredentials({
      ...credential,
      locations: page.frames().map((frame) => frame.url()),
      artifactRoots: [testInfo.outputDir]
    })).resolves.toMatchObject({ retainedCredentials: 0 });
  } finally {
    const cleanup = await Promise.allSettled([context.close(), workspace.close()]);
    if (cleanup[1]?.status === 'rejected') throw cleanup[1].reason;
    await expect(workspace.cleanupState()).resolves.toEqual({ processGroupAlive: false, ownedRootExists: false });
  }
});

test('fresh installed wheel opens Author without materializing an empty course before Save', async ({ browser }, testInfo) => {
  const workspace = await launchInstalledWorkspace('author', { emptyCourse: true });
  const page = await browser.newPage();
  try {
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
    await expect(workspace.auditCredentials({
      ...credential,
      locations: page.frames().map((frame) => frame.url()),
      artifactRoots: [testInfo.outputDir]
    })).resolves.toMatchObject({ retainedCredentials: 0 });
  } finally {
    const cleanup = await Promise.allSettled([page.close(), workspace.close()]);
    if (cleanup[1]?.status === 'rejected') throw cleanup[1].reason;
    await expect(workspace.cleanupState()).resolves.toEqual({ processGroupAlive: false, ownedRootExists: false });
  }
});
