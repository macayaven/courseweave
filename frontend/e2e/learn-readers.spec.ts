import { expect, test } from 'playwright/test';

import { course, mountLearner } from './learn-helpers';

test('production Learner renders only the parent-selected sandboxed HTML route and parsed HTTPS video', async ({ page, context }) => {
  await context.route('https://**', (route) => route.abort());
  const learn = await mountLearner(page, { active: true, authenticatedRequests: 0 });

  await learn.getByRole('button', { name: 'Open Second lesson' }).click();
  const htmlReader = learn.locator('iframe[title="Second lesson"]');
  await expect(htmlReader).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(htmlReader).toHaveAttribute('src', /\/content\/html-lesson$/);

  await learn.getByRole('button', { name: 'Open Second video' }).click();
  const video = learn.locator('video[title="Second video"]');
  await expect(video).toHaveAttribute('src', 'https://video.example.test/second.mp4');
  await expect(video).toHaveAttribute('controls', '');
});

test('production Learner rejects an HTTP video without assigning media or navigating externally', async ({ page, context }) => {
  let externalRequests = 0;
  await context.route('http://video.example.test/**', async (route) => { externalRequests += 1; await route.abort(); });
  const insecureCourse = structuredClone(course) as { modules: Array<{ phases: Array<{ surfaces: Array<{ id: string; url?: string }> }> }> };
  insecureCourse.modules[0]!.phases[0]!.surfaces.find((surface) => surface.id === 'video-lesson')!.url = 'http://video.example.test/second.mp4';
  const learn = await mountLearner(page, { active: true, course: insecureCourse, authenticatedRequests: 0 });

  await learn.getByRole('button', { name: 'Open Second video' }).click();
  await expect(learn.getByLabel('Course reader').getByRole('status')).toContainText('This course surface is unavailable.');
  await expect(learn.locator('video')).toHaveCount(0);
  expect(externalRequests).toBe(0);
});
