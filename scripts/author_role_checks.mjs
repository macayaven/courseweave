// Bounded live Author checks, called only by the explicit --live-only verifier.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '../frontend/node_modules/playwright/test.mjs';

export async function verifyAuthorRoles({ page, author, research, report, evidence, secrets, brave, correctLesson, project, onDiscovery }) {
  const callResearch = async button => {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/author/research') && r.request().method() === 'POST', { timeout: 75_000 }),
      research.getByRole('button', { name: button, exact: true }).click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    return response.json();
  };
  await research.getByRole('checkbox', { name: 'Enable network for this research run', exact: true }).check();
  await research.getByRole('textbox', { name: 'Allowed origins and paths', exact: true }).fill('https://docs.python.org/3/library');
  if (brave) {
    await research.getByRole('textbox', { name: 'Search queries', exact: true }).fill('site:docs.python.org/3/library/json.html Python JSON decoder');
    const found = await callResearch('Discover sources');
    onDiscovery(found.results);
    // Persist only our checks and request identity, never provider result fields.
    report.brave = { report_id: found.report_id, status: found.status,
      discovery_succeeded: found.status === 'complete' && found.results.some(r => r.policy_decision === 'allowed') };
    expect(report.brave.discovery_succeeded, 'Actual Brave discovery must return a permitted source.').toBe(true);
    const selectedIndex = found.results.findIndex(r => r.policy_decision === 'allowed' && r.url === 'https://docs.python.org/3/library/json.html');
    expect(selectedIndex >= 0, 'The selected Python JSON reference must be among the actual allowed results.').toBe(true);
    await research.locator('.source-result input[type="checkbox"]').nth(selectedIndex).check();
    await research.getByRole('button', { name: 'Use selected URLs', exact: true }).click();
    await expect(research.getByRole('textbox', { name: 'Public URLs', exact: true })).toHaveValue('https://docs.python.org/3/library/json.html');
    await research.getByRole('heading', { name: 'Discovery results', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, 'brave-discovery-controls.png'), mask: [research.locator('.source-result')] });
    const saved = JSON.parse(await readFile(join(project, 'author-state/research', found.report_id + '.json'), 'utf8'));
    expect(Boolean(saved.results?.length), 'Search results must not be persisted.').toBe(false);
    const [reopened] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/research/reports/' + found.report_id) && r.request().method() === 'GET'),
      research.getByRole('combobox', { name: 'Saved research run', exact: true }).selectOption(found.report_id),
    ]);
    expect((await reopened.json()).results).toEqual([]);
    await expect(research.getByRole('heading', { name: 'Discovery results', exact: true })).toHaveCount(0);
    await expect(research.getByText('No discovery results are retained in this saved report. Run a new search explicitly to view results again.', { exact: true })).toBeVisible();
    report.brave.explicit_result_selection = true;
    report.brave.reopened_without_results = true;
    report.brave.result_content_saved = false;
    await page.screenshot({ path: join(evidence, 'brave-reopened-report.png') });
  } else report.open_gates.push('Actual Brave discovery requires the owner-selected BRAVE_SEARCH_API_KEY.');
  await research.getByRole('textbox', { name: 'Public URLs', exact: true }).fill('https://docs.python.org/3/library/json.html');
  await research.getByRole('checkbox', { name: 'Enable network for this research run', exact: true }).check();
  const fetched = await callResearch('Fetch entered URLs');
  const source = fetched.fetches.find(item => item.source)?.source;
  report.public_fetch = { report_id: fetched.report_id, status: fetched.status,
    outcomes: fetched.fetches.map(item => ({ url: item.url, status: item.status, source: item.source })) };
  if (!source) report.open_gates.push('Actual public reference fetch did not produce an available source.');
  let fetchedTitle;
  if (source) {
    const card = author.getByRole('region', { name: 'Sources', exact: true }).locator('.source-card').filter({ hasText: 'Source: ' + source.source_id });
    fetchedTitle = await card.getByRole('heading', { level: 3 }).innerText();
    await card.getByRole('button', { name: 'Read extracted text for ' + fetchedTitle, exact: true }).click();
    await expect(card.locator('pre')).not.toBeEmpty();
    await card.getByRole('combobox', { name: 'Review status for ' + fetchedTitle, exact: true }).selectOption('approved');
    await card.getByRole('combobox', { name: 'Redistribution for ' + fetchedTitle, exact: true }).selectOption('exclude');
    await card.getByRole('textbox', { name: 'Review note for ' + fetchedTitle, exact: true }).fill('Official Python JSON reference. Extracted excerpt inspected for this scoped Author explanation. Redistribution excluded; approval is not proof of every claim.');
    await card.getByRole('button', { name: 'Save decision for ' + fetchedTitle, exact: true }).click();
    await expect(card.getByRole('combobox', { name: 'Review status for ' + fetchedTitle, exact: true })).toHaveValue('approved');
  }
  await research.getByRole('checkbox', { name: 'Enable network for this research run', exact: true }).uncheck();
  await author.getByRole('button', { name: 'Select phase Predict and validate', exact: true }).click();
  const assistant = author.getByRole('region', { name: 'Author assistant', exact: true });
  await assistant.getByRole('combobox', { name: 'Editable scope', exact: true }).selectOption('file');
  await assistant.getByRole('combobox', { name: 'Assistant file', exact: true }).selectOption('lessons/validate.md');
  await assistant.getByRole('checkbox', { name: 'Associate file review with selected activity', exact: true }).check();
  await assistant.getByRole('checkbox', { name: 'Permit instructor.md', exact: true }).check();
  if (fetchedTitle) await assistant.getByRole('checkbox', { name: 'Permit ' + fetchedTitle, exact: true }).check();
  const common = 'Return only the specified JSON reply object, without Markdown fences. Keep the message concise and useful for this selected activity. Do not invent citations or completion claims. Leave change:null unless requested. ';
  const cases = [
    ['curator', 'For each permitted source, name its title and report its own status and redistribution metadata separately. Do not transfer a decision from one source to another. Then assess instructor.md for this lesson: state its best use and one omission. Source approval and redistribution remain separate author decisions.'],
    ['curriculum_designer', 'Explain an actionable prediction → notebook → self-check sequence for this objective. Map the field-rules objective to the schema-versus-truth check; keep independent work optional and unaided.'],
    ['source_researcher', 'Use the permitted references to distinguish JSON parsing from application field validation. Explain what the fetched Python documentation supports and what requires the instructor reference or further evidence.'],
    ['fact_checker', 'Assess this claim: "Passing the schema proves that the recorded age is factually correct." Use one finding with judgment contradicted and an exact quotation from instructor.md, copying its supplied provenance fields and correct character offsets.'],
    ['proofreader', 'Propose a markdown_replace change correcting only "aplication schema" to "application schema" in the selected saved lesson. Preserve every other character and the final newline. Explain the spelling correction.'],
    ['compatibility_reviewer', 'Explain the supplied deterministic compatibility report for this activity: what passed, what is unperformed, and which actual installed Student checks remain necessary. Do not turn unperformed checks into passes.'],
  ];
  const replies = [], rejected = [];
  const selectedRoles = process.env.COURSEWEAVE_AUTHOR_ROLE_IDS?.split(',');
  if (selectedRoles?.some(role => !cases.some(([id]) => id === role))) throw new Error('Unknown selected Author role.');
  for (const [role, prompt] of cases) {
    if (selectedRoles && !selectedRoles.includes(role)) {
      report.open_gates.push('Role ' + role + ' was not selected for this bounded run.');
      continue;
    }
    await assistant.getByRole('combobox', { name: 'Author role', exact: true }).selectOption(role);
    await assistant.getByRole('textbox', { name: 'Message to Author assistant', exact: true }).fill(common + `Set the JSON role field to "${role}" exactly. ` + prompt);
    await expect(assistant.getByRole('button', { name: 'Request review', exact: true })).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/author/guide') && r.request().method() === 'POST', { timeout: 180_000 }),
      assistant.getByRole('button', { name: 'Request review', exact: true }).click(),
    ]);
    const wire = await response.text();
    const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const candidate = events.find(event => event.name === 'courseweave.author_reply')?.value;
    const outcome = events.find(event => event.name === 'courseweave.provider_outcome')?.value;
    const item = { role, valid_reply: Boolean(candidate), outcome: outcome ?? null, terminal: events.at(-1)?.type };
    report.roles.push(item);
    if (!candidate) {
      const error = events.find(event => event.type === 'RUN_ERROR');
      item.rejection = error ? { code: error.code, message: error.message } : null;
      rejected.push({ role, rejection: item.rejection, text: events.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').map(event => event.delta ?? '').join('') });
      const encoded = JSON.stringify(rejected, null, 2) + '\n';
      if (secrets.some(secret => secret && encoded.includes(secret))) throw new Error('Protected value in rejected response evidence.');
      await writeFile(join(evidence, 'private-rejected-replies.json'), encoded, { mode: 0o600 });
      report.open_gates.push('The live ' + role + ' request did not produce a validated useful reply; no automatic repair was made.');
      continue;
    }
    expect(candidate.reply.role).toBe(role);
    replies.push({ role, prompt, reply: candidate.reply });
    await expect(assistant.getByRole('button', { name: 'Save review report', exact: true })).toBeEnabled();
    const [saved] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/save-review') && r.request().method() === 'POST'),
      assistant.getByRole('button', { name: 'Save review report', exact: true }).click(),
    ]);
    expect(saved.status()).toBe(201); item.saved_report = (await saved.json()).report_id;
    if (role === 'fact_checker' && !candidate.reply.findings.some(f => f.judgment === 'contradicted' && f.evidence.length))
      report.open_gates.push('Fact checker did not return the required located contradiction.');
    await assistant.getByRole('list', { name: 'Author conversation', exact: true }).locator('li').last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, 'role-' + role + '.png') });
    if (role === 'proofreader') {
      if (candidate.reply.change?.kind === 'markdown_replace' && candidate.reply.change.text === correctLesson) {
        await assistant.getByRole('button', { name: 'Save draft for review', exact: true }).click();
        const draft = author.getByRole('article', { name: 'File change review', exact: true });
        await expect(draft.locator('pre')).toContainText('aplication schema');
        await draft.getByRole('checkbox', { name: 'I reviewed this exact diff', exact: true }).check();
        await draft.getByRole('button', { name: 'Apply reviewed change', exact: true }).click();
        await expect(author.getByRole('region', { name: 'Lesson files', exact: true }).getByText('Reviewed file applied and saved project reloaded.', { exact: true })).toBeVisible();
        expect(await readFile(join(project, 'course/lessons/validate.md'), 'utf8')).toBe(correctLesson);
        item.reviewed_change_applied = true;
      } else report.open_gates.push('Proofreader replacement was not the exact requested spelling-only change; retained for inspection.');
    }
    const encoded = JSON.stringify(replies, null, 2) + '\n';
    if (secrets.some(secret => secret && encoded.includes(secret))) throw new Error('Protected value in model evidence; evidence was not saved.');
    await writeFile(join(evidence, 'private-role-replies.json'), encoded, { mode: 0o600 });
  }
  report.checks.push(`${report.roles.length} explicit real-provider role requests; validated replies and separately saved reports are individually recorded. Live role quality still requires evaluator inspection.`);
}
