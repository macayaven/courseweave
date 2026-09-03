import { expect, test } from 'playwright/test';

import { course, mountLearner, notifyContextChanged } from './learn-helpers';

test('production Learner accepts only parent-confirmed HTML and HTTPS video outcomes without duplicating the main-area reader', async ({ page, context }) => {
  await context.route('https://**', (route) => route.abort());
  await page.setViewportSize({ width: 320, height: 900 });
  const api = { active: true, surfaceId: 'html-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);

  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  await expect(learn.getByLabel('Course reader').getByRole('status')).toHaveText('Opened Second lesson in the CourseWeave main-area reader.');
  await expect(learn.locator('iframe[title="Second lesson"]')).toHaveCount(0);
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => rail.scrollWidth <= rail.clientWidth)).toBe(true);

  await learn.getByRole('button', { name: 'Open Second video' }).click();
  await expect(learn.getByLabel('Course reader').getByRole('status')).toHaveText('Opened Second video in the CourseWeave main-area reader.');
  await expect(learn.locator('video[title="Second video"]')).toHaveCount(0);
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => rail.scrollWidth <= rail.clientWidth)).toBe(true);

  api.surfaceId = 'video-lesson';
  await notifyContextChanged(page);
  await expect(learn.getByLabel('Course reader').getByRole('status')).toHaveText('Opened Second video in the CourseWeave main-area reader.');
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
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'html-lesson', jupyterBaseUrl: `${location.origin}/`, htmlSource: source }, location.origin);
  });

  await expect(learn.getByLabel('Course reader').getByRole('status')).toContainText('This course surface is unavailable.');
  await expect(learn.locator('iframe[title="Second lesson"]')).toHaveCount(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner rejects a delayed destination outcome after newer context stays on A', async ({ page }) => {
  const api = { active: true, surfaceId: 'html-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);
  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  const readerStatus = learn.getByLabel('Course reader').getByRole('status');
  await expect(readerStatus).toHaveText('Opened Second lesson in the CourseWeave main-area reader.');

  await page.evaluate(() => { document.documentElement.dataset.deferReaderOutcome = 'true'; });
  await learn.getByRole('button', { name: 'Open Second video' }).click();
  const requestCount = api.authenticatedRequests;
  await notifyContextChanged(page);
  await expect.poll(() => api.authenticatedRequests).toBeGreaterThan(requestCount);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'video-lesson', jupyterBaseUrl: `${location.origin}/`, htmlSource: null }, location.origin);
  });

  await expect(readerStatus).toHaveText('Opened Second lesson in the CourseWeave main-area reader.');
  await expect(learn.locator('video[title="Second video"]')).toHaveCount(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});

test('production Learner accepts a delayed HTML destination outcome only after newer context confirms B', async ({ page }) => {
  const api = { active: true, surfaceId: 'video-lesson', authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);
  await page.evaluate(() => { document.documentElement.dataset.deferReaderOutcome = 'true'; });
  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  api.surfaceId = 'html-lesson';
  const requestCount = api.authenticatedRequests;
  await notifyContextChanged(page);
  await expect.poll(() => api.authenticatedRequests).toBeGreaterThan(requestCount);

  await expect(learn.locator('iframe[title="Second lesson"]')).toHaveCount(0);
  await expect(learn.getByLabel('Course reader').getByRole('status')).toContainText('This course surface is unavailable.');

  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'html-lesson', jupyterBaseUrl: `${location.origin}/`, htmlSource: `${location.origin}/files/lessons/second.html` }, location.origin);
  });

  await expect(learn.getByLabel('Course reader').getByRole('status')).toHaveText('Opened Second lesson in the CourseWeave main-area reader.');
  await expect(learn.locator('iframe[title="Second lesson"]')).toHaveCount(0);
  expect(api.unhandledRequests ?? 0).toBe(0);
});
