// Installed-package acceptance for the complete S01-S14 student pilot.
// Run with Node 22 and --experimental-transform-types. Secrets remain in memory.
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '../frontend/node_modules/playwright/test.mjs';
import { OwnedProcessTracker, stopOwnedProcess } from '../frontend/e2e/process-cleanup.ts';
import { inspectInstalledNotebookKernel } from '../frontend/e2e/installed-kernel.ts';
import { startFakeOpenAiProvider } from '../frontend/e2e/fake-openai-provider.ts';
import { scanFiles } from '../frontend/e2e/credential-scan.ts';
import {
    liveProviderConfiguration,
    parseVerifierArgs,
    providerModeArguments,
    resolveVerifierPaths,
    studyHomeForRelease,
    listenOnUnixSocket,
    VERIFIER_HELP,
} from '../frontend/scripts/verify-student-release-cli.mjs';
import { selectNativeSurface, verifyNativeNavigation, verifyReaderLoadGuard } from './student_navigation_checks.mjs';
const args = parseVerifierArgs(process.argv.slice(2));
if (args.help) {
    console.log(VERIFIER_HELP);
    process.exit(0);
}
const { release, evidence, testRoot } = await resolveVerifierPaths(args);
const liveOnly = args.mode === 'live', noLive = !liveOnly;
const liveConfiguration = liveOnly ? liveProviderConfiguration(process.env) : null;
await mkdir(evidence, { recursive: true });
const releaseMetadata = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
const owned = await mkdtemp(join(testRoot, 'courseweave-acceptance-')), osHome = join(owned, 'os-home');
await mkdir(osHome, { recursive: true });
const study = studyHomeForRelease(osHome, releaseMetadata), legacy = join(osHome, 'Library/Application Support/CourseWeave/Student Pilot/legacy.txt'), liveStudy = join(owned, 'live');
await mkdir(resolve(legacy, '..'), { recursive: true });
await writeFile(legacy, 'preserve\n');
const syntheticKey = 'courseweave-local-provider-canary', credentials = [], cleanups = [], guideThreadIds = [];
let browser, activePage, output = '';
const report = {
    at: new Date().toISOString(),
    release: releaseMetadata,
    scope: 'installed S01-S14 acceptance',
    synthetic_provider: 'deterministic local protocol double; not live-provider or learner-completion evidence',
    modules: [],
    live_provider: { skipped: noLive, questions: [] },
};
const fail = e => String(e).replace(/https?:\/\/\S+/g, '[URL omitted]').replace(/[A-Za-z0-9_-]{32,}/g, '[opaque omitted]');
async function freePort() {
    const server = createServer();
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const selected = server.address().port;
    await new Promise(resolveClose => server.close(resolveClose));
    return selected;
}
const openName = s => s.label.startsWith('Open ') ? s.label : `Open ${s.label}`;
const phase = (g, m, p) => g.getByRole('heading', { name: m, exact: true })
    .locator('..')
    .filter({ has: g.getByRole('heading', { name: p, exact: true }) })
    .getByRole('heading', { name: p, exact: true })
    .locator('..');
const expand = (g, text) => g.getByText(text, { exact: true }).evaluate(n => { n.closest('details').open = true; });
async function api(s, path) {
    const r = await s.context.request.get(`${s.runtime.serviceOrigin}${path}`, {
        headers: { Authorization: `Bearer ${s.runtime.capabilityToken}` },
    });
    if (!r.ok())
        throw Error(`API ${path}: ${r.status()}`);
    return r.json();
}
async function launch({ home = study, defaultHome = false, synthetic = false, noProvider = false, providerEnvironment } = {}) {
    const dir = await mkdtemp(join(owned, 'session-')), socket = join(dir, 'b.sock');
    let ok, bad;
    const secret = new Promise((a, b) => { ok = a; bad = b; });
    void secret.catch(() => { });
    const server = createServer(c => { let v = ''; c.on('data', x => v += x); c.on('end', () => ok(v)); });
    await listenOnUnixSocket(server, socket);
    const helper = join(dir, 'browser');
    await writeFile(helper, `#!/usr/bin/env python3\nimport socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(socket)});s.sendall(sys.argv[-1].encode());s.close()\n`, { mode: 0o700 });
    const env = { HOME: osHome, PATH: process.env.PATH, LANG: 'en_US.UTF-8', BROWSER: helper };
    if (synthetic)
        Object.assign(env, { COURSEWEAVE_PROVIDER: 'openai', OPENAI_MODEL: 'stub-model', OPENAI_BASE_URL: fake.baseUrl, OPENAI_API_KEY: syntheticKey, COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS: '30' });
    if (providerEnvironment)
        Object.assign(env, providerEnvironment);
    const launcherArgs = [
        '--port', String(await freePort()),
        ...(defaultHome ? [] : ['--home', home]),
        ...providerModeArguments({ synthetic, noProvider, providerEnvironment }),
    ];
    const child = spawn(join(release, 'Start Course.command'), launcherArgs, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    child.once('exit', () => bad(Error('Launcher exited before handoff.')));
    const tracker = new OwnedProcessTracker(child.pid);
    for (const s of [child.stdout, child.stderr])
        s.on('data', x => output += x);
    let stopped = false;
    const stop = async () => {
        if (stopped)
            return;
        try {
            if (child.exitCode === null && child.signalCode === null)
                await stopOwnedProcess(child, tracker, { failOnForcedTermination: true });
            else if (tracker.live().length)
                throw Error('Owned descendants survived.');
        }
        finally {
            await new Promise(r => server.close(r));
            stopped = true;
        }
    };
    cleanups.push(stop);
    let timer;
    const bootstrap = await Promise.race([secret, new Promise((_, r) => timer = setTimeout(() => r(Error('Bootstrap timeout')), 600000))]).finally(() => clearTimeout(timer));
    const target = new URL(bootstrap);
    credentials.push(target.searchParams.get('token'));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    cleanups.push(() => context.close());
    context.setDefaultTimeout(15000);
    await context.route('https://**/*', r => r.abort());
    const auth = await context.request.get(bootstrap, { maxRedirects: 0 });
    if (!auth.ok() && auth.status() !== 302)
        throw Error('Bootstrap failed.');
    target.search = '';
    target.hash = '';
    const page = await context.newPage();
    activePage = page;
    await page.goto(target.href);
    report.context_trace ??= [];
    report.page_errors ??= [];
    page.on('pageerror', error => report.page_errors.push(fail(error)));
    page.on('request', request => {
        if (request.method() === 'POST' && request.url().endsWith('/api/guide')) {
            try {
                const id = request.postDataJSON().threadId;
                if (typeof id !== 'string' || !id)
                    throw Error('Guide request omitted threadId.');
                guideThreadIds.push(id);
            }
            catch (error) {
                report.page_errors.push(fail(error));
            }
        }
    });
    page.on('response', async (response) => {
        try {
            const url = new URL(response.url());
            if (!url.pathname.endsWith('/api/context') && !url.pathname.endsWith('/courseweave/context'))
                return;
            const body = await response.json();
            const resolved = body.resolved ?? body;
            report.context_trace.push({
                method: response.request().method(),
                route: url.pathname.endsWith('/api/context') ? 'guide-get' : 'parent-post',
                status: response.status(),
                resolved: {
                    module_id: resolved.module_id,
                    phase_id: resolved.phase_id,
                    surface_id: resolved.surface_id,
                },
            });
        }
        catch { }
    });
    const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(guide.getByLabel('Current location')).toBeVisible({ timeout: 120000 });
    const no = page.locator('.jp-toastContainer').getByRole('button', { name: 'No', exact: true });
    if (await no.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false))
        await no.click();
    const runtime = await page.evaluate(async () => {
        const config = JSON.parse(document.querySelector('#jupyter-config-data').textContent);
        const response = await fetch(`${config.baseUrl}courseweave/runtime`, {
            headers: { 'X-CourseWeave-Runtime-ID': config.courseweaveRuntimeId },
        });
        return response.json();
    });
    credentials.push(runtime.capabilityToken);
    tracker.refresh();
    const s = { page, guide, context, runtime, stop, tracker };
    s.state = () => api(s, '/api/state');
    return s;
}
async function openSurface(s, m, p, surface) {
    await selectNativeSurface(s, m, p, surface);
    report.last_navigation = { module: m.id, phase: p.id, surface: surface.id, label: openName(surface) };
}
async function saveReq(g, m, p, r) {
    const dialog = activePage.locator('dialog.jp-Dialog');
    if (await dialog.isVisible().catch(() => false)) {
        report.jupyter_dialogs ??= [];
        const dialogText = (await dialog.innerText()).slice(0, 1000);
        report.jupyter_dialogs.push(dialogText);
        if (dialogText.startsWith('Select Kernel')) {
            await dialog.getByText('Course Python', { exact: true }).click();
            await dialog.getByRole('button', { name: 'Select', exact: true }).click();
        }
        else {
            const decline = dialog.getByRole('button', { name: 'No', exact: true });
            if (!await decline.isVisible().catch(() => false))
                throw Error('Unexpected Jupyter dialog blocked a learner record; see sanitized dialog receipt.');
            await decline.click();
        }
        await expect(dialog).toBeHidden();
    }
    const card = g.locator('.cw-requirement').filter({ hasText: r.prompt });
    const text = `Synthetic installed acceptance for ${m.id}/${r.id}; test evidence, not a learner completion claim.`;
    if (r.record_kind === 'text') {
        await card.getByLabel(r.prompt, { exact: true }).fill(text);
    }
    else if (r.record_kind === 'attestation') {
        const checkbox = card.getByLabel(r.prompt, { exact: true });
        if (!await checkbox.isChecked())
            await checkbox.check();
    }
    else {
        await card.getByLabel('Reference label 1').fill(`Synthetic ${m.id}`);
        await card.getByLabel('Path or HTTPS URL 1').fill(`study/${m.id}-synthetic.txt`);
        await card.getByLabel('Optional note').fill(text);
    }
    await card.getByRole('button', { name: 'Save response', exact: true }).click();
    await expect(card.getByText('Saved response', { exact: true })).toBeVisible();
}
async function native(s, m, p, surface, mr, self = false) {
    await openSurface(s, m, p, surface);
    const iframe = s.page.locator('iframe[title="CourseWeave reader"]'), suffix = surface.fragment ? `#${surface.fragment}` : '';
    await expect(iframe).toHaveAttribute('src', new RegExp(surface.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + suffix + '$'));
    const reader = s.page.frameLocator('iframe[title="CourseWeave reader"]');
    await expect(reader.locator('h1')).toContainText(m.id.toUpperCase());
    const audit = await reader.locator('body').evaluate(() => ({
        images: [...document.querySelectorAll('img.static-diagram')].map(x => ({ src: x.getAttribute('src'), alt: x.getAttribute('alt')?.trim(), width: x.naturalWidth, height: x.naturalHeight })),
        bad: [...document.querySelectorAll('a[href^="#"]')].map(x => x.getAttribute('href')).filter(h => h && h !== '#' && !document.getElementById(decodeURIComponent(h.slice(1)))),
        self: !!document.querySelector('#self-check'), details: document.querySelectorAll('details').length,
    }));
    expect(audit.bad).toEqual([]);
    if (self) {
        expect(audit.self).toBe(true);
        expect(audit.details).toBeGreaterThan(0);
        await reader.locator('#self-check').scrollIntoViewIfNeeded();
        const all = reader.locator('details');
        for (let i = 0; i < await all.count(); i++) {
            const d = all.nth(i);
            await d.locator('summary').click();
            await expect(d).toHaveAttribute('open', '');
            expect((await d.innerText()).trim().length).toBeGreaterThan(0);
        }
        await s.page.screenshot({ path: join(evidence, `${m.id}-native-self-check.png`) });
        mr.native_self_check = { fragment: surface.fragment, details: audit.details };
        return;
    }
    expect(audit.images.length).toBeGreaterThan(0);
    for (let i = 0; i < audit.images.length; i++) {
        const image = audit.images[i], node = reader.locator('img.static-diagram').nth(i), scroll = node.locator('..');
        expect(image.alt.length).toBeGreaterThan(20);
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
        await node.scrollIntoViewIfNeeded();
        await s.page.screenshot({ path: join(evidence, `${m.id}-diagram-${i + 1}-start.png`) });
        const wide = await scroll.evaluate(n => n.scrollWidth > n.clientWidth);
        if (wide) {
            await scroll.focus();
            for (let step = 0; step < 100 && await scroll.evaluate(n => n.scrollLeft < n.scrollWidth - n.clientWidth - 2); step++)
                await scroll.press('ArrowRight');
            await expect.poll(() => scroll.evaluate(n => n.scrollWidth - n.clientWidth - n.scrollLeft)).toBeLessThanOrEqual(2);
            await s.page.screenshot({ path: join(evidence, `${m.id}-diagram-${i + 1}-end.png`) });
        }
    }
    mr.diagrams = audit.images;
}
async function checks(s, m, p, mr) {
    const list = p.learning?.checks ?? [];
    if (!list.length)
        return;
    await s.guide.getByText(new RegExp(`^Self-checks \\(${list.length}\\)$`))
        .evaluate(n => n.parentElement.open = true);
    let options = 0;
    for (const c of list) {
        const card = s.guide.locator('.cw-check').filter({ hasText: c.prompt });
        for (const o of c.options) {
            await card.getByLabel(o.text, { exact: true }).check();
            await card.getByRole('button', { name: /^(Check answer|Try another answer)$/ }).click();
            await expect(card.locator('p[role="status"]').filter({ hasText: o.feedback })).toBeVisible();
            options++;
        }
        await card.getByText('Reference answer', { exact: true }).evaluate(n => n.parentElement.open = true);
        await expect(card).toContainText(c.options.find(o => o.id === c.correct_option_id).text);
    }
    mr.guided_checks = { checks: list.length, options };
}
async function notebook(s, m, p, surface, mr) {
    await openSurface(s, m, p, surface);
    await expect(s.page.locator('.jp-Notebook:visible')).toHaveCount(1, { timeout: 120000 });
    const path = join(study, 'course', surface.path);
    const before = JSON.parse(await readFile(path, 'utf8'));
    const ids = before.cells.map(c => c.id);
    const codeCount = before.cells.filter(c => c.cell_type === 'code').length;
    const marker = `student-release-save-check-${m.id}`;
    const nb = s.page.locator('.jp-Notebook:visible');
    const cell = nb.locator('.jp-CodeCell').first();
    await cell.dblclick();
    const editor = cell.locator('.cm-content');
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await s.page.keyboard.insertText(`# ${marker}`);
    await s.page.getByRole('menuitem', { name: 'Run', exact: true }).click();
    await s.page.getByRole('menuitem', { name: 'Run All Cells', exact: true }).click();
    await expect.poll(async () => {
        const prompts = await nb.locator('.jp-CodeCell .jp-InputPrompt').allTextContents();
        return prompts.filter(x => /^\[\d+\]:$/.test(x.trim())).length;
    }, { timeout: 180000 }).toBe(codeCount);
    await s.page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => readFile(path, 'utf8')).toContain(marker);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const code = saved.cells.filter(c => c.cell_type === 'code');
    expect(saved.cells.map(c => c.id)).toEqual(ids);
    expect(code.every(c => c.execution_count !== null)).toBe(true);
    expect(code.flatMap(c => c.outputs ?? []).filter(o => o.output_type === 'error')).toEqual([]);
    mr.notebook = { path: surface.path, code_cells: code.length, ids_preserved: true };
    return { path, marker };
}
async function optional(s, m, mr) {
    const read = m.phases.find(x => x.id === 'read'), readSurface = read.surfaces.find(x => x.type === 'html');
    await openSurface(s, m, read, readSurface);
    const beforeHint = await s.state(), providerCount = fake.requests.length, hint = s.guide.getByRole('button', { name: 'Next authored hint', exact: true });
    await expect(hint).toBeEnabled();
    await hint.click();
    expect(await s.state()).toEqual(beforeHint);
    expect(fake.requests.length).toBe(providerCount);
    mr.authored_hint = true;
    const covered = [];
    for (const p of m.phases.filter(x => x.progress === 'optional')) {
        for (const x of p.surfaces) {
            await openSurface(s, m, p, x);
            if (x.type === 'video')
                expect(await s.page.locator('iframe[title="CourseWeave reader"]').getAttribute('src')).toBe(x.src);
            if (x.type === 'markdown') {
                await expect(s.page.locator('.jp-RenderedMarkdown:visible')).toBeVisible({ timeout: 30000 });
                if (releaseMetadata.format_version === 2 && x.path === 'labs/s01_loop.md') {
                    const link = s.page.locator('.jp-RenderedMarkdown:visible').getByRole('link', { name: 'labs/README.md', exact: true });
                    const target = new URL(await link.getAttribute('href'), s.page.url());
                    report.reviewed_link_destination = { path: target.pathname, fragment: decodeURIComponent(target.hash) };
                    expect(target.pathname).toMatch(/\/labs\/README\.md$/);
                    expect(decodeURIComponent(target.hash)).toBe('#Wire-contract-(so---replay-matches)');
                    await link.click();
                    await expect.poll(async () => (await s.page.locator('.jp-RenderedMarkdown:visible,.jp-FileEditor:visible').allTextContents()).join('\n')).toContain('Wire contract');
                    const heading = s.page.locator('.jp-RenderedMarkdown:visible').getByRole('heading', { name: 'Wire contract (so --replay matches)', exact: true });
                    const rendered = await heading.isVisible();
                    if (rendered) await expect(heading).toBeInViewport();
                    else await expect(s.page.locator('.jp-FileEditor:visible')).toContainText('Wire contract');
                    mr.reviewed_markdown_link = { source: x.path, target: 'labs/README.md#Wire-contract-%28so---replay-matches%29', clicked: true,
                        opened_as: rendered ? 'rendered Markdown at heading' : 'native Jupyter text editor; heading scrolling not established' };
                    await s.page.screenshot({ path: join(evidence, 's01-reviewed-markdown-link.png') });
                }
            }
            if (x.type === 'source')
                await expect(s.page.locator('.jp-MainAreaWidget:visible .cm-content')).toBeVisible({ timeout: 30000 });
            if (x.type === 'terminal') {
                const instructions = s.page.locator('[data-courseweave-terminal-instructions]').filter({ hasText: x.label });
                await expect(instructions.getByRole('button', { name: 'Copy launch instructions' })).toBeEnabled();
                await expect(instructions.locator('[data-courseweave-terminal-command]')).toHaveText(JSON.stringify({ cwd: x.cwd, command: x.command }, null, 2));
            }
            covered.push({ type: x.type, id: x.id });
        }
        const existing = (await s.state()).records;
        const missingRecords = p.completion.requirements.filter(requirement =>
            requirement.record_kind !== 'attestation' &&
            !existing.some(record =>
                record.coordinate.module_id === m.id &&
                record.coordinate.phase_id === p.id &&
                record.coordinate.requirement_id === requirement.id));
        for (const r of missingRecords)
            await saveReq(s.guide, m, p, r);
    }
    mr.optional_surfaces = covered;
}
async function ask(s, text) {
    const n = fake.requests.length;
    await s.guide.getByLabel('Ask a question').fill(text);
    await s.guide.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => fake.requests.length).toBe(n + 1);
    await expect(s.guide.locator('.cw-transcript article').last()).toHaveAttribute('data-state', 'finished');
    return fake.requests.at(-1);
}
function maintenance(home, ...cmd) {
    const result = spawnSync(join(release, 'Start Course.command'), [...cmd, '--home', home], {
        env: { HOME: osHome, PATH: process.env.PATH, LANG: 'en_US.UTF-8' },
        encoding: 'utf8',
        timeout: 120000,
    });
    if (result.status !== 0)
        throw Error(`Maintenance ${cmd[0]} failed.`);
    return result.stdout;
}
async function runLiveStage() {
    credentials.push(liveConfiguration.credential);
    const live = await launch({ home: liveStudy, providerEnvironment: liveConfiguration.environment }), manifest = JSON.parse(await readFile(join(liveStudy, 'course/courseweave.json'), 'utf8'));
    await expand(live.guide, 'Course contents');
    await expand(live.guide, 'Optional activities & references');
    const before = await live.state();
    const prompts = {
        s03: 'In at most 60 words, what does pinning content change, and what limitation remains? Cite the exact selected lesson label.',
        s11: 'In at most 60 words, how do a pre-dispatch estimate and post-response actual accounting differ when the estimate is too low? Cite the exact selected lesson label.',
        s14: 'In at most 60 words, critique only the selected pilot-page draft’s claim and data-handling clarity for this public synthetic statement: “We keep no data, but retain participant names in traces indefinitely.” Do not rewrite it or claim a pilot ran. Cite the exact selected activity label.',
    };
    let previousScopeLabel = null;
    for (const id of ['s03', 's11', 's14']) {
        const module = manifest.modules.find(x => x.id === id);
        const phaseData = module.phases.find(x => x.id === (id === 's14' ? 'protocol' : 'read'));
        const surface = phaseData.surfaces.find(x => x.purpose === 'primary') ?? phaseData.surfaces[0];
        await openSurface(live, module, phaseData, surface);
        if (surface.type === 'html' || surface.type === 'markdown') {
            await expand(live.guide, 'Lesson & sharing scope');
            await live.guide.getByRole('button', { name: 'Use this lesson' }).click();
            await expect(live.guide.getByText(`Using: ${surface.label}`, { exact: false })).toBeVisible();
            if (previousScopeLabel)
                await expect(live.guide.getByText(`Using: ${previousScopeLabel}`, { exact: false })).toHaveCount(0);
            previousScopeLabel = surface.label;
        }
        if (id === 's14')
            await expect(live.guide.locator('.cw-activity')).toContainText(phaseData.learning.overview);
        await live.guide.getByLabel('Ask a question').fill(prompts[id]);
        const requestPromise = live.page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/guide'));
        await live.guide.getByRole('button', { name: 'Send', exact: true }).click();
        const request = await requestPromise, requestBody = request.postDataJSON(), sourceId = requestBody.forwardedProps?.source_id;
        expect(typeof sourceId).toBe('string');
        expect(sourceId.length).toBeGreaterThan(0);
        const stored = await api(live, `/api/context?source_id=${encodeURIComponent(sourceId)}`);
        expect(stored.resolved).toMatchObject({ module_id: id, phase_id: phaseData.id, surface_id: surface.id });
        expect(stored.context.active_path).toBe(surface.path ?? null);
        await expect(live.guide.locator('.cw-transcript article').last()).toHaveAttribute('data-state', 'finished', { timeout: 150000 });
        const answer = (await live.guide.locator('.cw-transcript article').last().locator('.cw-assistant').innerText()).trim();
        const questionEvidence = {
            module_id: id,
            phase_id: phaseData.id,
            scope_label: surface.label,
            prompt: prompts[id],
            answer,
            request_coordinate: {
                module_id: stored.resolved.module_id,
                phase_id: stored.resolved.phase_id,
                surface_id: stored.resolved.surface_id,
                active_path: stored.context.active_path,
            },
            request_shape: {
                keys: Object.keys(requestBody).sort(),
                context_items: Array.isArray(requestBody.context) ? requestBody.context.length : null,
                forwarded_prop_keys: Object.keys(requestBody.forwardedProps ?? {}).sort(),
                message_roles: Array.isArray(requestBody.messages)
                    ? requestBody.messages.map(message => message.role)
                    : [],
            },
            visible_scope_confirmed: surface.type === 'html' || surface.type === 'markdown',
            typed_public_synthetic_draft: id === 's14',
            workspace_share_used: false,
        };
        report.live_provider.questions.push(questionEvidence);
        expect(answer.length).toBeGreaterThan(0);
        expect(answer).toMatch(new RegExp(id, 'i'));
        if (id === 's11') {
            expect(answer).toMatch(/estimat/i);
            expect(answer).toMatch(/actual|post-response/i);
        }
        if (id === 's14') {
            expect(answer).toMatch(/contradict|conflict|inconsisten/i);
            expect(answer).not.toMatch(/S11/i);
        }
        questionEvidence.quality_checks_passed = true;
    }
    expect(await live.state()).toEqual(before);
    report.live_provider.state_unchanged = true;
    await live.stop();
    await live.context.close();
}
let fake;
try {
    if (!liveOnly) {
        fake = await startFakeOpenAiProvider();
        cleanups.push(() => fake.close());
    }
    browser = await chromium.launch();
    if (liveOnly)
        await runLiveStage();
    else {
        const s = await launch({ defaultHome: true, synthetic: true }), manifest = JSON.parse(await readFile(join(study, 'course/courseweave.json'), 'utf8'));
        expect(manifest.modules).toHaveLength(14);
        await expand(s.guide, 'Course contents');
        await expand(s.guide, 'Optional activities & references');
        const initial = await s.state(), nbs = [];
        let firstQuestion = '', shareMarker = '', s03Label = '';
        for (const m of manifest.modules) {
            const mr = { id: m.id, title: m.title }, read = m.phases.find(p => p.id === 'read'), html = read.surfaces.find(x => x.type === 'html');
            await native(s, m, read, html, mr);
            for (const video of read.surfaces.filter(x => x.type === 'video')) {
                await openSurface(s, m, read, video);
                await expect(s.page.locator('iframe[title="CourseWeave reader"]')).toHaveAttribute('src', video.src);
                mr.video = { id: video.id, src_bound: true };
            }
            await openSurface(s, m, read, html);
            for (const r of read.completion.requirements)
                await saveReq(s.guide, m, read, r);
            await expand(s.guide, 'Lesson & sharing scope');
            if (m.id === 's04') {
                await expect(s.guide.getByText(`Using: ${s03Label}`, { exact: false })).toBeVisible();
                const q = await ask(s, 'Synthetic S04 activity with retained S03 lesson scope.');
                const body = JSON.stringify(q.body);
                expect(body).toContain(s03Label);
                expect(body).toContain('s04');
                expect(body).toContain('read');
                mr.retained_scope_from_s03 = true;
            }
            await s.guide.getByRole('button', { name: 'Use this lesson', exact: true }).click();
            await expect(s.guide.getByText(`Using: ${html.label}`, { exact: false })).toBeVisible();
            const question = `Synthetic installed acceptance question for ${m.id}: identify the current lesson scope.`;
            if (!firstQuestion)
                firstQuestion = question;
            const request = await ask(s, question);
            expect(JSON.stringify(request.body)).toContain(html.label);
            if (m.id === 's03')
                s03Label = html.label;
            mr.synthetic_scope = true;
            const np = m.phases.find(p => p.id === 'notebook');
            if (np) {
                const ns = np.surfaces.find(x => x.type === 'notebook');
                await openSurface(s, m, np, ns);
                const blocked = `Synthetic pre-prediction gate probe for ${m.id}.`;
                await s.guide.getByLabel('Ask a question').fill(blocked);
                await expect(s.guide.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
                await saveReq(s.guide, m, np, np.completion.requirements[0]);
                const predictionState = await s.state();
                expect(predictionState.progress.phases.find(x => x.module_id === m.id && x.phase_id === 'notebook').complete).toBe(false);
                await expect(s.guide.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
                await s.guide.getByLabel('Ask a question').fill('');
                for (const r of np.completion.requirements.slice(1))
                    await saveReq(s.guide, m, np, r);
                const saved = await notebook(s, m, np, ns, mr);
                nbs.push(saved);
                mr.prediction_gate = true;
                if (m.id === 's01') {
                    shareMarker = saved.marker;
                    const n = fake.requests.length;
                    await s.page.locator('.jp-Notebook:visible .jp-CodeCell').first().click();
                    await s.guide.getByLabel('Ask a question').fill('Synthetic one-answer share boundary check.');
                    await s.guide.getByRole('button', { name: 'Share before asking' }).click();
                    await s.guide.getByLabel('Share kind').selectOption('cell');
                    await s.guide.getByRole('button', { name: 'Share and ask' }).click();
                    await expect.poll(() => fake.requests.length).toBe(n + 1);
                    expect(JSON.stringify(fake.requests.at(-1).body)).toContain(shareMarker);
                    mr.share_once = true;
                }
                else if (m.id === 's02') {
                    const q = await ask(s, 'Synthetic follow-up after one-answer share.');
                    expect(JSON.stringify(q.body)).not.toContain(shareMarker);
                    mr.share_not_repeated = true;
                }
            }
            const review = m.phases.find(p => p.id === 'self-check' || p.id === 'review'), self = review?.surfaces.find(x => x.type === 'html');
            if (self) {
                await native(s, m, review, self, mr, true);
                await checks(s, m, review, mr);
                if (review.progress === 'required') {
                    const checkState = await s.state();
                    expect(checkState.progress.phases.find(x => x.module_id === m.id && x.phase_id === review.id).complete).toBe(false);
                }
                for (const r of review.completion.requirements.filter(x => x.record_kind === 'text'))
                    await saveReq(s.guide, m, review, r);
            }
            await optional(s, m, mr);
            report.modules.push(mr);
            await s.page.screenshot({ path: join(evidence, `${m.id}-installed.png`) });
        }
        await verifyReaderLoadGuard(s, manifest, { report });
        await verifyNativeNavigation(s, manifest, { evidence, report });
        const threadCount = new Set(guideThreadIds).size;
        expect(threadCount).toBe(1);
        report.continuous_thread = { transcript_articles: await s.guide.locator('.cw-transcript article').count(), provider_requests: fake.requests.length, distinct_thread_ids: threadCount };
        report.synthetic_provider_requests = fake.requests.length;
        const kernel = await inspectInstalledNotebookKernel(s.page, 'notebooks/s12_judge_calibration_toy.ipynb');
        expect(kernel.secret_presence).toEqual({ OPENAI_API_KEY: false, ANTHROPIC_API_KEY: false, BRAVE_SEARCH_API_KEY: false, AGENT_KB_LITELLM_KEY: false, COURSEWEAVE_CAPABILITY_TOKEN: false, JUPYTER_TOKEN: false });
        expect(kernel.executable).toContain('/kernel/bin/python');
        report.kernel = kernel;
        for (const [mi, pi] of [['s13', 'audit'], ['s14', 'acceptance'], ['s14', 'pilot']]) {
            const m = manifest.modules.find(x => x.id === mi), p = m.phases.find(x => x.id === pi);
            await openSurface(s, m, p, p.surfaces[0]);
            const n = fake.requests.length;
            await s.guide.getByLabel('Ask a question').fill('Synthetic observer-only policy probe.');
            await expect(s.guide.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
            await expect(s.guide.getByRole('button', { name: 'Share before asking' })).toHaveCount(0);
            expect(fake.requests.length).toBe(n);
        }
        report.observer_only = { phases: ['s13/audit', 's14/acceptance', 's14/pilot'], send_disabled: true, share_absent: true, provider_calls: 0 };
        for (const id of ['s13', 's14']) {
            const m = manifest.modules.find(x => x.id === id), p = m.phases.find(x => x.id === 'review'), r = p.completion.requirements.find(x => x.record_kind === 'attestation');
            await openSurface(s, m, p, p.surfaces[0]);
            const card = s.guide.locator('.cw-requirement').filter({ hasText: r.prompt });
            await card.getByRole('button', { name: 'Save response' }).click();
            await expect(s.guide.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
            await card.getByLabel(r.prompt, { exact: true }).check();
            await card.getByRole('button', { name: 'Save response' }).click();
            await expect(s.guide.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
        }
        report.review_attestation_gates = { s13: [false, true], s14: [false, true] };
        const complete = await s.state();
        expect(complete.progress.required_complete).toBe(36);
        expect(complete.progress.required_total).toBe(36);
        report.required_progress = { complete: 36, total: 36 };
        const records = complete.records;
        await s.stop();
        await s.context.close();
        const restart = await launch({ noProvider: true });
        expect((await restart.state()).records).toEqual(records);
        for (const x of nbs)
            expect(await readFile(x.path, 'utf8')).toContain(x.marker);
        await restart.stop();
        await restart.context.close();
        report.restart_preserved = true;
        expect(JSON.parse(maintenance(study, 'inspect')).records).toEqual(records);
        const exported = join(owned, 'records.json');
        maintenance(study, 'export', '--output', exported);
        expect(JSON.parse(await readFile(exported, 'utf8')).records).toEqual(records);
        maintenance(study, 'reset', '--confirm');
        const clear = JSON.parse(maintenance(study, 'inspect'));
        expect(clear.records).toEqual([]);
        expect(clear.attempts).toEqual([]);
        for (const x of nbs)
            expect(await readFile(x.path, 'utf8')).toContain(x.marker);
        expect(await readFile(legacy, 'utf8')).toBe('preserve\n');
        expect(initial.progress.required_complete).toBe(0);
        report.restart_export_reset = { notebooks_preserved: nbs.length, legacy_default_preserved: true };
    }
    const unexpectedPageErrors = report.page_errors.filter(message => message !== 'Error: No active debugger session');
    expect(unexpectedPageErrors).toEqual([]);
    report.page_errors = { known_no_active_debugger_session: report.page_errors.length };
    report.status = 'passed';
}
catch (e) {
    report.status = 'failed';
    report.failure = fail(e);
}
finally {
    const failures = [];
    for (const c of cleanups.reverse())
        try {
            await c();
        }
        catch {
            failures.push('cleanup failed');
        }
    if (browser)
        await browser.close();
    report.cleanup_failures = failures;
    report.credentials_in_output = credentials.filter(Boolean).some(x => output.includes(x)) || output.includes(syntheticKey);
    if (failures.length || report.credentials_in_output)
        report.status = 'failed';
    if (report.status !== 'passed')
        report.launcher_diagnostics = output.split('\n').filter(x => x.startsWith('CourseWeave')).map(x => x.replace(/https?:\/\/\S+/g, '[URL omitted]'));
    if (failures.length)
        report.test_home_preserved = owned;
    const path = join(evidence, 'student-acceptance.json');
    let encoded = JSON.stringify(report, null, 2);
    if ([...credentials, syntheticKey].filter(Boolean).some(x => encoded.includes(x)))
        throw Error('Refusing credential-bearing evidence.');
    await writeFile(path, encoded + '\n');
    try {
        report.credential_scan = { owned_files: await scanFiles(owned, [...credentials, syntheticKey]), evidence_files: await scanFiles(evidence, [...credentials, syntheticKey]) };
    }
    catch (e) {
        report.status = 'failed';
        report.failure ??= fail(e);
    }
    encoded = JSON.stringify(report, null, 2);
    await writeFile(path, encoded + '\n');
    await scanFiles(evidence, [...credentials, syntheticKey]);
    if (!failures.length)
        await rm(owned, { recursive: true, force: true });
    console.log(JSON.stringify({ status: report.status, failure: report.failure, modules: report.modules.length, required_progress: report.required_progress, cleanup_failures: failures }));
    if (report.status !== 'passed')
        process.exitCode = 1;
}
