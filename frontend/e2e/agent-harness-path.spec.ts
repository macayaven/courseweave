import { startFakeOpenAiProvider } from './fake-openai-provider';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from 'playwright/test';

import { inspectInstalledNotebookKernel } from './installed-kernel';

import { launchInstalledWorkspace, prepareCommittedCourseCopy, usingTestResourceCustody } from './installed-wheel-helpers';

const ADAPTER_HEAD = '776f64ae8ae5d1e4fceca3a93de89b9ebf446727';
const ADAPTER_TREE = 'e91a8eab6cc567f2039584de1185a773156a9430';
const ADAPTER_MANIFEST_SHA256 = 'f929080675527f7d2281236d614ce0d604b026be2994b76ce84bb3c037fc8d06';

type AdapterSnapshot = {
  head: string;
  tree: string;
  status: string;
  manifestSha256: string;
};

function git(adapterRoot: string, args: string[]): string {
  const result = spawnSync('git', ['-C', adapterRoot, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error('Could not inspect the installed-adapter source snapshot.');
  }
  return result.stdout.trim();
}

async function snapshotAdapter(adapterRoot: string): Promise<AdapterSnapshot> {
  const manifest = await readFile(`${adapterRoot}/courseweave.json`);
  return {
    head: git(adapterRoot, ['rev-parse', 'HEAD']),
    tree: git(adapterRoot, ['rev-parse', 'HEAD^{tree}']),
    status: git(adapterRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  };
}

async function bootstrap(page: Page, tokenlessUrl: string): Promise<void> {
  try {
    const response = await page.goto(tokenlessUrl, { waitUntil: 'domcontentloaded' });
    if (response === null || !response.ok()) throw new Error('unsafe bootstrap detail');
  } catch {
    throw new Error('Installed-adapter bootstrap navigation failed.');
  }
}

async function dismissJupyterNews(page: Page): Promise<void> {
  const decline = page.locator('.jp-toastContainer').getByRole('button', { name: 'No', exact: true });
  if (await decline.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) {
    await decline.click();
    await expect(decline).toBeHidden();
  }
}

async function openGuideCommand(page: Page): Promise<void> {
  await page.getByRole('menuitem',{name:'View',exact:true}).click();
  await page.getByRole('menuitem',{name:/^Activate Command Palette(?:\s|$)/}).click();
  const palette=page.locator('.jp-ModalCommandPalette');
  const input=palette.locator('.lm-CommandPalette-input');
  await input.fill('Open CourseWeave Guide');
  await expect(palette.getByRole('menuitem',{name:'Open CourseWeave Guide',exact:true})).toBeVisible();
  await input.press('Enter');
  await expect(palette).toBeHidden();
}

type RuntimeCredentials = {
  capabilityToken: string;
  serviceOrigin: string;
  runtimeId: string;
  pageConfig: Record<string, unknown>;
};

async function runtimeCredentials(page: Page): Promise<RuntimeCredentials> {
  const pageConfig = await page.locator('#jupyter-config-data').evaluate((node) => JSON.parse(node.textContent ?? '{}')) as Record<string, unknown>;
  const runtimeId = pageConfig.courseweaveRuntimeId;
  if (typeof runtimeId !== 'string') throw new Error('Installed-adapter runtime ID is unavailable.');
  const runtime = await page.evaluate(async ({id, base}) => {
    const response = await fetch(`${base}courseweave/runtime`, { headers: { 'X-CourseWeave-Runtime-ID': id } });
    return response.json() as Promise<{ capabilityToken: string; serviceOrigin: string }>;
  }, {id: runtimeId, base: String(pageConfig.baseUrl)});
  return { ...runtime, runtimeId, pageConfig };
}

async function apiJson(
  request: APIRequestContext,
  runtime: RuntimeCredentials,
  path: string,
  options: { method?: string; headers?: Record<string, string>; data?: unknown; expectedStatus?: number } = {},
): Promise<Record<string, unknown>> {
  const response = await request.fetch(`${runtime.serviceOrigin}${path}`, {
    method: options.method,
    headers: { Authorization: `Bearer ${runtime.capabilityToken}`, ...options.headers },
    data: options.data,
  });
  const body = await response.json() as Record<string, unknown>;
  expect(response.status(), `Unexpected installed-adapter API response for ${path}.`).toBe(options.expectedStatus ?? 200);
  return body;
}

async function browserCredentialSnapshot(page: Page, runtime: RuntimeCredentials) {
  const storage = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => ({
        url: location.href,
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }));
    } catch {
      return { url: frame.url(), inaccessible: true };
    }
  }));
  return {
    capabilityToken: runtime.capabilityToken,
    pageConfig: runtime.pageConfig,
    storage: JSON.stringify(storage),
  };
}

function phaseSection(guide: FrameLocator, moduleTitle: string, phaseTitle: string) {
  return guide.getByRole('heading', { name: moduleTitle, exact: true }).locator('..')
    .filter({ has: guide.getByRole('heading', {name:phaseTitle,exact:true}) })
    .getByRole('heading', { name: phaseTitle, exact: true }).locator('..');
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

type CommittedCourseCopy = Awaited<ReturnType<typeof prepareCommittedCourseCopy>>;

async function verifyAdapterCustody(
  copy: CommittedCourseCopy,
  adapterRoot: string,
  expected: AdapterSnapshot,
  closeCopy = false,
): Promise<void> {
  const checks = await Promise.allSettled([
    copy.verifySourceUnchanged().then((current) => {
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Committed-copy source custody changed.');
    }),
    snapshotAdapter(adapterRoot).then((current) => {
      if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Adapter source custody changed.');
    }),
    closeCopy ? copy.close() : Promise.resolve(),
  ]);
  const failures = checks.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Adapter source custody verification failed.');
}


test.describe.configure({ timeout: 300_000, mode: 'serial' });

test('proves the installed platform end to end against the exact Agent Harness Path adapter', async ({ browser, request }, testInfo) => {
  const attachEvidence = async (name: string, value: unknown) => {
    await mkdir(testInfo.outputDir, {recursive:true});
    const path = testInfo.outputPath(name);
    await writeFile(path, JSON.stringify(value,null,2)+'\n');
    await testInfo.attach(name, {path, contentType:'application/json'});
  };
  const startedAt = Date.now();
  const milestone = (name: string) => console.log(`[installed-adapter +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${name}`);
  const adapterRoot = process.env.COURSEWEAVE_ADAPTER_ROOT;
  expect(adapterRoot, 'COURSEWEAVE_ADAPTER_ROOT must name the explicit adapter checkout.').toBeTruthy();
  const before = await snapshotAdapter(adapterRoot!);

  expect(before).toEqual({
    head: ADAPTER_HEAD,
    tree: ADAPTER_TREE,
    status: '',
    manifestSha256: ADAPTER_MANIFEST_SHA256,
  });

  await usingTestResourceCustody(async (outerCustody) => {
    const copy = await outerCustody.acquire(
      () => prepareCommittedCourseCopy(adapterRoot!, {
        head: ADAPTER_HEAD,
        tree: ADAPTER_TREE,
        manifestSha256: ADAPTER_MANIFEST_SHA256,
      }),
      async (ownedCopy) => { await verifyAdapterCustody(ownedCopy, adapterRoot!, before, true); },
    );
    expect(await snapshotAdapter(adapterRoot!)).toEqual(before);
    expect(await copy.manifestSha256()).toBe(ADAPTER_MANIFEST_SHA256);

    const videoUrl = 'https://storage.googleapis.com/macayaven-agent-harness-path-videos/S01-agent-loop.mp4';
    const unexpectedExternal: string[] = [];
    const videoRequests: string[] = [];
    let workspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
    await usingTestResourceCustody(async (custody) => {
    await custody.acquire(async () => undefined, async () => {
      await verifyAdapterCustody(copy, adapterRoot!, before);
    }, 5);
    workspace = await custody.acquire(
      () => launchInstalledWorkspace('learn', {
        courseRoot: copy.courseRoot,
        stateDir: join(copy.courseRoot, '..', 'state'),
        kernelPython: join(adapterRoot!, '.venv', 'bin', 'python'),
        terminalCommandCanary: { executable: 'uv', markerName: 'terminal-command-executed' },
      }),
      async (ownedWorkspace) => { await ownedWorkspace.close(); },
      0,
    );
    milestone('missing-provider workspace launched');
    let copiedTerminalInstructions = '';
    const context = await custody.acquire(() => browser.newContext(), async (ownedContext) => { await ownedContext.close(); }, 20);
    await context.exposeBinding('__courseweaveCopyForTest', (_source, value: unknown) => {
      copiedTerminalInstructions = String(value);
    });
    await context.addInitScript(() => {
      const copyForTest = (globalThis as unknown as { __courseweaveCopyForTest(value: string): Promise<void> }).__courseweaveCopyForTest;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (value: string) => copyForTest(value) },
      });
    });
    await context.route('https://**/*', async (route) => {
      if (route.request().url() === videoUrl) {
        videoRequests.push(route.request().url());
        await route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(0) });
      } else {
        unexpectedExternal.push(route.request().url());
        await route.abort();
      }
    });
    const page = await custody.acquire(() => context.newPage(), async (ownedPage) => { await ownedPage.close(); }, 10);
    const pageErrors: string[] = [];
    const consoleMessages: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response',r=>{if(r.url().endsWith('.svg')||r.url().includes('/courseweave/reader/lessons/S01-agent-loop.html')) console.log('Reader response',JSON.stringify({url:new URL(r.url()).pathname,status:r.status(),contentType:r.headers()['content-type'],csp:r.headers()['content-security-policy']}));});
    page.on('console', (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
      await bootstrap(page, await workspace.bootstrapUrl());
      await dismissJupyterNews(page);
      const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(guide.locator('body')).toContainText('The Agent Harness Path');

      await expect(guide.getByLabel('Current location')).toContainText('Read and trace the theory');
      await guide.getByLabel('Ask a question').fill('Explain the agent loop without a configured provider.');
      await guide.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(guide.getByRole('region', { name: 'Course assistant' }).getByText('Course assistant unavailable', { exact: true })).toBeVisible();
      await expect(guide.getByRole('region', { name: 'Course dashboard' })).toContainText('The agent loop');

      await guide.getByText('Course contents', { exact: true }).click();
      await phaseSection(guide, 'The agent loop', 'Read and trace the theory').getByRole('button', { name: 'Open Read the lesson', exact: true }).click();
      const reader = page.locator('iframe[title="CourseWeave reader"]');
      await expect(reader).toHaveAttribute('src', /\/courseweave\/courseweave\/reader\/lessons\/S01-agent-loop\.html#the-theory-in-depth$/);
      await expect.poll(() => page.frames().some((frame) => /\/courseweave\/courseweave\/reader\/lessons\/S01-agent-loop\.html#the-theory-in-depth$/.test(frame.url()))).toBe(true);
      const lessonFrame = page.frames().find((frame) => /\/courseweave\/courseweave\/reader\/lessons\/S01-agent-loop\.html#the-theory-in-depth$/.test(frame.url()));
      await expect(lessonFrame!.locator('h1')).toHaveText('S01-agent-loop — The agent loop');
      await expect.poll(()=>lessonFrame!.locator('img.static-diagram').evaluate(node=>(node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

      await phaseSection(guide, 'The agent loop', 'Read and trace the theory').getByRole('button', { name: 'Open Optional Gemini Notebook overview' }).click();
      await expect(reader).toHaveAttribute('src', videoUrl);
      await expect.poll(() => videoRequests.length).toBeGreaterThan(0);
      expect(new Set(videoRequests)).toEqual(new Set([videoUrl]));

      await phaseSection(guide, 'The agent loop', 'Notebook: predict, attempt, observe').getByRole('button', { name: 'Open notebook: predict, attempt, observe' }).click();
      await expect(page.locator('.jp-Notebook')).toHaveCount(1);
      const mappedCell = page.locator('.jp-Notebook .jp-Cell', { hasText: 'Experiment 2 — drop the assistant message' });
      await expect(mappedCell).toHaveCount(1);
      const cellContext = page.waitForResponse((response) => {
        if (response.request().method() !== 'POST' || !response.url().endsWith('/courseweave/context')) return false;
        try { return response.request().postDataJSON().active_cell_id === '69a77fc3'; } catch { return false; }
      });
      await mappedCell.click();
      const cellResponse = await cellContext;
      expect(cellResponse.request().postDataJSON()).toMatchObject({
        active_path: 'notebooks/s01_agent_loop_toy.ipynb', active_cell_id: '69a77fc3', surface_kind: 'notebook',
      });
      expect(await cellResponse.json()).toMatchObject({ module_id: 's01', phase_id: 'notebook', surface_id: 'notebook', reason: 'explicit_phase' });
      await expect(guide.getByLabel('Current location')).toContainText('Notebook: predict, attempt, observe');
      const kernel = await inspectInstalledNotebookKernel(page, 'notebooks/s01_agent_loop_toy.ipynb');
      expect(kernel).toMatchObject({kernel_name:'python3',allowed_kernels:['python3'],executable:join(adapterRoot!,'.venv','bin','python'),prefix:join(adapterRoot!,'.venv'),transport:'tcp',bind_ip:'127.0.0.1',message_authentication:'hmac-sha256',message_key_present:true,secret_presence:{OPENAI_API_KEY:false,ANTHROPIC_API_KEY:false,AGENT_KB_LITELLM_KEY:false,COURSEWEAVE_CAPABILITY_TOKEN:false,JUPYTER_TOKEN:false}});
      await attachEvidence('actual-course-kernel.json',kernel);
      milestone('actual native course interpreter and secret-free loopback authenticated kernel verified');

      const prediction = guide.getByLabel('Before running experiments: predict the happy-path roles/turns, what fails when the assistant call message is dropped, what ends the repeated-call run, and where the recoverable weather error appears. Give a reason for each.', { exact: false });
      await prediction.fill('Dropping the assistant tool call breaks tool-result pairing.');
      await prediction.locator('..').locator('..').getByRole('button', { name: 'Save response', exact:true }).click();
      await expect(guide.getByText('Saved response', { exact: true })).toBeVisible();

      const runtime = await runtimeCredentials(page);
      const predictedState = await apiJson(request, runtime, '/api/state');
      expect(predictedState.records).toEqual(expect.arrayContaining([expect.objectContaining({
        coordinate:{module_id:'s01',phase_id:'notebook',requirement_id:'s01-prediction'},
        value:{text:'Dropping the assistant tool call breaks tool-result pairing.'},
      })]));

      await guide.getByText('Optional activities & references', { exact: true }).click();
      await phaseSection(guide, 'The agent loop', 'Optional hard lab: trivia host').getByRole('button', { name: 'Open Lab Guide', exact: true }).click();
      await expect(page.locator('.lm-TabBar-tabLabel', { hasText: 's01_loop.md' })).toBeVisible();
      await expect(page.locator('.jp-RenderedMarkdown', { hasText: 'S01 lab — the trivia-host loop' })).toBeVisible();
      await phaseSection(guide, 'The agent loop', 'Optional hard lab: trivia host').getByRole('button', { name: 'Open Loop Source' }).click();
      await expect(page.locator('.jp-MainAreaWidget:visible .cm-content', { hasText: 'def run_loop' })).toBeVisible();
      await phaseSection(guide, 'The agent loop', 'Optional hard lab: trivia host').getByRole('button', { name: 'Open Copy S01 replay command (learner implementation)' }).click();
      const terminalInstructions = page.locator('[data-courseweave-terminal-instructions]');
      const expectedTerminal = JSON.stringify({
        cwd: '.',
        command: ['uv', 'run', 'python', 'labs/run.py', '--session', 's01', '--replay'],
      }, null, 2);
      await expect(terminalInstructions).toContainText(expectedTerminal);
      const copyInstructions = terminalInstructions.getByRole('button', { name: 'Copy launch instructions' });
      await expect(copyInstructions).toBeVisible();
      await expect(copyInstructions).toBeEnabled();
      await copyInstructions.evaluate((button) => button.click());
      await expect(terminalInstructions.getByRole('status')).toHaveText('Terminal launch instructions copied.');
      await expect.poll(() => copiedTerminalInstructions).toBe(expectedTerminal);
      await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
      await page.waitForTimeout(250);
      await expect(workspace.terminalSentinelExists()).resolves.toBe(false);
      milestone('adapter surfaces and display-only terminal command verified');

      const manifestBeforeProposals = await fileSha256(join(copy.courseRoot, 'courseweave.json'));
      await apiJson(request, runtime, '/api/proposals', {
        method: 'POST', expectedStatus: 201, headers: { 'Idempotency-Key': 'adapter-reject-create' },
        data: { id: 'adapter-reject', type: 'profile_patch', origin: 'student_requested', summary: 'Reject adapter profile change', target: 'learner_profile', payload: { changes: { practice: 'extra' } }, target_hash: null },
      });
      await apiJson(request, runtime, '/api/proposals', {
        method: 'POST', expectedStatus: 201, headers: { 'Idempotency-Key': 'adapter-accept-create' },
        data: { id: 'adapter-accept', type: 'profile_patch', origin: 'student_requested', summary: 'Accept adapter profile change', target: 'learner_profile', payload: { changes: { explanation: 'concise' } }, target_hash: null },
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await dismissJupyterNews(page);
      const refreshedGuide = page.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(refreshedGuide.locator('body')).toContainText('The Agent Harness Path');
      await refreshedGuide.getByText('Suggested changes (2)',{exact:true}).click();
      const rejected = refreshedGuide.locator('article', { hasText: 'Reject adapter profile change' });
      await rejected.getByRole('button', { name: 'Reject' }).click();
      await expect(rejected).toContainText('Status: rejected');
      const afterReject = await apiJson(request, await runtimeCredentials(page), '/api/state');
      expect(afterReject.preferences).toMatchObject({ enabled: false, explanation: 'balanced', practice: 'standard' });
      expect(afterReject.audit).toContainEqual(expect.objectContaining({ proposal_id: 'adapter-reject', proposal_revision: 1, status: 'rejected' }));
      expect(await fileSha256(join(copy.courseRoot, 'courseweave.json'))).toBe(manifestBeforeProposals);

      await refreshedGuide.getByText('Learning memory & preferences', { exact: true }).click();
      await refreshedGuide.getByLabel('Use my saved learning evidence for adaptation').click();
      await expect(refreshedGuide.getByLabel('Use my saved learning evidence for adaptation')).toBeChecked();
      await expect(refreshedGuide.getByText('Learning preferences saved.', { exact: true })).toBeVisible();
      const beforeAccept = await apiJson(request, await runtimeCredentials(page), '/api/state');
      const accepted = refreshedGuide.locator('article', { hasText: 'Accept adapter profile change' });
      await accepted.getByLabel('Edit summary').fill('Accept edited adapter profile change');
      await accepted.getByRole('button', { name: 'Save edit' }).click();
      const edited = refreshedGuide.locator('article', { hasText: 'Accept edited adapter profile change' });
      await expect(edited).toContainText('Status: pending');
      const acceptRequest = page.waitForRequest((candidate) => candidate.method() === 'POST' && candidate.url().endsWith('/api/proposals/adapter-accept/accept'));
      await edited.getByRole('button', { name: 'Accept' }).click();
      const capturedAccept = await acceptRequest;
      await expect(edited).toContainText('Status: accepted');
      const afterAcceptRuntime = await runtimeCredentials(page);
      const afterAccept = await apiJson(request, afterAcceptRuntime, '/api/state');
      expect(afterAccept.preferences).toMatchObject({ enabled: true, explanation: 'concise', practice: 'standard' });
      expect(afterAccept.revision).toBe((beforeAccept.revision as number) + 1);
      expect(afterAccept.audit).toContainEqual(expect.objectContaining({ proposal_id: 'adapter-accept', proposal_revision: 2, status: 'accepted' }));
      const acceptKey = capturedAccept.headers()['idempotency-key'];
      expect(acceptKey).toEqual(expect.any(String));
      await apiJson(request, afterAcceptRuntime, '/api/proposals/adapter-accept/accept', {
        method: 'POST', headers: { 'Idempotency-Key': acceptKey! }, data: capturedAccept.postDataJSON(),
      });
      const afterReplay = await apiJson(request, afterAcceptRuntime, '/api/state');
      expect(afterReplay).toEqual(afterAccept);
      expect(await fileSha256(join(copy.courseRoot, 'courseweave.json'))).toBe(manifestBeforeProposals);
      milestone('reject, edited accept, and idempotent replay verified');

      const credential = await browserCredentialSnapshot(page, afterAcceptRuntime);
      expect(pageErrors).toEqual([]);

      workspace.scheduleFinalCredentialAudit({
        ...credential,
        browserOutput: JSON.stringify({ pageErrors, consoleMessages }),
        locations: page.frames().map((frame) => frame.url()),
        artifactRoots: [testInfo.outputDir],
      });
      await workspace.interrupt();
      await refreshedGuide.getByLabel('Ask a question').fill('This request crosses an intentional backend interruption.');
      await refreshedGuide.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(refreshedGuide.getByText('Answer interrupted. Your question and partial answer are kept; retry when ready.', { exact: true })).toBeVisible();
      await expect(refreshedGuide.getByLabel('Ask a question')).toHaveValue('This request crosses an intentional backend interruption.');
      await expect(refreshedGuide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','failed');
      milestone('backend interruption retained the question, draft and failed status');
    });
    const audit = workspace!.finalAuditResult();
    expect(audit).toEqual({ filesScanned: expect.any(Number), retainedCredentials: 0 });
    expect(audit!.filesScanned).toBeGreaterThan(0);
    milestone(`first post-stop credential audit scanned ${audit!.filesScanned} files`);
    await expect(workspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });

    let providerWorkspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
    await usingTestResourceCustody(async (custody) => {
    await custody.acquire(async () => undefined, async () => {
      await verifyAdapterCustody(copy, adapterRoot!, before);
    }, 5);
    const fakeProvider = await custody.acquire(startFakeOpenAiProvider, async (provider) => { await provider.close(); }, 30);
    providerWorkspace = await custody.acquire(
      () => launchInstalledWorkspace('learn', {
        courseRoot: copy.courseRoot,
        stateDir: join(copy.courseRoot, '..', 'state'),
        kernelPython: join(adapterRoot!, '.venv', 'bin', 'python'),
        providerEnvironment: {
          COURSEWEAVE_PROVIDER: 'openai',
          OPENAI_MODEL: 'stub-model',
          OPENAI_BASE_URL: fakeProvider.baseUrl,
          OPENAI_API_KEY: 'courseweave-local-provider-canary',
          COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS: '30',
          COURSEWEAVE_PROVIDER_PROFILE: 'stream-tools-v1',
        },
      }),
      async (ownedWorkspace) => { await ownedWorkspace.close(); },
      0,
    );
    const providerContext = await custody.acquire(() => browser.newContext(), async (ownedContext) => { await ownedContext.close(); }, 20);
    await providerContext.route('https://**/*', async (route) => {
      unexpectedExternal.push(route.request().url());
      await route.abort();
    });
    const providerPage = await custody.acquire(() => providerContext.newPage(), async (ownedPage) => { await ownedPage.close(); }, 10);
    milestone('local-provider workspace launched');
    const providerErrors: string[] = [];
    const providerConsole: string[] = [];
    const guideRequests: Array<Record<string,any>>=[];
    const shares: Array<Record<string,any>>=[];
    providerPage.on('request',r=>{ if(r.method()==='POST' && r.url().endsWith('/api/guide'))guideRequests.push(r.postDataJSON()); if(r.method()==='POST' && r.url().endsWith('/api/share'))shares.push(r.postDataJSON()); });
    providerPage.on('pageerror', (error) => providerErrors.push(error.message));
    providerPage.on('console', (message) => providerConsole.push(`${message.type()}:${message.text()}`));
      await bootstrap(providerPage, await providerWorkspace.bootstrapUrl());
      await dismissJupyterNews(providerPage);
      const providerGuide = providerPage.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(providerGuide.getByLabel('Current location')).toContainText('Read and trace the theory');
      const providerRuntime = await runtimeCredentials(providerPage);
      const reloadedState = await apiJson(request, providerRuntime, '/api/state');
      expect(reloadedState.records).toEqual(expect.arrayContaining([expect.objectContaining({coordinate:{module_id:'s01',phase_id:'notebook',requirement_id:'s01-prediction'},value:{text:'Dropping the assistant tool call breaks tool-result pairing.'}})]));
      expect(reloadedState.preferences).toMatchObject({ enabled: true, explanation: 'concise', practice: 'standard' });
      expect(reloadedState.audit).toEqual([
        { sequence: 1, proposal_id: 'adapter-reject', proposal_revision: 1, status: 'rejected', proposal_type: 'profile_patch' },
        { sequence: 2, proposal_id: 'adapter-accept', proposal_revision: 2, status: 'accepted', proposal_type: 'profile_patch' },
      ]);
      await providerGuide.getByLabel('Ask a question').fill('Give one short local explanation of the loop.');
      await providerGuide.getByRole('button', { name: 'Send', exact: true }).click();
      try { await expect(providerGuide.getByText('local teacher reply', { exact: true })).toBeVisible(); } catch(error) { console.log('Provider diagnostic',JSON.stringify({body:await providerGuide.locator('body').innerText(),requests:fakeProvider.requests.map(r=>({path:r.path,stream:r.body.stream,tools:r.body.tools}))})); throw error; }
      expect(fakeProvider.requests).toHaveLength(1);
      expect(fakeProvider.requests[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer courseweave-local-provider-canary', body: { stream: false } });
      milestone('authoritative state reload and local provider chat verified');
      await providerPage.setViewportSize({width:1440,height:1000});
      await providerGuide.getByText('Course contents',{exact:true}).click();
      const readActivity=phaseSection(providerGuide,'The agent loop','Read and trace the theory');
      const notebookActivity=phaseSection(providerGuide,'The agent loop','Notebook: predict, attempt, observe');
      await readActivity.getByRole('button',{name:'Open Read the lesson',exact:true}).click();
      const nativeLesson=providerPage.frameLocator('iframe[title="CourseWeave reader"]');
      await expect(nativeLesson.locator('img[src*="S01"]')).toBeVisible();
      await nativeLesson.locator('img[src*="S01"]').scrollIntoViewIfNeeded();
      await providerPage.screenshot({path:testInfo.outputPath('installed-s01-diagram.png')});
      await nativeLesson.locator('#self-check').scrollIntoViewIfNeeded();
      await providerPage.screenshot({path:testInfo.outputPath('installed-s01-native-quiz.png')});
      await providerGuide.getByText('Lesson & sharing scope',{exact:true}).click();
      const lessonResponse=providerPage.waitForResponse(r=>r.url().endsWith('/api/guide/lesson'));
      await providerGuide.getByRole('button',{name:'Use this lesson',exact:true}).click();
      const lessonResult=await lessonResponse;
      expect(lessonResult.status()).toBe(200);
      const lessonScope = await lessonResult.json();
      expect(lessonScope.scope).toMatchObject({label:'Read the lesson',omitted_sections:true,truncated:false});
      await attachEvidence('installed-lesson-scope.json',lessonScope);
      await expect(providerGuide.getByText(/Using: Read the lesson/)).toBeVisible();
      await providerGuide.getByText('Lesson & sharing scope',{exact:true}).click();
      await nativeLesson.getByRole('link',{name:'notebooks/s01_agent_loop_toy.ipynb',exact:true}).click();
      await expect(providerGuide.getByLabel('Current location')).toContainText('Notebook: predict, attempt, observe');
      const attempt=providerGuide.getByLabel('After the demonstrations, attempt the two-city weather transcript in the added notebook cell.',{exact:false});
      await attempt.fill('Public browser smoke: results map to A and B; ordinary text has no call ID. This is a test record, not a completed unaided exercise.');
      await attempt.locator('..').locator('..').getByRole('button',{name:'Save response',exact:true}).click();
      await expect(providerGuide.getByText('Response saved.',{exact:true})).toBeVisible();
      const stateBeforeHint=await apiJson(request,providerRuntime,'/api/state');
      const providerCountBeforeHint=fakeProvider.requests.length;
      await providerGuide.getByRole('button',{name:'Next authored hint',exact:true}).click();
      await providerGuide.getByText('Lesson & sharing scope',{exact:true}).click();
      await providerGuide.getByText('Optional learning choices',{exact:true}).click();
      await providerGuide.getByRole('button',{name:'Continue without revisiting',exact:true}).click();
      await expect(providerGuide.getByText('Continue at your own pace; this revisit offer is dismissed.',{exact:true})).toBeVisible();
      expect(fakeProvider.requests).toHaveLength(providerCountBeforeHint);
      expect(await apiJson(request,providerRuntime,'/api/state')).toEqual(stateBeforeHint);
      await providerGuide.getByText('Lesson & sharing scope',{exact:true}).click();
      await providerPage.locator('.jp-Notebook .jp-Cell').first().click();
      fakeProvider.holdNext();
      await providerGuide.getByLabel('Ask a question').fill('Explain this shared public notebook cell while I navigate back to the reading.');
      await providerGuide.getByRole('button',{name:'Share before asking',exact:true}).click();
      await providerGuide.getByLabel('Share kind').selectOption('cell');
      await providerGuide.getByRole('button',{name:'Share and ask',exact:true}).click();
      await expect(providerGuide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','streaming');
      await expect(providerGuide.locator('.cw-transcript article').last()).toContainText('local teacher');
      expect(fakeProvider.requests.at(-1)!.body.stream).toBe(true);
      expect(shares).toHaveLength(1);
      const sharedRun=guideRequests.at(-1)!;
      expect(shares[0]!.run_id).toBe(sharedRun.runId);
      const liveRegion=providerGuide.getByRole('status',{name:'Answer updates',exact:true});
      await expect(providerGuide.locator('.cw-transcript')).toHaveAttribute('aria-live','off');
      await expect(liveRegion).not.toContainText('local teacher');
      await readActivity.getByRole('button',{name:'Open Read the lesson',exact:true}).click();
      await expect(providerGuide.getByLabel('Current location')).toContainText('Read and trace the theory');
      await expect(providerGuide.locator('.cw-transcript article').last()).toContainText('Notebook: predict, attempt, observe');
      await providerPage.screenshot({path:testInfo.outputPath('installed-navigation-during-stream.png')});
      fakeProvider.release();
      await expect(providerGuide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','finished');
      await expect(liveRegion).toContainText('Answer complete');
      await providerGuide.getByLabel('Ask a question').fill('Ask again in this same conversation from the reading activity.');
      await providerGuide.getByRole('button',{name:'Send',exact:true}).click();
      await expect(providerGuide.locator('.cw-transcript article')).toHaveCount(5);
      await expect(providerGuide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','finished');
      await expect(providerGuide.locator('.cw-transcript article').last()).toContainText('Read and trace the theory');
      expect(new Set(guideRequests.map(r=>r.threadId)).size).toBe(1);
      expect(JSON.stringify(fakeProvider.requests.at(-1)!.body)).not.toContain(shares[0]!.content);
      await expect(providerGuide.getByText('Ready',{exact:true})).toBeVisible();
      milestone('same conversation, lesson scope, one-run native cell Share and navigation during true provider streaming verified');
      const checkActivity=phaseSection(providerGuide,'The agent loop','Self-check and explain');
      await checkActivity.getByRole('button',{name:'Open native self-check and reference',exact:true}).click();
      await expect(providerGuide.getByLabel('Current location')).toContainText('Self-check and explain');
      await providerGuide.getByText(/^Self-checks \(\d+\)$/).click();
      await providerGuide.getByLabel('Add a tool result after every assistant message in both conversations.',{exact:true}).check();
      await providerGuide.locator('.cw-check',{has:providerGuide.getByLabel('Add a tool result after every assistant message in both conversations.',{exact:true})}).getByRole('button',{name:'Check answer',exact:true}).click();
      await expect(providerGuide.getByText('Try again. Ordinary assistant text does not itself request a tool. The obligation follows the tool calls and their IDs.',{exact:true})).toBeVisible();
      const checkedState=await apiJson(request,providerRuntime,'/api/state');
      expect((checkedState.attempts as any[]).at(-1)).toMatchObject({module_id:'s01',phase_id:'self-check',check_id:'call-accounting',option_id:'every-assistant',correct:false});
      await providerPage.screenshot({path:testInfo.outputPath('installed-check-feedback.png')});
      await providerGuide.getByLabel('Ask a question').fill('Preserve this draft across an installed context failure.');
      await providerPage.locator('iframe[title="CourseWeave guide"]').evaluate(node=>{ (window as any).__pilotGuideWindow=(node as HTMLIFrameElement).contentWindow; });
      let failContext=true,holdContext=false;
      let releaseContext:(()=>void)|undefined;
      const recoveryContexts:Array<Record<string,any>>=[];
      await providerPage.route('**/courseweave/context',async route=>{
        if(route.request().method()!=='POST')return route.continue();
        recoveryContexts.push(route.request().postDataJSON());
        if(failContext){failContext=false;return route.fulfill({status:503,contentType:'application/json',body:'{"code":"backend_unavailable"}'});}
        if(holdContext)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,15000);releaseContext=()=>{clearTimeout(timer);resolve();};});
        await route.continue();
      });
      await notebookActivity.getByRole('button',{name:'Open notebook: predict, attempt, observe',exact:true}).click();
      await expect(providerPage.locator('[data-courseweave-recovery]')).toBeVisible();
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
      await providerPage.locator('.jp-Notebook .jp-Cell',{hasText:'Experiment 2 — drop the assistant message'}).click();
      holdContext=true;
      await openGuideCommand(providerPage);
      await expect.poll(()=>releaseContext!==undefined).toBe(true);
      expect(recoveryContexts.at(-1)!.active_cell_id).toBe('69a77fc3');
      await expect(providerPage.locator('[data-courseweave-recovery]')).toBeVisible();
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
      holdContext=false;releaseContext!();releaseContext=undefined;
      await expect(providerPage.locator('[data-courseweave-recovery]')).toHaveCount(0);
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
      await expect(providerGuide.getByLabel('Ask a question')).toHaveValue('Preserve this draft across an installed context failure.');
      expect(await providerPage.locator('iframe[title="CourseWeave guide"]').evaluate(node=>(window as any).__pilotGuideWindow===(node as HTMLIFrameElement).contentWindow)).toBe(true);
      await providerPage.route('**/api/guide',async route=>{await providerPage.unroute('**/api/guide');await route.fulfill({status:401,contentType:'application/json',body:'{"code":"unauthorized","message":"Reconnect","details":{}}'});});
      await providerGuide.getByRole('button',{name:'Send',exact:true}).click();
      await expect(providerGuide.getByRole('button',{name:'Reconnect',exact:true})).toBeVisible();
      await providerGuide.getByLabel('Ask a question').fill('Preserve this second draft across Learn Reconnect.');
      failContext=true;
      await providerPage.locator('.jp-Notebook .jp-Cell').first().click();
      await expect(providerPage.locator('[data-courseweave-recovery]')).toBeVisible();
      await providerPage.locator('.jp-Notebook .jp-Cell',{hasText:'Experiment 2 — drop the assistant message'}).click();
      holdContext=true;
      await providerGuide.getByRole('button',{name:'Reconnect',exact:true}).click();
      await expect.poll(()=>releaseContext!==undefined).toBe(true);
      await expect(providerPage.locator('[data-courseweave-recovery]')).toBeVisible();
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
      expect(recoveryContexts.at(-1)!.active_cell_id).toBe('69a77fc3');
      await providerPage.screenshot({path:testInfo.outputPath('installed-reconnect-pending.png')});
      holdContext=false;releaseContext!();releaseContext=undefined;
      await expect(providerPage.locator('[data-courseweave-recovery]')).toHaveCount(0);
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
      await expect(providerGuide.getByLabel('Ask a question')).toHaveValue('Preserve this second draft across Learn Reconnect.');
      expect(await providerPage.locator('iframe[title="CourseWeave guide"]').evaluate(node=>(window as any).__pilotGuideWindow===(node as HTMLIFrameElement).contentWindow)).toBe(true);
      expect(new Set(guideRequests.map(r=>r.threadId)).size).toBe(1);
      await providerPage.unroute('**/courseweave/context');
      await providerPage.locator('.jp-SideBar [title="CourseWeave guide rail"]').click();
      await expect(providerPage.locator('iframe[title="CourseWeave guide"]')).toBeHidden();
      await openGuideCommand(providerPage);
      await expect(providerPage.locator('iframe[title="CourseWeave guide"]')).toBeVisible();
      await expect(providerGuide.getByLabel('Ask a question')).toHaveValue('Preserve this second draft across Learn Reconnect.');
      expect(await providerPage.locator('iframe[title="CourseWeave guide"]').evaluate(node=>(window as any).__pilotGuideWindow===(node as HTMLIFrameElement).contentWindow)).toBe(true);
      await providerPage.setViewportSize({width:1000,height:720});
      await providerGuide.getByText('Course contents',{exact:true}).click();
      await providerGuide.getByLabel('Ask a question').focus();
      await providerGuide.getByLabel('Ask a question').press('Tab');
      await expect(providerGuide.getByRole('button',{name:'Send',exact:true})).toBeFocused();
      const layout=await providerGuide.locator('[data-testid="learn-rail"]').evaluate(rail=>({width:rail.clientWidth,noOverflow:rail.scrollWidth<=rail.clientWidth,transcriptHeight:rail.querySelector('.cw-transcript')!.clientHeight,composerBottom:rail.querySelector('.cw-composer')!.getBoundingClientRect().bottom,height:window.innerHeight,transcriptLive:rail.querySelector('.cw-transcript')!.getAttribute('aria-live'),terminalAtomic:rail.querySelector('[aria-label="Answer updates"]')!.getAttribute('aria-atomic')}));
      expect(layout.noOverflow).toBe(true);expect(layout.composerBottom).toBeLessThanOrEqual(layout.height);expect(layout.transcriptHeight).toBeGreaterThanOrEqual(144);
      await attachEvidence('installed-rail-layout.json',{...layout,assistiveTechnology:'Not exercised; DOM/focus/keyboard evidence only.'});
      await providerPage.screenshot({path:testInfo.outputPath('installed-narrow-keyboard.png')});
      milestone('actual installed open-guide and Learn Reconnect retain iframe/thread/draft until latest cell confirmation; check feedback and narrow keyboard verified');
      const credential = await browserCredentialSnapshot(providerPage, providerRuntime);
      providerWorkspace.scheduleFinalCredentialAudit({
        ...credential,
        browserOutput: JSON.stringify({ providerErrors, providerConsole }),
        locations: providerPage.frames().map((frame) => frame.url()),
        artifactRoots: [testInfo.outputDir],
      });
      expect(providerErrors).toEqual([]);
    });
    const providerAudit = providerWorkspace!.finalAuditResult();
    expect(providerAudit).toEqual({ filesScanned: expect.any(Number), retainedCredentials: 0 });
    expect(providerAudit!.filesScanned).toBeGreaterThan(0);
    milestone(`provider post-stop credential audit scanned ${providerAudit!.filesScanned} files`);
    await expect(providerWorkspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });

    let authorWorkspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
    await usingTestResourceCustody(async (custody) => {
    await custody.acquire(async () => undefined, async () => {
      await verifyAdapterCustody(copy, adapterRoot!, before);
    }, 5);
    const learningBefore = JSON.parse(await readFile(join(copy.courseRoot,'courseweave.json'),'utf8')).modules[0].phases[0].learning;
    const authorProvider=await custody.acquire(()=>startFakeOpenAiProvider({...learningBefore,overview:'Public installed acceptance edit: predict the tool-call obligations before inspecting a transcript.'}), async provider=>{await provider.close();},30);
    authorWorkspace = await custody.acquire(
      () => launchInstalledWorkspace('author', { courseRoot: copy.courseRoot, stateDir: join(copy.courseRoot, '..', 'state'), kernelPython: join(adapterRoot!, '.venv', 'bin', 'python'),providerEnvironment:{COURSEWEAVE_PROVIDER:'openai',OPENAI_MODEL:'stub-model',OPENAI_BASE_URL:authorProvider.baseUrl,OPENAI_API_KEY:'courseweave-local-author-canary',COURSEWEAVE_PROVIDER_PROFILE:'stream-tools-v1',COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS:'30'} }),
      async (ownedWorkspace) => { await ownedWorkspace.close(); },
      0,
    );
    const authorContext = await custody.acquire(() => browser.newContext(), async (ownedContext) => { await ownedContext.close(); }, 20);
    const authorPage = await custody.acquire(() => authorContext.newPage(), async (ownedPage) => { await ownedPage.close(); }, 10);
    milestone('author workspace launched');
    const authorErrors: string[] = [];
    const authorConsole: string[] = [];
    authorPage.on('pageerror', (error) => authorErrors.push(error.message));
    authorPage.on('console', (message) => authorConsole.push(`${message.type()}:${message.text()}`));
      await bootstrap(authorPage, await authorWorkspace.bootstrapUrl());
      await dismissJupyterNews(authorPage);
      const author = authorPage.frameLocator('iframe[title="CourseWeave author"]');
      await expect(author.getByLabel('Course title')).toHaveValue('The Agent Harness Path');
      await author.getByRole('button', { name: 'Add module' }).click();
      await author.getByLabel('New module ID').fill('adapter-browser-proof');
      await author.getByLabel('New module title').fill('Adapter Browser Proof');
      await author.getByRole('button', { name: 'Create module' }).click();
      await expect(author.getByRole('button', { name: 'Select module Adapter Browser Proof' })).toBeVisible();
      await author.getByLabel('Module title').fill('Adapter Browser Proof Edited');
      await author.getByRole('button', { name: 'Add module' }).click();
      await author.getByLabel('New module ID').fill('adapter-delete-me');
      await author.getByLabel('New module title').fill('Adapter Delete Me');
      await author.getByRole('button', { name: 'Create module' }).click();
      await author.getByRole('button', { name: 'Delete module Adapter Delete Me' }).click();
      await expect(author.getByRole('button', { name: 'Select module Adapter Delete Me' })).toHaveCount(0);
      const moveProof = author.getByRole('button', { name: 'Move module Adapter Browser Proof Edited up' });
      await moveProof.click();
      const outlineOrder = await author.locator('[data-outline] button[data-outline-kind="module"]').allTextContents();
      expect(outlineOrder.at(-2)).toBe('Select module Adapter Browser Proof Edited');
      await author.getByRole('button', { name: 'Save course' }).click();
      await expect(author.getByText('Saved exact canonical course bytes.', { exact: true })).toBeVisible();

      const savedManifest = JSON.parse(await readFile(join(copy.courseRoot, 'courseweave.json'), 'utf8')) as { modules: Array<{ id: string; title: string }> };
      expect(savedManifest.modules.at(-2)).toMatchObject({ id: 'adapter-browser-proof', title: 'Adapter Browser Proof Edited' });
      expect(savedManifest.modules.some((module) => module.id === 'adapter-delete-me')).toBe(false);
      milestone('author CRUD, reorder, and canonical save verified');
      await authorPage.reload({ waitUntil: 'domcontentloaded' });
      await dismissJupyterNews(authorPage);
      const reloadedAuthor = authorPage.frameLocator('iframe[title="CourseWeave author"]');
      try { await expect(reloadedAuthor.getByRole('button', { name: 'Select module Adapter Browser Proof Edited' })).toBeVisible({timeout:15_000}); } catch(error) {
        await authorPage.screenshot({path:testInfo.outputPath('author-reload-diagnostic.png')});
        console.log('Author reload diagnostic',JSON.stringify({frames:await authorPage.locator('iframe').evaluateAll(nodes=>nodes.map(node=>({title:node.title,hidden:node.getBoundingClientRect().height===0}))),body:(await authorPage.locator('body').innerText()).slice(0,2000),authorBody:await reloadedAuthor.locator('body').innerText().catch(()=>'<no author>')}));throw error;
      }
      const beforeLearningRaw=await readFile(join(copy.courseRoot,'courseweave.json'),'utf8');
      const beforeLearning=JSON.parse(beforeLearningRaw);
      await reloadedAuthor.getByRole('button',{name:'Select phase Read and trace the theory',exact:true}).first().click();
      await expect(reloadedAuthor.getByText('Selected saved activity: Read and trace the theory',{exact:true})).toBeVisible();
      await reloadedAuthor.getByLabel('Ask the curriculum teacher').fill('Improve only the selected activity Learning overview, preserving its authored objectives, hints, sources, checks and all other course fields.');
      await reloadedAuthor.getByRole('button',{name:'Improve selected activity Learning',exact:true}).click();
      await expect(reloadedAuthor.getByText('Suggested change ready for review.',{exact:true})).toBeVisible();
      expect(await readFile(join(copy.courseRoot,'courseweave.json'),'utf8')).toBe(beforeLearningRaw);
      await reloadedAuthor.getByRole('button',{name:'Save suggested change',exact:true}).click();
      const reviewed=reloadedAuthor.locator('article',{hasText:'Clarify selected activity Learning'});
      await expect(reviewed.getByRole('heading',{name:'Text diff',exact:true})).toBeVisible();
      await expect(reviewed.getByLabel('Edit full manifest')).toBeVisible();
      const proposedLearning=JSON.parse(await reviewed.getByLabel('Edit full manifest').inputValue());
      const expectedLearning=structuredClone(beforeLearning);
      expectedLearning.modules[0].phases[0].learning.overview='Public installed acceptance edit: predict the tool-call obligations before inspecting a transcript.';
      expect(proposedLearning).toEqual(expectedLearning);
      await expect(reviewed).toContainText('Target hash: '+createHash('sha256').update(beforeLearningRaw).digest('hex'));
      await authorPage.screenshot({path:testInfo.outputPath('installed-author-learning-diff.png')});
      await reviewed.getByRole('button',{name:'Accept',exact:true}).click();
      await expect(reviewed).toContainText('Status: accepted');
      expect(JSON.parse(await readFile(join(copy.courseRoot,'courseweave.json'),'utf8'))).toEqual(expectedLearning);
      expect(authorProvider.requests).toHaveLength(2);
      const conflictRuntime=await runtimeCredentials(authorPage);
      const savedResponse=await request.get(`${conflictRuntime.serviceOrigin}/api/course`,{headers:{Authorization:`Bearer ${conflictRuntime.capabilityToken}`}});
      expect(savedResponse.status()).toBe(200);
      const exactEtag=savedResponse.headers().etag!;
      const conflictBytes=await readFile(join(copy.courseRoot,'courseweave.json'),'utf8');
      await reloadedAuthor.getByRole('button',{name:'Select phase Read and trace the theory',exact:true}).first().click();
      await reloadedAuthor.getByLabel('Learning overview').fill('Local unsaved Learning draft kept across exact-byte conflict.');
      // Change only owned copied source whitespace: semantic equality must not bypass exact ETag.
      await import('node:fs/promises').then(fs=>fs.writeFile(join(copy.courseRoot,'courseweave.json'),conflictBytes+'\n'));
      const conflictRequest=authorPage.waitForResponse(r=>r.request().method()==='PUT' && r.url().endsWith('/api/course'));
      await reloadedAuthor.getByRole('button',{name:'Save course',exact:true}).click();
      const conflict=await conflictRequest;
      expect(conflict.status()).toBe(409);
      expect(await conflict.json()).toMatchObject({code:"etag_mismatch"});
      expect(conflict.request().headers()['if-match']).toBe(exactEtag);
      await expect(reloadedAuthor.getByRole('alert',{name:'Remote conflict'})).toBeVisible();
      await expect(reloadedAuthor.getByLabel('Learning overview')).toHaveValue('Local unsaved Learning draft kept across exact-byte conflict.');
      expect(await readFile(join(copy.courseRoot,'courseweave.json'),'utf8')).toBe(conflictBytes+'\n');
      await authorPage.screenshot({path:testInfo.outputPath('installed-author-exact-etag-conflict.png')});
      milestone('installed selected-Learning tool graph, exact scoped diff/accept and whitespace ETag conflict verified');
      const authorRuntime = await runtimeCredentials(authorPage);
      const credential = await browserCredentialSnapshot(authorPage, authorRuntime);
      authorWorkspace.scheduleFinalCredentialAudit({
        ...credential,
        browserOutput: JSON.stringify({ authorErrors, authorConsole }),
        locations: authorPage.frames().map((frame) => frame.url()),
        artifactRoots: [testInfo.outputDir],
      });
      expect(authorErrors).toEqual([]);
    });
    const authorAudit = authorWorkspace!.finalAuditResult();
    expect(authorAudit).toEqual({ filesScanned: expect.any(Number), retainedCredentials: 0 });
    expect(authorAudit!.filesScanned).toBeGreaterThan(0);
    milestone(`author post-stop credential audit scanned ${authorAudit!.filesScanned} files`);
    await expect(authorWorkspace!.cleanupState()).resolves.toEqual({ ownedProcessesAlive: false, ownedRootExists: false });

    expect(unexpectedExternal).toEqual([]);
    expect(videoRequests.length).toBeGreaterThan(0);
    expect(new Set(videoRequests)).toEqual(new Set([videoUrl]));
    milestone('adapter source unchanged and exact-owned cleanup verified');
  });
});

for (const operation of ['reset_state', 'delete_state'] as const) {
  test(`installed privacy ${operation} retires pending authority and dependent replay`, async ({ browser, request }, testInfo) => {
    const adapterRoot = process.env.COURSEWEAVE_ADAPTER_ROOT!;
    const before = await snapshotAdapter(adapterRoot);
    expect(before).toEqual({head: ADAPTER_HEAD, tree: ADAPTER_TREE, status: '', manifestSha256: ADAPTER_MANIFEST_SHA256});
    const wheel = process.env.COURSEWEAVE_TEST_WHEEL!;
    const wheelSha256 = process.env.COURSEWEAVE_TEST_WHEEL_SHA256!;
    expect(wheel, 'Privacy acceptance requires an explicitly selected frozen wheel.').toBeTruthy();
    expect(await fileSha256(wheel)).toBe(wheelSha256);
    const recordText = `PRIVATE-${operation}-READING-EVIDENCE`;
    const oldQuestion = `Explain my saved reading trace ${operation}.`;
    const draft = `Keep my unsent ${operation} question.`;
    const unsentEdit = `Keep my unsent ${operation} proposal edit.`;
    let workspace: Awaited<ReturnType<typeof launchInstalledWorkspace>> | undefined;
    const evidence: Record<string, unknown> = { operation, wheel, wheelSha256, adapter: before, provider: 'local synthetic only' };
    await mkdir(testInfo.outputDir, {recursive:true});
    await usingTestResourceCustody(async (outer) => {
      const copy = await outer.acquire(
        () => prepareCommittedCourseCopy(adapterRoot, {head: ADAPTER_HEAD, tree: ADAPTER_TREE, manifestSha256: ADAPTER_MANIFEST_SHA256}),
        async owned => { await verifyAdapterCustody(owned, adapterRoot, before, true); },
      );
      await usingTestResourceCustody(async custody => {
        const provider = await custody.acquire(startFakeOpenAiProvider, async owned => { await owned.close(); }, 30);
        workspace = await custody.acquire(() => launchInstalledWorkspace('learn', {
          courseRoot: copy.courseRoot, stateDir: join(copy.courseRoot, '..', 'privacy-state'),
          kernelPython: join(adapterRoot, '.venv', 'bin', 'python'),
          providerEnvironment: {COURSEWEAVE_PROVIDER:'openai', OPENAI_MODEL:'stub-model', OPENAI_BASE_URL:provider.baseUrl,
            OPENAI_API_KEY:'courseweave-local-provider-canary', COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS:'30', COURSEWEAVE_PROVIDER_PROFILE:'text-only-v1'},
        }), async owned => { await owned.close(); }, 0);
        const context = await custody.acquire(() => browser.newContext(), async owned => { await owned.close(); }, 20);
        await context.route('https://**/*', route => route.abort());
        const page = await custody.acquire(() => context.newPage(), async owned => { await owned.close(); }, 10);
        const errors: string[] = [], consoleMessages: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => consoleMessages.push(`${message.type()}:${message.text()}`));
        const guideRequests: Record<string, any>[] = [];
        page.on('request', r => { if(r.method()==='POST' && r.url().endsWith('/api/guide')) guideRequests.push(r.postDataJSON()); });
        await bootstrap(page, await workspace.bootstrapUrl());
        await dismissJupyterNews(page);
        let runtime = await runtimeCredentials(page);
        for (const id of ['privacy-completed','privacy-pending','privacy-second']) {
          await apiJson(request, runtime, '/api/proposals', {method:'POST', expectedStatus:201, headers:{'Idempotency-Key':`${operation}-${id}`},
            data:{id, type:'profile_patch',origin:'student_requested',summary:id,target:'learner_profile',payload:{changes:{explanation:'concise'}},target_hash:null}});
        }
        // Complete one real action so removal must retire its persisted retry receipt too.
        const initialState = await apiJson(request,runtime,'/api/state');
        await apiJson(request,runtime,'/api/state',{method:'PATCH',headers:{'Idempotency-Key':`${operation}-consent`},
          data:{origin:'student_requested',expected_revision:initialState.revision,operation:{type:'set_preferences',preferences:{enabled:true}}}});
        const acceptedBody = {expected_revision:1};
        const acceptedKey = `${operation}-completed-accept`;
        await apiJson(request, runtime, '/api/proposals/privacy-completed/accept', {method:'POST',headers:{'Idempotency-Key':acceptedKey},data:acceptedBody});
        await page.reload({waitUntil:'domcontentloaded'});
        await dismissJupyterNews(page);
        runtime = await runtimeCredentials(page);
        const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
        await expect(guide.getByLabel('Current location')).toContainText('Read and trace the theory');
        await guide.getByText('Learning memory & preferences',{exact:true}).click();
        await expect(guide.getByLabel('Use my saved learning evidence for adaptation')).toBeChecked();
        const record = guide.getByLabel('After reading, write a short trace or counterexample and one question to take to the notebook.', {exact:false});
        await record.fill(recordText);
        await record.locator('..').locator('..').getByRole('button',{name:'Save response',exact:true}).click();
        await expect(guide.getByText('Saved response',{exact:true})).toBeVisible();
        await guide.getByLabel('Ask a question').fill(oldQuestion);
        await guide.getByRole('button',{name:'Send',exact:true}).click();
        await expect(guide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','finished');
        expect(provider.requests).toHaveLength(1);
        expect(JSON.stringify(provider.requests[0].body)).toContain(recordText);
        await guide.getByLabel('Ask a question').fill('Continue explaining that trace.');
        await guide.getByRole('button',{name:'Send',exact:true}).click();
        await expect(guide.locator('.cw-transcript article')).toHaveCount(2);
        await expect(guide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','finished');
        expect(provider.requests).toHaveLength(2);
        expect(JSON.stringify(provider.requests[1].body)).toContain(oldQuestion);
        expect(JSON.stringify(provider.requests[1].body)).toContain('local teacher reply');
        const thread = guideRequests[0].threadId;
        const transcript = await guide.locator('.cw-transcript').innerText();
        await guide.getByLabel('Ask a question').fill(draft);
        await guide.getByText('Suggested changes (3)',{exact:true}).click();
        const pending = guide.locator('article',{has:guide.getByRole('heading',{name:'privacy-pending',exact:true})});
        await pending.getByLabel('Edit summary').fill(unsentEdit);
        let heldAction: import('playwright/test').Route | undefined;
        await page.route('**/api/proposals/privacy-pending/accept', async route => { heldAction=route; });
        await pending.getByRole('button',{name:'Accept',exact:true}).click();
        await expect.poll(() => heldAction !== undefined).toBe(true);
        const pendingBody=heldAction!.request().postDataJSON(), pendingKey=heldAction!.request().headers()['idempotency-key'];
        const beforeRemoval=await apiJson(request,runtime,'/api/state');
        const pendingBefore=await apiJson(request,runtime,'/api/proposals') as unknown as Array<Record<string,unknown>>;
        expect(pendingBefore.filter(p=>p.status==='pending').map(p=>p.id)).toEqual(['privacy-pending','privacy-second']);
        // Fetch authentic old state/proposals, but hold their delivery across the UI removal.
        const heldReads: Array<{route:import('playwright/test').Route; response:import('playwright/test').APIResponse}> = [];
        let holdReads=true;
        await page.route(/\/api\/(bootstrap|proposals)$/,async route => {
          if(!holdReads || route.request().method()!=='GET') return route.continue();
          heldReads.push({route,response:await route.fetch()});
        });
        await guide.getByText('Course contents',{exact:true}).click();
        await phaseSection(guide,'The agent loop','Read and trace the theory').getByRole('button',{name:'Open Read the lesson',exact:true}).click();
        await expect.poll(()=>heldReads.length).toBe(2);
        const oldReadState = await heldReads.find(r=>r.route.request().url().endsWith('/api/bootstrap'))!.response.json();
        const oldReadProposals = await heldReads.find(r=>r.route.request().url().endsWith('/api/proposals'))!.response.json();
        expect(oldReadState.revision).toBe(beforeRemoval.revision);
        expect(JSON.stringify(oldReadState)).toContain(recordText);
        expect(oldReadProposals.some((p:any)=>p.id==='privacy-pending'&&p.status==='pending')).toBe(true);
        holdReads=false;
        await guide.getByRole('button',{name:operation==='reset_state'?'Reset learning memory':'Delete saved learning data',exact:true}).click();
        await guide.getByRole('button',{name:'Confirm removal',exact:true}).click();
        await expect(guide.getByText('Saved learning data cleared.',{exact:true})).toBeVisible();
        await expect(guide.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
        await expect(guide.getByLabel('Unsent edit for privacy-pending')).toHaveValue(unsentEdit);
        const afterRemoval=await apiJson(request,runtime,'/api/state');
        expect(afterRemoval.records).toEqual([]);
        expect(afterRemoval.audit).toEqual([]);
        expect(afterRemoval.preferences).toMatchObject({enabled:false,explanation:'balanced'});
        expect(await apiJson(request,runtime,'/api/proposals')).toEqual([]);
        // Send the held action to the actual runtime only after authority was removed.
        const retired=await request.post(`${runtime.serviceOrigin}/api/proposals/privacy-pending/accept`,{
          headers:{Authorization:`Bearer ${runtime.capabilityToken}`,'Idempotency-Key':pendingKey},data:pendingBody});
        expect(retired.status()).toBe(404);
        await heldAction!.fulfill({response:retired});
        for(const held of heldReads) await held.route.fulfill({response:held.response});
        // The completed action's old idempotency key must not resurrect its cached success.
        await apiJson(request,runtime,'/api/proposals/privacy-completed/accept',{method:'POST',headers:{'Idempotency-Key':acceptedKey},data:acceptedBody,expectedStatus:404});
        expect(await apiJson(request,runtime,'/api/state')).toEqual(afterRemoval);
        await expect(guide.getByRole('heading',{name:/^privacy-(pending|second|completed)$/})).toHaveCount(0);
        await expect(guide.getByRole('button',{name:'Reject',exact:true})).toHaveCount(0);
        await expect(guide.getByLabel('Ask a question')).toHaveValue(draft);
        expect(await guide.locator('.cw-transcript').innerText()).toBe(transcript);
        // Exercise real retained-guide recovery after stale delivery, with no page reload.
        const guideNode=await page.locator('iframe[title="CourseWeave guide"]').elementHandle();
        let failContext=true;
        let contextAttempts=0;
        await page.route('**/courseweave/context',async route => {
          contextAttempts++;
          if(failContext) return route.fulfill({status:503,contentType:'application/json',body:'{"message":"Controlled privacy recovery interruption"}'});
          await route.continue();
        });
        await openGuideCommand(page);
        await expect(page.locator('[data-courseweave-recovery]')).toBeVisible();
        await expect(guide.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
        await expect(guide.getByLabel('Ask a question')).toHaveValue(draft);
        expect(await guide.locator('.cw-transcript').innerText()).toBe(transcript);
        failContext=false;
        await openGuideCommand(page);
        await expect(page.locator('[data-courseweave-recovery]')).toHaveCount(0);
        await expect(guide.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
        expect(contextAttempts).toBeGreaterThanOrEqual(2);
        expect(await page.locator('iframe[title="CourseWeave guide"]').evaluate((node,original)=>node===original,guideNode)).toBe(true);
        await expect(guide.getByLabel('Ask a question')).toHaveValue(draft);
        expect(await guide.locator('.cw-transcript').innerText()).toBe(transcript);
        await expect(guide.getByLabel('Unsent edit for privacy-pending')).toHaveValue(unsentEdit);
        await guide.getByRole('button',{name:'Send',exact:true}).click();
        await expect(guide.locator('.cw-transcript article')).toHaveCount(3);
        await expect(guide.locator('.cw-transcript article').last()).toHaveAttribute('data-state','finished');
        expect(guideRequests).toHaveLength(3);
        expect(guideRequests.every(r=>r.threadId===thread)).toBe(true);
        expect(provider.requests).toHaveLength(3);
        const subsequent=JSON.stringify(provider.requests[2].body);
        expect(subsequent).toContain(draft);
        for(const excluded of [recordText,oldQuestion,'Continue explaining that trace.','local teacher reply',unsentEdit]) expect(subsequent).not.toContain(excluded);
        expect(await apiJson(request,runtime,'/api/state')).toEqual(afterRemoval);
        expect(await apiJson(request,runtime,'/api/proposals')).toEqual([]);
        await expect(guide.getByRole('button',{name:'Accept',exact:true})).toHaveCount(0);
        expect(errors).toEqual([]);
        await page.screenshot({path:testInfo.outputPath(`installed-${operation}.png`)});
        Object.assign(evidence,{beforeRevision:beforeRemoval.revision,afterRevision:afterRemoval.revision,pendingBefore:pendingBefore.map(p=>({id:p.id,status:p.status})),
          staleReads:heldReads.map(r=>({path:new URL(r.route.request().url()).pathname,status:r.response.status()})),retiredActionStatus:retired.status(),completedActionReplayStatus:404,
          lateResultsDidNotResurrect:true,unsentProposalEditRetained:true,conversationAndDraftRetained:true,sameIframeAfterRecovery:true,failedContextRecovery:true,contextAttempts,sameThread:true,
          providerRequests:provider.requests.map(r=>r.body),subsequentDependentHistoryExcluded:true,postRemovalStateUnchanged:true});
        await writeFile(testInfo.outputPath(`installed-${operation}.json`),JSON.stringify(evidence,null,2)+'\n');
        workspace.scheduleFinalCredentialAudit({...await browserCredentialSnapshot(page,runtime),browserOutput:JSON.stringify({errors,consoleMessages}),
          locations:page.frames().map(frame=>frame.url()),artifactRoots:[testInfo.outputDir]});
      });
      const audit=workspace!.finalAuditResult();
      expect(audit).toEqual({filesScanned:expect.any(Number),retainedCredentials:0});
      const cleanup=await workspace!.cleanupState();
      expect(cleanup).toEqual({ownedProcessesAlive:false,ownedRootExists:false});
      await verifyAdapterCustody(copy,adapterRoot,before);
      expect(await copy.manifestSha256()).toBe(ADAPTER_MANIFEST_SHA256);
      Object.assign(evidence,{audit,cleanup,sourceUnchanged:true});
    });
    await writeFile(testInfo.outputPath(`installed-${operation}.json`),JSON.stringify(evidence,null,2)+'\n');
    console.log(`Installed privacy ${operation}: pending authority and stale reads retired; dependent history excluded; post-stop custody clean.`);
  });
}
