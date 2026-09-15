// Fresh installed Author journey. Real-provider mode is explicit; secrets stay in memory.
// Node 22+ with --experimental-transform-types; source dependencies provide Playwright.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '../frontend/node_modules/playwright/test.mjs';
import { OwnedProcessTracker, stopOwnedProcess } from '../frontend/e2e/process-cleanup.ts';
import { scanFiles } from '../frontend/e2e/credential-scan.ts';
import { parseVerifierArgs, resolveVerifierPaths, listenOnUnixSocket, liveProviderConfiguration } from '../frontend/scripts/verify-student-release-cli.mjs';

const args = parseVerifierArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node --experimental-transform-types scripts/verify_author_release.mjs RELEASE EVIDENCE --test-root SHORT_LOCAL_ROOT [--no-live|--live-only]\nDefault: fresh installed manual Author journey. --live-only explicitly uses configured model and optional BRAVE_SEARCH_API_KEY; absent/failed live gates remain open.');
  process.exit(0);
}
const { release, evidence, testRoot } = await resolveVerifierPaths(args);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const live = args.mode === 'live';
const provider = live ? liveProviderConfiguration(process.env) : null;
const brave = live ? process.env.BRAVE_SEARCH_API_KEY : undefined;
await mkdir(evidence, { recursive: true });
const owned = await mkdtemp(join(testRoot, 'courseweave-acceptance-'));
const home = join(owned, 'Author home');
const material = join(owned, 'instructor-material');
const hash = value => createHash('sha256').update(value).digest('hex');
const metadata = JSON.parse(await readFile(join(release, 'release.json'), 'utf8'));
const secrets = [provider?.credential, brave, 'synthetic-unselected-author-model', 'synthetic-unselected-author-search'].filter(Boolean);
const sanitize = error => {
  let value = String(error?.message ?? error).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 3500);
  for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
  return value.replace(/https?:\/\/\S+/g, '[URL omitted]');
};
const report = { status: 'running', category: live ? 'fresh installed UI with real text-only provider' : 'fresh installed manual/provider-off UI',
  release: metadata, test_home: home, checks: [], roles: [], open_gates: [], student_previews: [] };
const trackers = [], sessions = [];
let browser, current, output = '', stage = 'release verification';
for (const item of Object.values(metadata.files)) expect(hash(await readFile(join(release, item.path)))).toBe(item.sha256);

async function launch() {
  const dir = await mkdtemp(join(owned, 'session-')), socket = join(dir, 'b.sock');
  let received, rejected;
  const bootstrap = new Promise((ok, bad) => { received = ok; rejected = bad; });
  void bootstrap.catch(() => {});
  const openings = [];
  const server = createServer(connection => {
    let value = ''; connection.on('data', data => value += data);
    connection.on('end', () => { openings.push(value); received(value); });
  });
  await listenOnUnixSocket(server, socket);
  const helper = join(dir, 'browser');
  await writeFile(helper, `#!/usr/bin/env python3\nimport socket,sys\ns=socket.socket(socket.AF_UNIX);s.connect(${JSON.stringify(socket)});s.sendall(sys.argv[-1].encode());s.close()\n`, { mode: 0o700 });
  const probe = createServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok));
  const port = probe.address().port; await new Promise(ok => probe.close(ok));
  const environment = Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'UV_CACHE_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(environment, { BROWSER: helper, OPENAI_API_KEY: 'synthetic-unselected-author-model', BRAVE_SEARCH_API_KEY: 'synthetic-unselected-author-search' });
  if (provider) Object.assign(environment, provider.environment);
  if (brave) environment.BRAVE_SEARCH_API_KEY = brave;
  const child = spawn(join(release, 'Start Author.command'), ['--home', home, '--port', String(port),
    ...(provider ? ['--provider-env'] : ['--no-provider']), ...(brave ? ['--search-key-env'] : [])],
    { cwd: owned, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tracker = new OwnedProcessTracker(child.pid); trackers.push(tracker);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output = (output + data).slice(-512_000));
  child.once('exit', () => rejected(new Error('Author launcher exited before browser handoff.')));
  let context, stopped = false;
  async function stop() {
    if (stopped) return;
    if (context) await context.close();
    if (child.exitCode === null && child.signalCode === null) await stopOwnedProcess(child, tracker, { failOnForcedTermination: true });
    expect(tracker.live()).toEqual([]);
    await new Promise(ok => server.close(ok));
    await rm(dir, { recursive: true }); stopped = true;
  }
  sessions.push(stop);
  let timer;
  const raw = await Promise.race([bootstrap, new Promise((_, bad) => timer = setTimeout(() => bad(new Error('Author browser handoff timed out.')), 240_000))]).finally(() => clearTimeout(timer));
  openings.shift();
  const target = new URL(raw); secrets.push(target.searchParams.get('token'));
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  context.setDefaultTimeout(20_000);
  const response = await context.request.get(raw, { maxRedirects: 0 });
  expect([200, 302]).toContain(response.status()); target.search = ''; target.hash = '';
  const page = await context.newPage(); await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  await page.getByTitle('Hide notification', { exact: true }).click({ timeout: 1000 }).catch(() => {});
  const author = page.frameLocator('iframe[title="CourseWeave author"]');
  await expect(author.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.locator('.jp-toastContainer').getByRole('button', { name: 'No', exact: true }).click({ timeout: 2500 }).catch(() => {});
  tracker.refresh(); report.owned_processes = trackers.flatMap(t => t.snapshot()); await saveReceipt();
  async function nextOpenedPage() {
    await expect.poll(() => openings.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const url = new URL(openings.shift()); secrets.push(url.searchParams.get('token'));
    const auth = await context.request.get(url.href, { maxRedirects: 0 });
    expect([200, 302]).toContain(auth.status()); url.search = ''; url.hash = '';
    const opened = await context.newPage(); await opened.goto(url.href, { waitUntil: 'domcontentloaded' });
    await opened.getByRole('button', { name: 'Hide notification', exact: true }).click({ timeout: 1000 }).catch(() => {});
    return opened;
  }
  async function restartStudent(bundle, study) {
    const portProbe = createServer(); await new Promise(ok => portProbe.listen(0, '127.0.0.1', ok));
    const studentPort = portProbe.address().port; await new Promise(ok => portProbe.close(ok));
    const env = Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'UV_CACHE_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.BROWSER = helper;
    const studentChild = spawn(join(bundle, 'Start Course.command'), ['--home', study, '--port', String(studentPort), '--no-provider'],
      { cwd: owned, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tracked = new OwnedProcessTracker(studentChild.pid); trackers.push(tracked);
    for (const stream of [studentChild.stdout, studentChild.stderr]) stream.on('data', data => output = (output + data).slice(-512_000));
    let closed = false;
    const stopStudent = async () => {
      if (closed) return;
      if (studentChild.exitCode === null && studentChild.signalCode === null) await stopOwnedProcess(studentChild, tracked, { failOnForcedTermination: true });
      expect(tracked.live()).toEqual([]); closed = true;
    };
    sessions.push(stopStudent);
    const opened = await nextOpenedPage(); tracked.refresh();
    return { page: opened, stop: stopStudent };
  }
  return { page, author, context, tracker, stop, nextOpenedPage, restartStudent };
}

async function saveReceipt() {
  const encoded = JSON.stringify(report, null, 2) + '\n';
  if (secrets.some(value => value && encoded.includes(value))) throw new Error('Receipt contains a protected value and was not written.');
  await writeFile(join(evidence, 'receipt.json'), encoded);
}

try {
  await cp(join(repo, 'tests/fixtures/author-preview-course'), material, { recursive: true });
  await rm(join(material, 'media'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(material, 'courseweave.json'), 'utf8'));
  manifest.id = 'python-data-validation'; manifest.title = 'Python data validation';
  manifest.description = 'Predict field-rule outcomes, test them in Python, and distinguish conformance from factual truth.';
  manifest.modules[0].phases[0].surfaces = manifest.modules[0].phases[0].surfaces.filter(item => item.type !== 'video');
  await writeFile(join(material, 'courseweave.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(material, 'README.md'), '# Python data validation\n\nPredict, run, inspect and explain required-field and value-type checks. The second module is optional independent practice with fictional records.\n');
  const lessonPath = join(material, 'lessons/validate.md');
  const correctLesson = await readFile(lessonPath, 'utf8');
  await writeFile(lessonPath, correctLesson.replace('application schema', 'aplication schema'));
  const reference = join(owned, 'instructor.md');
  await writeFile(reference, 'In this course, a prediction comes before notebook execution. JSON parsing and application validation are different steps. Validation checks declared required fields and value types; it does not establish factual truth. Optional independent practice is unaided.\n');
  browser = await chromium.launch(); current = await launch();
  let { page, author } = current;
  stage = 'import private course through UI';
  const projects = author.getByRole('region', { name: 'Projects', exact: true });
  await projects.getByRole('radio', { name: 'Import selected files', exact: true }).check();
  await projects.getByRole('textbox', { name: 'Project ID', exact: true }).fill('validation-course');
  await projects.getByRole('textbox', { name: 'Source directory', exact: true }).fill(material);
  await projects.getByRole('button', { name: 'Inspect source', exact: true }).click();
  await projects.getByRole('button', { name: 'Select all listed files', exact: true }).click();
  await projects.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(author.getByRole('combobox', { name: 'Open project', exact: true })).toHaveValue('validation-course');
  const project = join(home, 'workspace/projects/validation-course');
  const research = author.getByRole('region', { name: 'Research and references', exact: true });
  const library = author.getByRole('region', { name: 'Sources', exact: true });
  // These are deliberately selected files from the versioned, redistributable
  // evaluation course. Approval and student distribution are separate UI actions.
  await expect(library.locator('.source-card')).toHaveCount(10);
  const importedTitles = await library.locator('.source-card h3').allTextContents();
  for (const title of importedTitles) {
    const imported = library.locator('.source-card').filter({ has: author.getByRole('heading', { name: title, exact: true }) });
    await imported.getByRole('combobox', { name: 'Review status for ' + title, exact: true }).selectOption('approved');
    await imported.getByRole('combobox', { name: 'Intended use for ' + title, exact: true }).selectOption('student_material');
    await imported.getByRole('combobox', { name: 'Redistribution for ' + title, exact: true }).selectOption('include');
    await imported.getByRole('textbox', { name: 'Review note for ' + title, exact: true }).fill('Selected authored evaluation course material, inspected for this test. Retain its license and permit inclusion in this Student handoff.');
    await imported.getByRole('button', { name: 'Save decision for ' + title, exact: true }).click();
    await expect(imported.getByRole('combobox', { name: 'Review status for ' + title, exact: true })).toHaveValue('approved');
  }
  await expect(research.getByRole('checkbox', { name: 'Enable network for this research run', exact: true })).not.toBeChecked();
  await research.getByRole('textbox', { name: 'Local reference file', exact: true }).fill(reference);
  await research.getByRole('button', { name: 'Import reference file', exact: true }).click();
  const card = library.locator('.source-card').filter({ has: author.getByRole('heading', { name: 'instructor.md', exact: true }) });
  await card.getByRole('button', { name: 'Read extracted text for instructor.md', exact: true }).click();
  await expect(card.locator('pre')).toHaveText(await readFile(reference, 'utf8'));
  await card.getByRole('combobox', { name: 'Review status for instructor.md', exact: true }).selectOption('approved');
  await card.getByRole('textbox', { name: 'Review note for instructor.md', exact: true }).fill('Inspected locally authored evaluation reference. Permitted Author use; redistribution stays undecided.');
  await card.getByRole('button', { name: 'Save decision for instructor.md', exact: true }).click();
  await expect(card.getByRole('combobox', { name: 'Review status for instructor.md', exact: true })).toHaveValue('approved');
  report.checks.push('Fresh installed Start Author; UI import into private project; explicit local reference/excerpt inspection and approval; network default off.');
  if (live) {
    const { verifyAuthorRoles } = await import('./author_role_checks.mjs');
    await verifyAuthorRoles({ page, author, research, report, evidence, secrets, brave: Boolean(brave), correctLesson, project });
  } else report.open_gates.push('Real provider roles and Brave discovery/fetch are separate explicit live checks.');
  stage = 'reviewed lesson edit';
  const editor = author.getByRole('region', { name: 'Lesson files', exact: true });
  await editor.getByRole('textbox', { name: 'File path', exact: true }).fill('lessons/validate.md');
  await editor.getByRole('button', { name: 'Open file', exact: true }).click();
  const currentText = await editor.getByRole('textbox', { name: 'Markdown source', exact: true }).inputValue();
  if (currentText !== correctLesson) {
    expect(currentText).toBe(correctLesson.replace('application schema', 'aplication schema'));
    await editor.getByRole('textbox', { name: 'Markdown source', exact: true }).fill(correctLesson);
    await editor.getByRole('button', { name: 'Review file edit', exact: true }).click();
    await expect(editor.locator('pre')).toContainText('aplication schema');
    await editor.getByRole('checkbox', { name: 'I reviewed this exact diff', exact: true }).check();
    await editor.getByRole('button', { name: 'Apply reviewed change', exact: true }).click();
    await expect(editor.getByText('Reviewed file applied and saved project reloaded.', { exact: true })).toBeVisible();
  }
  expect(await readFile(join(project, 'course/lessons/validate.md'), 'utf8')).toBe(correctLesson);
  expect(await readFile(lessonPath, 'utf8')).toBe(correctLesson.replace('application schema', 'aplication schema'));
  await editor.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, 'reviewed-edit.png') });
  stage = 'export and generic paired bundles';
  const delivery = author.getByRole('region', { name: 'Course delivery', exact: true });
  await delivery.getByRole('button', { name: 'Inspect handoff files', exact: true }).click();
  await delivery.getByRole('textbox', { name: 'Course version', exact: true }).fill('1.0.0');
  await delivery.getByRole('textbox', { name: 'New course archive (.tar)', exact: true }).fill(join(owned, 'course.tar'));
  const [exported] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/author/exports') && r.request().method() === 'POST'),
    delivery.getByRole('button', { name: 'Export reviewed course', exact: true }).click(),
  ]);
  expect(exported.status()).toBe(201); report.export = await exported.json();
  report.bundles = [];
  for (const version of ['0.2.0', '0.3.0']) {
    await delivery.getByRole('combobox', { name: 'Student bundle version', exact: true }).selectOption(version);
    await delivery.getByRole('textbox', { name: 'New Student bundle folder', exact: true }).fill(join(owned, 'Student ' + version));
    const [built] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/author/student-bundles') && r.request().method() === 'POST'),
      delivery.getByRole('button', { name: 'Build Student bundle for python-data-validation 1.0.0', exact: true }).click(),
    ]);
    expect(built.status()).toBe(201); report.bundles.push(await built.json());
  }
  await delivery.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, 'paired-bundles.png') });
  stage = 'actual paired Student previews';
  const { verifyAuthorStudentPreviews } = await import('./author_preview_checks.mjs');
  await verifyAuthorStudentPreviews({ session: current, report, evidence, project });
  stage = 'source revocation and context recovery';
  const assistant = author.getByRole('region', { name: 'Author assistant', exact: true });
  await assistant.getByRole('checkbox', { name: 'Permit instructor.md', exact: true }).check();
  await assistant.getByRole('checkbox', { name: 'Permit README.md', exact: true }).check();
  const contextPreview = assistant.locator('[aria-label="Context preview"]');
  const permittedCount = async () => Number((await contextPreview.innerText()).match(/(\d+) permitted source\(s\)/)[1]);
  await expect(assistant.getByRole('textbox', { name: 'Message to Author assistant', exact: true })).toBeEnabled();
  await assistant.getByRole('textbox', { name: 'Message to Author assistant', exact: true }).fill('Unsent source-revocation recovery check.');
  await expect(assistant.getByRole('button', { name: 'Request review', exact: true })).toBeEnabled();
  const beforePermissionCount = await permittedCount();
  let recoveryRequests = 0;
  const countRecoveryRequest = request => { if (request.method() === 'POST' && request.url().endsWith('/api/author/guide')) recoveryRequests++; };
  page.on('request', countRecoveryRequest);
  await card.getByRole('combobox', { name: 'Review status for instructor.md', exact: true }).selectOption('rejected');
  await card.getByRole('button', { name: 'Save decision for instructor.md', exact: true }).click();
  await expect(assistant.getByRole('checkbox', { name: 'Permit instructor.md', exact: true })).toHaveCount(0);
  await expect.poll(permittedCount).toBe(beforePermissionCount - 1);
  await expect(assistant.getByRole('button', { name: 'Request review', exact: true })).toBeEnabled();
  await expect(assistant.getByRole('checkbox', { name: 'Permit README.md', exact: true })).toBeChecked();
  await card.getByRole('combobox', { name: 'Review status for instructor.md', exact: true }).selectOption('approved');
  await card.getByRole('button', { name: 'Save decision for instructor.md', exact: true }).click();
  await expect(assistant.getByRole('checkbox', { name: 'Permit instructor.md', exact: true })).not.toBeChecked();
  await expect(assistant.getByRole('textbox', { name: 'Message to Author assistant', exact: true })).toHaveValue('Unsent source-revocation recovery check.');
  expect(recoveryRequests).toBe(0); page.off('request', countRecoveryRequest);
  report.source_revocation = { removed_hidden_permission: true, other_permission_retained: true, reapproval_does_not_restore_permission: true, guide_requests: recoveryRequests };
  await assistant.getByRole('button', { name: 'Request review', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'source-revocation-recovered.png') });
  stage = 'backup restore';
  await author.getByRole('button', { name: 'Select course Python data validation', exact: true }).click();
  await expect(author.getByRole('textbox', { name: 'Course title', exact: true })).toBeEnabled();
  const backup = author.getByRole('region', { name: 'Project backup and recovery', exact: true });
  await backup.getByText('Backup and recovery', { exact: true }).click();
  await backup.getByRole('checkbox', { name: 'Saved review reports', exact: true }).check();
  await backup.getByRole('checkbox', { name: 'Saved research reports', exact: true }).check();
  await backup.getByRole('button', { name: 'Inspect backup selection', exact: true }).click();
  await backup.getByRole('textbox', { name: 'New backup file', exact: true }).fill(join(owned, 'author-backup.tar'));
  await backup.getByRole('button', { name: 'Create reviewed backup', exact: true }).click();
  await expect(backup.getByText('Backup saved: ' + join(owned, 'author-backup.tar'), { exact: true })).toBeVisible();
  await backup.getByRole('button', { name: 'Inspect restore archive', exact: true }).click();
  await backup.getByRole('textbox', { name: 'Restored project ID', exact: true }).fill('restored-validation');
  // Hold the actual restore request briefly to expose the user-edit race window.
  // The installed server still performs and validates the real archive restore.
  let releaseRestore, restoreRequested = false;
  const restoreHold = new Promise(ok => { releaseRestore = ok; });
  const restoreRoute = '**/api/author/projects/restore';
  await page.route(restoreRoute, async route => {
    restoreRequested = true;
    await restoreHold;
    await route.continue();
  });
  try {
    await backup.getByRole('button', { name: 'Restore as new project', exact: true }).click();
    await expect.poll(() => restoreRequested).toBe(true);
    await expect(author.getByLabel('Course title', { exact: true })).toBeDisabled();
    await expect(author.getByLabel('Local reference file', { exact: true })).toBeDisabled();
    await expect(author.getByRole('button', { name: 'Add module', exact: true, includeHidden: true })).toBeDisabled();
    await expect(author.getByLabel('Open project', { exact: true })).toBeDisabled();
    report.restore_interaction = { actual_request_delayed: true, editor_disabled: true, research_disabled: true, project_switch_disabled: true };
    await backup.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, 'restore-editing-locked.png') });
  } finally {
    releaseRestore();
    await page.unroute(restoreRoute);
  }
  await expect(author.getByRole('combobox', { name: 'Open project', exact: true })).toHaveValue('restored-validation');
  await expect(author.getByRole('textbox', { name: 'Course title', exact: true })).toBeEnabled();
  await expect(author.getByRole('textbox', { name: 'Course title', exact: true })).toHaveValue('Python data validation');
  report.restore_interaction.editor_enabled_after_restore = true;
  expect(await readFile(join(home, 'workspace/projects/restored-validation/course/lessons/validate.md'), 'utf8')).toBe(correctLesson);
  report.checks.push('Exact one-spelling-change review/apply; original instructor material preserved; standard course export; both generic Student bundles; explicit inspected backup/new-project restore.');
  stage = 'actual restart';
  await current.stop(); current = await launch(); ({ page, author } = current);
  await author.getByRole('combobox', { name: 'Open project', exact: true }).selectOption('validation-course');
  await expect(author.getByRole('region', { name: 'Author assistant', exact: true }).getByRole('list', { name: 'Author conversation', exact: true }).locator('li')).toHaveCount(0);
  expect(await readFile(join(project, 'course/lessons/validate.md'), 'utf8')).toBe(correctLesson);
  for (const preview of report.student_previews) {
    expect(hash(await readFile(join(preview.home, 'course/notebooks/practice.ipynb')))).toBe(preview.saved_notebook_sha256);
    const saved = JSON.parse(await readFile(join(project, 'author-state/previews', preview.preview_id + '.json'), 'utf8'));
    expect(saved.files).toBe('kept'); expect(saved.observations.notes).toBe(preview.observation);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await author.getByRole('region', { name: 'Projects', exact: true }).scrollIntoViewIfNeeded();
  expect(await author.locator('body').evaluate(el => el.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: join(evidence, 'restart-narrow.png') });
  report.checks.push('Actual launcher/Jupyter restart preserves course and restored project; conversation is empty; 390px page fits.');
  report.status = report.open_gates.length ? 'performed-checks-passed-open-gates' : 'passed-awaiting-visual-review';
} catch (error) {
  report.status = 'failed'; report.failed_stage = stage; report.failure = sanitize(error);
  if (current) await current.page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
} finally {
  report.cleanup_failures = [];
  for (const stop of sessions.reverse()) try { await stop(); } catch (error) { report.cleanup_failures.push(sanitize(error)); }
  if (browser) await browser.close();
  report.live_owned_processes = trackers.flatMap(t => t.live());
  report.owned_processes = trackers.flatMap(t => t.snapshot());
  if (report.cleanup_failures.length || report.live_owned_processes.length) report.status = 'failed';
  if (secrets.some(secret => secret && output.includes(secret))) { report.status = 'failed'; report.failure = 'A protected value appeared in owned process output.'; }
  try { report.scanned_files = await scanFiles(owned, secrets); }
  catch (error) { report.status = 'failed'; report.failure = sanitize(error); }
  await saveReceipt();
  console.log(JSON.stringify({ status: report.status, stage, failure: report.failure, checks: report.checks.length, open_gates: report.open_gates, live_owned_processes: report.live_owned_processes.length }));
  if (report.status === 'failed') process.exitCode = 1;
}
