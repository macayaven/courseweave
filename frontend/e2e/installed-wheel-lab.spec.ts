import { expect, test } from 'playwright/test';

import { launchInstalledWorkspace } from './installed-wheel-helpers';

test.describe.configure({ timeout: 180_000, mode: 'serial' });

test('fresh installed wheel opens an authenticated Learn workspace without Node in its runtime PATH', async ({ browser }) => {
  const workspace = await launchInstalledWorkspace('learn');
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const bootstrapUrl = await workspace.bootstrapUrl();
    const baseUrl = new URL('.', bootstrapUrl).href;
    const unauthenticated = await context.request.get(`${baseUrl}lab`, { maxRedirects: 0 });
    expect([302, 403]).toContain(unauthenticated.status());

    await page.goto(bootstrapUrl, { waitUntil: 'domcontentloaded' });
    expect(page.url()).not.toContain('token=');
    const config = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
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

    const relays = await page.evaluate(async (runtimeId) => {
      const headers = { 'X-CourseWeave-Runtime-ID': runtimeId };
      const response = await fetch('courseweave/runtime', { headers });
      const missingRuntime = await fetch('courseweave/runtime');
      const runtimeQuery = await fetch('courseweave/runtime?unexpected=1', { headers });
      const course = await fetch('courseweave/course');
      const courseQuery = await fetch('courseweave/course?unexpected=1');
      const xsrf = document.cookie.match(/(?:^|; )_xsrf=([^;]+)/)?.[1] ?? '';
      const context = await fetch('courseweave/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': decodeURIComponent(xsrf) },
        body: JSON.stringify({ source_id: 'installed-wheel-proof', sequence: 1, active_path: null, active_cell_id: null, active_cell_tags: [], surface_kind: 'markdown', explicit_module_id: 'module', explicit_phase_id: 'phase', video_seconds: null, terminal_surface_id: null }),
      });
      const responseHeaders = (item: Response) => ({ status: item.status, cache: item.headers.get('Cache-Control'), cors: item.headers.get('Access-Control-Allow-Origin') });
      return { runtime: responseHeaders(response), missingRuntime: responseHeaders(missingRuntime), runtimeQuery: responseHeaders(runtimeQuery), course: responseHeaders(course), courseQuery: responseHeaders(courseQuery), context: responseHeaders(context) };
    }, config.courseweaveRuntimeId as string);
    expect(relays.runtime).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.course).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.context).toEqual({ status: 200, cache: 'no-store', cors: null });
    expect(relays.missingRuntime.status).toBe(403);
    expect(relays.runtimeQuery.status).toBe(400);
    expect(relays.courseQuery.status).toBe(400);

    const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(page.locator('iframe[title="CourseWeave guide"]')).toHaveCount(1);
    const guideReferrer = await guide.locator('body').evaluate(() => document.referrer);
    expect(guideReferrer).toMatch(/^https?:\/\/[^/]+\/$/);
    await expect(guide.locator('body')).toContainText('Installed wheel rich course');
    await guide.getByRole('button', { name: 'Open markdown' }).click();
    await expect(page.locator('.lm-TabBar-tabLabel', { hasText: 'lesson.md' })).toBeVisible();
    await guide.getByRole('button', { name: 'Open html' }).click();
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', /\/courseweave\/files\/lessons\/reader\.html$/);
    await guide.getByRole('button', { name: 'Open video' }).click();
    await expect(page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', 'https://video.example.test/video.mp4');
    await guide.getByRole('button', { name: 'Open notebook' }).click();
    await expect(page.locator('.jp-Notebook')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open source' }).click();
    await expect(page.locator('.jp-CodeMirrorEditor')).toHaveCount(1);
    await guide.getByRole('button', { name: 'Open Terminal instructions' }).click();
    await expect(page.locator('.jp-Terminal')).toHaveCount(1);
    await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
    await workspace.close();
  }
});

test('fresh installed wheel opens Author without materializing an empty course before Save', async ({ browser }) => {
  const workspace = await launchInstalledWorkspace('author', { emptyCourse: true });
  const page = await browser.newPage();
  try {
    await page.goto(await workspace.bootstrapUrl(), { waitUntil: 'domcontentloaded' });
    const author = page.frameLocator('iframe[title="CourseWeave author"]');
    await expect(page.locator('iframe[title="CourseWeave author"]')).toBeVisible();
    await expect(workspace.courseManifestExists()).resolves.toBe(false);
    await expect(workspace.coursePrivateStateExists()).resolves.toBe(false);
    await author.getByRole('button', { name: 'Save course' }).click();
    await expect(author.getByText('Saved exact canonical course bytes.', { exact: true })).toBeVisible();
    await expect(workspace.courseManifestExists()).resolves.toBe(true);
  } finally {
    await page.close();
    await workspace.close();
  }
});
