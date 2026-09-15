// Actual installed Student practice for the newly authored two-module course.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from '../frontend/node_modules/playwright/test.mjs';
import { inspectInstalledNotebookKernel } from '../frontend/e2e/installed-kernel.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = () => Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'UV_CACHE_DIR']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));

function maintenance(bundle, home, ...args) {
  const result = spawnSync(join(bundle, 'Start Course.command'), [...args, '--home', home],
    { env: environment(), encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error('Preview Student maintenance failed: ' + args[0]);
  return result.stdout;
}

export async function verifyAuthorStudentPreviews({ session, report, evidence, project }) {
  const { page, author } = session;
  const panel = author.getByRole('region', { name: 'Student practice preview', exact: true });
  const sourceNotebook = await readFile(join(project, 'course/notebooks/practice.ipynb'));
  const sourceIds = JSON.parse(sourceNotebook).cells.map(cell => cell.id);
  for (const version of ['0.2.0', '0.3.0']) {
    await panel.getByRole('button', { name: 'Reload preview inputs', exact: true }).click();
    await panel.getByRole('combobox', { name: 'Preview Student version', exact: true }).selectOption(version);
    await expect(panel.getByLabel('Use Author’s configured model in this preview')).not.toBeChecked();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/author/previews')),
      panel.getByRole('button', { name: 'Prepare Student preview', exact: true }).click(),
    ]);
    expect(response.status()).toBe(202);
    const started = await response.json();
    const item = { student_version: version, preview_id: started.preview_id, home: started.home,
      package_sha256: started.package_sha256, provider_mode: started.provider_mode, status: 'running' };
    report.student_previews.push(item);
    expect(started.provider_mode).toBe('off');
    expect(started.package_sha256).toBe(report.export.package_sha256);
    const card = panel.getByRole('article').filter({ has: author.getByRole('heading', { name: `Student v${version} · running`, exact: true }) });
    await expect(card.getByRole('button', { name: 'Open Student preview', exact: true })).toBeVisible({ timeout: 240_000 });
    await card.getByRole('button', { name: 'Open Student preview', exact: true }).focus();
    await page.keyboard.press('Enter');
    const student = await session.nextOpenedPage();
    let guideRequests = 0;
    student.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/guide')) guideRequests++; });
    const guide = student.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(guide.locator('body')).toContainText('Python data validation');
    await student.getByRole('tab', { name: /^File Browser/ }).click();
    await guide.getByText('Course contents', { exact: true }).click();
    const navigation = guide.locator('.cw-navigation details');
    await navigation.getByRole('button', { name: 'Open Validation lesson', exact: true }).click();
    await expect(student.locator('.jp-RenderedMarkdown:visible')).toContainText('application schema');
    await navigation.getByRole('button', { name: 'Open Field rules', exact: true }).click();
    await expect(student.frameLocator('iframe[title="CourseWeave reader"]').getByRole('heading', { name: 'Field rules', exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: 'Open Validation notebook', exact: true }).click();
    const notebook = student.locator('.jp-Notebook:visible');
    await expect(notebook).toBeVisible();
    const prediction = 'Automated acceptance prediction with fictional records: Ada passes; string age and missing name fail their declared rules. This is not a learning claim.';
    await guide.getByRole('textbox', { name: 'Before running: predict which records pass and give the deciding field rule.', exact: true }).fill(prediction);
    await guide.getByRole('button', { name: 'Save response', exact: true }).click();
    await expect(guide.getByText('Saved response', { exact: true })).toBeVisible();
    await guide.getByRole('button', { name: 'Next authored hint', exact: true }).click();
    await guide.getByText('Self-checks (1)', { exact: true }).click();
    await guide.getByLabel('The name and age are factually correct.', { exact: true }).check();
    await guide.getByRole('button', { name: 'Check answer', exact: true }).click();
    await expect(guide.locator('.cw-check').getByRole('status').filter({ hasText: 'Try again.' })).toContainText('A schema cannot establish whether the values are true.');
    await guide.getByLabel('The record satisfies the declared field constraints.', { exact: true }).check();
    await guide.getByRole('button', { name: 'Try another answer', exact: true }).click();
    await expect(guide.locator('.cw-check').getByRole('status').filter({ hasText: 'Correct.' })).toContainText('Correct. Yes. The field rules pass');
    await expect(student.getByText('Course Python | Idle', { exact: true })).toBeVisible({ timeout: 30_000 });
    await student.getByRole('menuitem', { name: 'Run', exact: true }).click();
    await student.getByRole('menuitem', { name: 'Run All Cells', exact: true }).click();
    await expect(notebook).toContainText('Observed validation: [True, False, False]', { timeout: 30_000 });
    await notebook.click(); await student.keyboard.press('ControlOrMeta+s');
    const notebookPath = join(started.home, 'course/notebooks/practice.ipynb');
    await expect.poll(async () => JSON.parse(await readFile(notebookPath, 'utf8')).cells
      .filter(cell => cell.cell_type === 'code').every(cell => cell.execution_count !== null)).toBe(true);
    const saved = JSON.parse(await readFile(notebookPath, 'utf8'));
    expect(saved.cells.map(cell => cell.id)).toEqual(sourceIds);
    expect(saved.cells.flatMap(cell => cell.outputs ?? []).filter(output => output.output_type === 'error')).toEqual([]);
    item.kernel = await inspectInstalledNotebookKernel(student, 'notebooks/practice.ipynb');
    expect(Object.values(item.kernel.secret_presence)).not.toContain(true);
    await guide.getByText('Optional activities & references', { exact: true }).click();
    await navigation.getByRole('button', { name: 'Open Unaided protocol', exact: true }).click();
    await guide.getByRole('textbox', { name: 'Ask a question', exact: true }).fill('Acceptance draft: this must remain unsent during unaided work.');
    await expect(guide.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(guide.getByText('Assistant discussion is disabled for this activity.', { exact: true })).toBeVisible();
    await expect(guide.getByRole('button', { name: 'Share before asking' })).toHaveCount(0);
    expect(guideRequests).toBe(0);
    await guide.getByRole('textbox', { name: 'Describe only the independent practice you actually performed.', exact: true })
      .fill('Automated UI protocol check only. No human independent practice or mastery is claimed.');
    await guide.getByRole('button', { name: 'Save response', exact: true }).click();
    await expect(guide.getByText('Saved response', { exact: true })).toBeVisible();
    await student.screenshot({ path: join(evidence, `student-${version}-unaided.png`) });
    await navigation.getByRole('button', { name: 'Open Validation notebook', exact: true }).click();
    await expect(guide.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await student.screenshot({ path: join(evidence, `student-${version}-notebook.png`) });
    session.tracker.refresh();
    await card.getByRole('button', { name: 'Stop Student preview', exact: true }).click();
    const stoppedCard = panel.getByRole('article').filter({ has: author.getByRole('heading', { name: `Student v${version} · stopped`, exact: true }) });
    await expect(stoppedCard).toBeVisible(); await student.close();
    const bundle = join(dirname(started.home), 'bundle');
    const records = JSON.parse(maintenance(bundle, started.home, 'inspect')).records;
    expect(records).toHaveLength(2);
    item.saved_notebook_sha256 = hash(await readFile(notebookPath));
    const restarted = await session.restartStudent(bundle, started.home);
    const restartedGuide = restarted.page.frameLocator('iframe[title="CourseWeave guide"]');
    await expect(restartedGuide.getByLabel('Current location')).toBeVisible({ timeout: 60_000 });
    await restarted.stop(); await restarted.page.close();
    expect(JSON.parse(maintenance(bundle, started.home, 'inspect')).records).toEqual(records);
    expect(hash(await readFile(notebookPath))).toBe(item.saved_notebook_sha256);
    const exported = join(dirname(started.home), 'acceptance-records.json');
    maintenance(bundle, started.home, 'export', '--output', exported);
    expect(JSON.parse(await readFile(exported, 'utf8')).records).toEqual(records);
    maintenance(bundle, started.home, 'reset', '--confirm');
    expect(JSON.parse(maintenance(bundle, started.home, 'inspect')).records).toEqual([]);
    expect(hash(await readFile(notebookPath))).toBe(item.saved_notebook_sha256);
    expect(await readFile(join(project, 'course/notebooks/practice.ipynb'))).toEqual(sourceNotebook);
    item.observation = 'Automated installed UI: reviewed Markdown and HTML, prediction, both native-check outcomes, authored hint, notebook Run All and Save, optional unaided entry/exit with zero assistant requests, actual Student restart, records export/reset with notebook preservation. No human learning claim.';
    await stoppedCard.getByRole('button', { name: 'Record observations', exact: true }).click();
    for (const label of ['Markdown', 'HTML', 'Notebook', 'Navigated course', 'Used keyboard', 'Ran notebook', 'Saved notebook', 'Submitted prediction', 'Revealed hint', 'Answered native checks', 'Entered and exited unaided work', 'Restarted Student', 'Exported and reset test records']) {
      await panel.getByLabel(label, { exact: true }).check();
    }
    await panel.getByRole('textbox', { name: 'Preview observations', exact: true }).fill(item.observation);
    await panel.getByRole('button', { name: 'Save preview observations', exact: true }).click();
    await stoppedCard.getByRole('button', { name: 'Keep preview files', exact: true }).click();
    item.status = 'passed-awaiting-visual-inspection'; item.records_before_reset = records.length;
    item.student_guide_requests = guideRequests; item.source_notebook_preserved = true;
  }
}
