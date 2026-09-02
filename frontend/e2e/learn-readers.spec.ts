import { expect, test } from 'playwright/test';

import { course, mountLearner, notifyContextChanged } from './learn-helpers';

test('production Learner renders only the parent-selected sandboxed HTML route and parsed HTTPS video', async ({ page, context }) => {
  await context.route('https://**', (route) => route.abort());
  await page.setViewportSize({ width: 320, height: 900 });
  const api = { active: true, surfaceId: 'html-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);

  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  const htmlReader = learn.locator('iframe[title="Second lesson"]');
  await expect(htmlReader).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(htmlReader).toHaveAttribute('src', /\/content\/html-lesson$/);
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => rail.scrollWidth <= rail.clientWidth)).toBe(true);
  const [htmlBox, htmlRailBox] = await Promise.all([htmlReader.boundingBox(), learn.locator('[data-testid="learn-rail"]').boundingBox()]);
  expect(htmlBox?.width).toBeLessThanOrEqual(htmlRailBox?.width ?? 0);

  await learn.getByRole('button', { name: 'Open Second video' }).click();
  const video = learn.locator('video[title="Second video"]');
  await expect(video).toHaveAttribute('src', 'https://video.example.test/second.mp4');
  await expect(video).toHaveAttribute('controls', '');
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => rail.scrollWidth <= rail.clientWidth)).toBe(true);
  const [videoBox, videoRailBox] = await Promise.all([video.boundingBox(), learn.locator('[data-testid="learn-rail"]').boundingBox()]);
  expect(videoBox?.width).toBeLessThanOrEqual(videoRailBox?.width ?? 0);

  api.surfaceId = 'video-lesson';
  await notifyContextChanged(page);
  await expect(video).toBeVisible();
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner rejects an HTTP video without assigning media or navigating externally', async ({ page, context }) => {
  let externalRequests = 0;
  await context.route('http://video.example.test/**', async (route) => { externalRequests += 1; await route.abort(); });
  const insecureCourse = structuredClone(course) as { modules: Array<{ phases: Array<{ surfaces: Array<{ id: string; url?: string }> }> }> };
  insecureCourse.modules[0]!.phases[0]!.surfaces.find((surface) => surface.id === 'video-lesson')!.url = 'http://video.example.test/second.mp4';
  const api = { active: true, surfaceId: 'video-lesson', course: insecureCourse, authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);

  await learn.getByRole('button', { name: 'Open Second video' }).click();
  await expect(learn.getByLabel('Course reader').getByRole('status')).toContainText('This course surface is unavailable.');
  await expect(learn.locator('video')).toHaveCount(0);
  expect(externalRequests).toBe(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner rejects credential-bearing HTML before iframe assignment or request', async ({ page }) => {
  const api = { active: true, authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);

  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    const source = `${location.protocol}//capability@${location.host}/content/html-lesson`;
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'html-lesson', htmlSource: source }, location.origin);
  });

  await expect(learn.getByLabel('Course reader').getByRole('status')).toContainText('This course surface is unavailable.');
  await expect(learn.locator('iframe[title="Second lesson"]')).toHaveCount(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner rejects a delayed destination outcome after newer context stays on A', async ({ page }) => {
  const api = { active: true, surfaceId: 'html-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);
  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  const htmlReader = learn.locator('iframe[title="Second lesson"]');
  await expect(htmlReader).toBeVisible();

  await page.evaluate(() => { document.documentElement.dataset.deferReaderOutcome = 'true'; });
  await learn.getByRole('button', { name: 'Open Second video' }).click();
  const requestCount = api.authenticatedRequests;
  await notifyContextChanged(page);
  await expect.poll(() => api.authenticatedRequests).toBeGreaterThan(requestCount);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'video-lesson', htmlSource: null }, location.origin);
  });

  await expect(htmlReader).toBeVisible();
  await expect(learn.locator('video[title="Second video"]')).toHaveCount(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner accepts a delayed destination outcome after newer context confirms B', async ({ page }) => {
  const api = { active: true, surfaceId: 'html-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);
  await page.evaluate(() => { document.documentElement.dataset.deferReaderOutcome = 'true'; });
  await learn.getByRole('button', { name: 'Open Second video' }).click();
  api.surfaceId = 'video-lesson';
  const requestCount = api.authenticatedRequests;
  await notifyContextChanged(page);
  await expect.poll(() => api.authenticatedRequests).toBeGreaterThan(requestCount);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'video-lesson', htmlSource: null }, location.origin);
  });

  await expect(learn.locator('video[title="Second video"]')).toBeVisible();
  expect(api.unhandledRequests ?? 0).toBe(0);
});
