import { expect, test } from 'playwright/test';

import { mountLearner, notifyContextChanged } from './learn-helpers';

test('production Learner dashboard keeps manifest order, exposes no-document and active states, and remains usable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const api = { active: false, authenticatedRequests: 0 };
  const learn = await mountLearner(page, api);

  await expect(learn.getByText('No active course document')).toBeVisible();
  await expect(learn.getByRole('heading', { name: 'Second module' })).toBeVisible();
  await expect(learn.getByRole('heading', { name: 'First module' })).toBeVisible();
  const headings = await learn.locator('[aria-label="Course dashboard"] h2, [aria-label="Course dashboard"] h3').allTextContents();
  expect(headings).toEqual(['Second module', 'Second reading', 'First module', 'First reading']);

  const openLesson = learn.getByRole('button', { name: 'Open Second lesson' });
  const openVideo = learn.getByRole('button', { name: 'Open Second video' });
  await openVideo.focus();
  await learn.locator('body').press('Shift+Tab');
  await expect(openLesson).toBeFocused();
  expect(await openLesson.evaluate((button) => getComputedStyle(button).outlineStyle !== 'none')).toBe(true);
  await learn.locator('body').press('Tab');
  await expect(openVideo).toBeFocused();
  await expect(learn.locator('[data-testid="learn-rail"]')).toHaveClass(/cw-reduced-motion/);
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => {
    const style = getComputedStyle(rail);
    return style.transitionDuration === '0s' && style.animationDuration === '0s';
  })).toBe(true);
  expect(await learn.locator('[data-testid="learn-rail"]').evaluate((rail) => rail.scrollWidth <= rail.clientWidth)).toBe(true);

  api.active = true;
  await notifyContextChanged(page);
  await expect(learn.getByText('No active course document')).toHaveCount(0);
  await expect(learn.getByLabel('Current location')).toHaveText(/Second module.*Second reading/);
  await expect(learn.getByRole('region', { name: 'Reading' })).toBeVisible();
  await expect.poll(() => api.authenticatedRequests).toBeGreaterThan(0);

  const navigation = page.evaluate(() => new Promise<unknown>((resolve) => window.addEventListener('courseweave-test-navigation', (event) => resolve((event as CustomEvent).detail), { once: true })));
  await openLesson.click();
  expect(await navigation).toEqual({ type: 'courseweave.open-surface.v1', moduleId: 'module-b', phaseId: 'read-b', surfaceId: 'html-lesson' });
  expect(api.unhandledRequests ?? 0).toBe(0);
});
