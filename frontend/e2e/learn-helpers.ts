import { expect, type FrameLocator, type Page } from 'playwright/test';

export const capabilities = {
  chat: false,
  hint_level: 'none',
  share_selection: false,
  share_cell: false,
  share_output: false,
  create_profile_proposal: false,
  create_course_proposal: false,
  create_workspace_proposal: false
} as const;

export const course = {
  title: 'Browser Course',
  modules: [
    { id: 'module-b', title: 'Second module', phases: [{ id: 'read-b', title: 'Second reading', kind: 'read', completion: { type: 'manual' }, capabilities, surfaces: [{ id: 'html-lesson', type: 'html', role: 'primary', path: 'lessons/second.html', label: 'Second lesson' }, { id: 'video-lesson', type: 'video', role: 'reference', url: 'https://video.example.test/second.mp4', label: 'Second video' }] }] },
    { id: 'module-a', title: 'First module', phases: [{ id: 'read-a', title: 'First reading', kind: 'read', completion: { type: 'manual' }, capabilities, surfaces: [] }] }
  ]
} as const;

export type MockApi = { active: boolean; surfaceId?: string | null; course?: unknown; proposals?: unknown; authenticatedRequests: number; unhandledRequests?: number };
const serviceOrigin = 'http://127.0.0.1:4173';
const expectedAuthorization = 'Bearer browser-test-capability';

export async function mountLearner(page: Page, api: MockApi): Promise<FrameLocator> {
  await page.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === serviceOrigin && (url.pathname === '/learn/' || url.pathname.startsWith('/learn/assets/'))) return route.continue();
    api.unhandledRequests = (api.unhandledRequests ?? 0) + 1;
    return route.abort();
  });
  await page.route('**/api/**', async (route) => {
    const authorization = route.request().headers().authorization;
    const url = new URL(route.request().url());
    if (url.origin !== serviceOrigin || authorization !== expectedAuthorization) throw new Error('Unexpected authenticated request.');
    api.authenticatedRequests += 1;
    const body = route.request().method() === 'GET' && url.pathname === '/api/course' && url.search === '' ? api.course ?? course
      : route.request().method() === 'GET' && url.pathname === '/api/state' && url.search === '' ? { revision: 1, time_budget_minutes: 25 }
        : route.request().method() === 'GET' && url.pathname === '/api/proposals' && url.search === '' ? api.proposals ?? []
          : route.request().method() === 'GET' && url.pathname === '/api/context' && url.search === '?source_id=browser-source' ? { context: { source_id: 'browser-source' }, resolved: api.active ? { module_id: 'module-b', phase_id: 'read-b', surface_id: api.surfaceId ?? 'html-lesson', reason: 'test' } : { module_id: null, phase_id: null, surface_id: null, reason: 'none' } }
            : null;
    if (body === null) throw new Error('Unexpected API contract.');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(`${serviceOrigin}/content/html-lesson`, (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Lesson</h1>' }));
  await page.route('https://video.example.test/second.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: '' }));
  await page.goto('/learn/');
  await page.evaluate(() => {
    document.body.replaceChildren();
    const frame = document.createElement('iframe');
    frame.id = 'learn-frame';
    frame.title = 'CourseWeave Learn host';
    frame.style.width = '320px';
    frame.style.height = '800px';
    frame.src = '/learn/';
    window.addEventListener('message', (event) => {
      const data = event.data as Record<string, unknown>;
      if (data?.type === 'courseweave.runtime.request.v1' && event.source !== window) {
        document.documentElement.dataset.courseweaveRuntimeRequested = 'true';
        return;
      }
      if (data?.type !== 'courseweave.open-surface.v1' || event.source === window) return;
      window.dispatchEvent(new CustomEvent('courseweave-test-navigation', { detail: data }));
      if (document.documentElement.dataset.deferReaderOutcome === 'true') return;
      const htmlSource = data.surfaceId === 'html-lesson' ? `${window.location.origin}/content/html-lesson` : null;
      (event.source as Window).postMessage({ type: 'courseweave.reader.opened.v1', sourceId: 'browser-source', moduleId: data.moduleId, phaseId: data.phaseId, surfaceId: data.surfaceId, htmlSource }, window.location.origin);
    });
    document.body.append(frame);
  });
  await expect.poll(async () => page.evaluate(() => document.querySelector('#learn-frame')?.contentWindow !== null)).toBe(true);
  await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.courseweaveRuntimeRequested === 'true')).toBe(true);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.runtime.v1', serviceOrigin: window.location.origin, capabilityToken: 'browser-test-capability', sourceId: 'browser-source' }, window.location.origin);
  });
  const learn = page.frameLocator('#learn-frame');
  await expect(learn.locator('[data-testid="learn-rail"]')).toBeVisible();
  return learn;
}

export async function notifyContextChanged(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('#learn-frame');
    frame?.contentWindow?.postMessage({ type: 'courseweave.context.changed.v1', sourceId: 'browser-source' }, window.location.origin);
  });
}
