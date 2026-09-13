// Native navigation checks shared by the installed student acceptance journey.
// Only local authored links are clicked; no command or external activity runs.
import {join} from 'node:path';
import {expect} from '../frontend/node_modules/playwright/test.mjs';

const label = surface => surface.label.startsWith('Open ') ? surface.label : `Open ${surface.label}`;

async function storedContext(session) {
  session.navigationSourceId ??= await session.guide.locator('body').evaluate(() => {
    const resource = performance.getEntriesByType('resource').find(entry => entry.name.includes('/api/context?source_id='));
    return resource ? new URL(resource.name).searchParams.get('source_id') : null;
  });
  if (!session.navigationSourceId) throw Error('The installed guide has no confirmed context source.');
  const response = await session.context.request.get(
    `${session.runtime.serviceOrigin}/api/context?source_id=${encodeURIComponent(session.navigationSourceId)}`,
    {headers: {Authorization: `Bearer ${session.runtime.capabilityToken}`}},
  );
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function confirmSurface(session, module, phase, surface) {
  await expect(session.guide.getByLabel('Current location')).toContainText(`${module.title} · ${phase.title}`);
  await expect.poll(async () => {
    const context = await storedContext(session);
    return {
      module: context.resolved.module_id,
      phase: context.resolved.phase_id,
      path: context.context.active_path,
      kind: context.context.surface_kind,
      terminal: context.context.terminal_surface_id,
    };
  }).toEqual({
    module: module.id, phase: phase.id, path: surface.path ?? null,
    kind: surface.type, terminal: surface.type === 'terminal' ? surface.id : null,
  });
  if (surface.type === 'html') {
    const iframe = session.page.locator('iframe[title="CourseWeave reader"]');
    await expect(iframe).toBeVisible();
    await expect.poll(async () => {
      const url = new URL(await iframe.getAttribute('src'));
      return [decodeURIComponent(url.pathname).endsWith(`/${surface.path}`), url.hash];
    }).toEqual([true, surface.fragment ? `#${surface.fragment}` : '']);
    // The iframe src changes before its old document is replaced. Wait for the
    // actual new document and the parent's native-link binding before clicking.
    await expect.poll(() => session.page.frameLocator('iframe[title="CourseWeave reader"]')
      .locator('body').evaluate((_, path) => ({
        loaded: decodeURIComponent(location.pathname).endsWith(`/${path}`),
        bound: [...document.querySelectorAll('a[href]')].every(anchor => anchor.dataset.courseweaveBound === 'true'),
      }), surface.path)).toEqual({loaded: true, bound: true});
  }
}

export async function selectNativeSurface(session, module, phase, surface) {
  const section = phase.progress === 'optional' ? 'Optional activities & references' : 'Course contents';
  await session.guide.getByText(section, {exact: true}).evaluate(node => {node.closest('details').open = true;});
  const moduleSection = session.guide.getByRole('heading', {name: module.title, exact: true})
    .locator('..').filter({has: session.guide.getByRole('heading', {name: phase.title, exact: true})});
  await moduleSection.getByRole('heading', {name: phase.title, exact: true}).locator('..')
    .getByRole('button', {name: label(surface), exact: true}).click();
  await confirmSurface(session, module, phase, surface);
}

export async function verifyContinueNavigation(session, module, phase) {
  const primary = phase.surfaces.find(surface => surface.purpose === 'primary');
  expect(primary).toBeTruthy();
  await session.guide.getByRole('button', {name: `Continue: ${phase.title}`, exact: true}).click();
  await confirmSurface(session, module, phase, primary);
}

export async function verifyReaderLoadGuard(session, manifest, {report}) {
  const first = manifest.modules.find(module => module.id === 's01');
  const next = manifest.modules.find(module => module.id === 's02');
  const firstRead = first.phases.find(phase => phase.id === 'read');
  const nextRead = next.phases.find(phase => phase.id === 'read');
  const firstHtml = firstRead.surfaces.find(surface => surface.type === 'html');
  const nextHtml = nextRead.surfaces.find(surface => surface.type === 'html');
  await selectNativeSurface(session, next, nextRead, nextHtml);
  let unblock, observed;
  const blocked = new Promise(resolve => {unblock = resolve;});
  const requested = new Promise(resolve => {observed = resolve;});
  const pattern = '**/courseweave/reader/lessons/diagrams/S01-agent-loop.svg';
  const handler = async route => {
    observed();
    await blocked;
    await route.continue().catch(() => undefined);
  };
  await session.context.route(pattern, handler);
  try {
    const moduleSection = session.guide.getByRole('heading', {name: first.title, exact: true})
      .locator('..').filter({has: session.guide.getByRole('heading', {name: firstRead.title, exact: true})});
    await moduleSection.getByRole('heading', {name: firstRead.title, exact: true}).locator('..')
      .getByRole('button', {name: label(firstHtml), exact: true}).click();
    let timeout;
    await Promise.race([requested, new Promise((_, reject) => {timeout = setTimeout(() => reject(Error('Diagram delay was not observed.')), 15000);})])
      .finally(() => clearTimeout(timeout));
    await expect.poll(async () => {
      const context = await storedContext(session);
      return [context.resolved.module_id, context.resolved.phase_id, context.context.active_path];
    }).toEqual(['s01', 'read', firstHtml.path]);
    const reader = session.page.frameLocator('iframe[title="CourseWeave reader"]');
    const nextLink = reader.locator('nav.lesson-nav .nav-next a').first();
    await nextLink.scrollIntoViewIfNeeded();
    const point = await nextLink.evaluate(anchor => {
      // A wrapped inline anchor's bounding box can include a gap between lines.
      // Hit an actual rendered line rectangle rather than that box's center.
      const rect = [...anchor.getClientRects()].find(item => item.width > 0 && item.height > 0);
      if (!rect) throw Error('The native Next link has no rendered line rectangle.');
      return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
    });
    const iframe = session.page.locator('iframe[title="CourseWeave reader"]');
    const frameBox = await iframe.boundingBox();
    expect(frameBox).not.toBeNull();
    const border = await iframe.evaluate(node => ({x: node.clientLeft, y: node.clientTop}));
    // Use a real pointer event, not locator.click's automatic inert waiting.
    await session.page.mouse.click(frameBox.x + border.x + point.x, frameBox.y + border.y + point.y);
    await session.page.waitForTimeout(300);
    const earlyDocument = await reader.locator('body').evaluate(() => location.pathname);
    report.reader_load_probe = {early_document_path: earlyDocument, expected_document_path: firstHtml.path, pointer_in_anchor_line_rect: true};
    expect(earlyDocument.endsWith(`/${firstHtml.path}`)).toBe(true);
    const earlyContext = await storedContext(session);
    expect(earlyContext.resolved.module_id).toBe('s01');
    expect(await session.page.locator('iframe[title="CourseWeave reader"]').evaluate(node => node.inert)).toBe(true);
    unblock();
    await confirmSurface(session, first, firstRead, firstHtml);
    await expect.poll(() => session.page.locator('iframe[title="CourseWeave reader"]').evaluate(node => node.inert)).toBe(false);
    await reader.locator('nav.lesson-nav .nav-next a').first().click();
    await confirmSurface(session, next, nextRead, nextHtml);
    report.reader_load_guard = {delayed_real_diagram: true, early_pointer_stayed_on_s01: true, loaded_next_link_updated_s02_context: true};
  } finally {
    unblock();
    await session.context.unroute(pattern, handler);
  }
}

export async function verifyNativeNavigation(session, manifest, {evidence, report}) {
  const surfaces = manifest.modules.flatMap(module => module.phases.flatMap(phase =>
    phase.surfaces.map(surface => ({module, phase, surface})),
  ));
  const documents = surfaces.filter(item => item.surface.type === 'html')
    .filter((item, index, all) => all.findIndex(other => other.surface.path === item.surface.path) === index);
  const coverage = [];
  for (const origin of documents) {
    await selectNativeSurface(session, origin.module, origin.phase, origin.surface);
    const reader = session.page.frameLocator('iframe[title="CourseWeave reader"]');
    const anchors = await reader.locator('a[href]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('href')))]);
    let localClicks = 0;
    for (const href of anchors) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      await selectNativeSurface(session, origin.module, origin.phase, origin.surface);
      const source = new URL(await session.page.locator('iframe[title="CourseWeave reader"]').getAttribute('src'));
      const target = new URL(href, source);
      const path = decodeURIComponent(target.pathname.split('/courseweave/reader/')[1] ?? '');
      const candidates = surfaces.filter(({surface}) => surface.path === path &&
        (surface.type !== 'html' || (surface.fragment ?? '') === target.hash.slice(1)));
      const match = reader.locator(`a[href=${JSON.stringify(href)}]`).first();
      if (candidates.length === 1) {
        await match.click();
        const next = candidates[0];
        await confirmSurface(session, next.module, next.phase, next.surface);
      } else {
        expect(candidates).toHaveLength(0);
        expect(target.pathname).toBe(source.pathname);
        expect(target.hash.length).toBeGreaterThan(1);
        expect(await reader.locator('body').evaluate((_, id) => !!document.getElementById(id), target.hash.slice(1))).toBe(true);
        await match.click();
      }
      localClicks++;
    }
    await selectNativeSurface(session, origin.module, origin.phase, origin.surface);
    if (origin.surface.path.endsWith('/study-plan.html')) {
      const image = reader.locator('img.static-diagram');
      await expect(image).toHaveCount(1);
      expect(await image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
      const region = image.locator('..');
      await image.scrollIntoViewIfNeeded();
      await session.page.screenshot({path: join(evidence, 'study-plan-diagram-start.png')});
      await region.focus();
      for (let i = 0; i < 120 && await region.evaluate(node => node.scrollLeft < node.scrollWidth - node.clientWidth - 2); i++) {
        await region.press('ArrowRight');
      }
      await expect.poll(() => region.evaluate(node => node.scrollWidth - node.clientWidth - node.scrollLeft)).toBeLessThanOrEqual(2);
      await session.page.screenshot({path: join(evidence, 'study-plan-diagram-end.png')});
    }
    coverage.push({path: origin.surface.path, module: origin.module.id, phase: origin.phase.id, local_links_clicked: localClicks});
  }
  expect(coverage).toHaveLength(16);
  report.native_navigation = {documents: coverage, local_links_clicked: coverage.reduce((sum, item) => sum + item.local_links_clicked, 0)};
}
