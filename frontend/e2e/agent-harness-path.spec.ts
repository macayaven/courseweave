import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type FrameLocator, type Page } from 'playwright/test';

import { launchInstalledWorkspace, prepareCommittedCourseCopy, usingTestResourceCustody } from './installed-wheel-helpers';

const ADAPTER_HEAD = 'dca20eb6118ef547484198d2982110d3f770649f';
const ADAPTER_TREE = '4c56c4a019f35995cc08ef16a11b0f1e0638dcc3';
const ADAPTER_MANIFEST_SHA256 = '04913b4a6de5673d6b46c2372144fa6662cd88e4b8f5218aeda8043c9c9c3303';

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
  const runtime = await page.evaluate(async (id) => {
    const response = await fetch('courseweave/runtime', { headers: { 'X-CourseWeave-Runtime-ID': id } });
    return response.json() as Promise<{ capabilityToken: string; serviceOrigin: string }>;
  }, runtimeId);
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

async function startFakeOpenAiProvider() {
  const requests: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* rejected below */ }
      requests.push({ path: incoming.url ?? '', authorization: incoming.headers.authorization, body });
      if (incoming.method !== 'POST' || incoming.url?.split('?', 1)[0] !== '/v1/chat/completions' || body.stream !== true) {
        const error = Buffer.from('{"error":{"message":"unexpected local test request"}}');
        response.writeHead(400, { 'content-type': 'application/json', 'content-length': error.length }).end(error);
        return;
      }
      const events = Buffer.from([
        'data: {"choices":[{"delta":{"content":"local teacher "}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
      response.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': events.length }).end(events);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => server.listen(0, '127.0.0.1', resolveListen).once('error', rejectListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Could not bind the local fake provider.');
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose, rejectClose) => (
          server as HttpServer
        ).close((error) => error ? rejectClose(error) : resolveClose()));
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      try {
        await new Promise<void>((resolveClose, rejectClose) => server.close((closeError) => (
          closeError ? rejectClose(closeError) : resolveClose()
        )));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Local fake provider setup failed and cleanup also failed.',
          { cause: error },
        );
      }
    }
    throw error;
  }
}

test.describe.configure({ timeout: 300_000, mode: 'serial' });

test('proves the installed platform end to end against the exact Agent Harness Path adapter', async ({ browser, request }, testInfo) => {
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
    page.on('console', (message) => consoleMessages.push(`${message.type()}:${message.text()}`));
      await bootstrap(page, await workspace.bootstrapUrl());
      const guide = page.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(guide.locator('body')).toContainText('The Agent Harness Path');

      await expect(guide.getByRole('region', { name: 'Reading' })).toContainText('Read the agent-loop lesson');
      await guide.getByLabel('Ask the teacher').fill('Explain the agent loop without a configured provider.');
      await guide.getByRole('button', { name: 'Ask teacher' }).click();
      await expect(guide.getByLabel('Teacher thread').getByText('Teacher unavailable', { exact: true })).toBeVisible();
      await expect(guide.getByRole('region', { name: 'Course dashboard' })).toContainText('The agent loop');

      await phaseSection(guide, 'The agent loop', 'Read the agent-loop lesson').getByRole('button', { name: 'Open lesson' }).click();
      const reader = page.locator('iframe[title="CourseWeave reader"]');
      await expect(reader).toHaveAttribute('src', /\/courseweave\/files\/lessons\/S01-agent-loop\.html$/);
      await expect.poll(() => page.frames().some((frame) => /\/courseweave\/files\/lessons\/S01-agent-loop\.html$/.test(frame.url()))).toBe(true);
      const lessonFrame = page.frames().find((frame) => /\/courseweave\/files\/lessons\/S01-agent-loop\.html$/.test(frame.url()));
      await expect(lessonFrame!.locator('h1')).toHaveText('S01-agent-loop — The agent loop');

      await phaseSection(guide, 'The agent loop', 'Watch the agent-loop overview').getByRole('button', { name: 'Open video' }).click();
      await expect(reader).toHaveAttribute('src', videoUrl);
      await expect.poll(() => videoRequests.length).toBeGreaterThan(0);
      expect(new Set(videoRequests)).toEqual(new Set([videoUrl]));

      await phaseSection(guide, 'The agent loop', 'Predict the loop failures').getByRole('button', { name: 'Open notebook-predict' }).click();
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
      expect(await cellResponse.json()).toMatchObject({ module_id: 's01', phase_id: 'predict', surface_id: 'notebook-predict', reason: 'cell_id' });
      await expect(guide.getByRole('region', { name: 'Prediction prompt' })).toContainText('Predict the loop failures');
      await guide.getByLabel('Your prediction').fill('Dropping the assistant tool call breaks tool-result pairing.');
      await guide.getByRole('button', { name: 'Save prediction' }).click();
      await expect(guide.getByText('Prediction recorded', { exact: true })).toBeVisible();

      const runtime = await runtimeCredentials(page);
      const predictedState = await apiJson(request, runtime, '/api/state');
      expect(predictedState.predictions).toMatchObject({
        's01/predict/s01-prediction': {
          type: 'record_prediction',
          module_id: 's01',
          phase_id: 'predict',
          record_id: 's01-prediction',
          text: 'Dropping the assistant tool call breaks tool-result pairing.',
        },
      });

      await phaseSection(guide, 'The agent loop', 'Build the optional trivia-host loop').getByRole('button', { name: 'Open lab-guide' }).click();
      await expect(page.locator('.lm-TabBar-tabLabel', { hasText: 's01_loop.md' })).toBeVisible();
      await expect(page.locator('.jp-RenderedMarkdown', { hasText: 'S01 lab — the trivia-host loop' })).toBeVisible();
      await phaseSection(guide, 'The agent loop', 'Build the optional trivia-host loop').getByRole('button', { name: 'Open loop-source' }).click();
      await expect(page.locator('.jp-MainAreaWidget:visible .cm-content', { hasText: 'def run_loop' })).toBeVisible();
      await phaseSection(guide, 'The agent loop', 'Build the optional trivia-host loop').getByRole('button', { name: 'Open Copy the offline S01 replay command' }).click();
      const terminalInstructions = page.locator('[data-courseweave-terminal-instructions]');
      const expectedTerminal = JSON.stringify({
        cwd: '.',
        argv: ['uv', 'run', 'python', 'labs/run.py', '--session', 's01', '--replay'],
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
        data: { id: 'adapter-reject', type: 'profile_patch', origin: 'student_requested', summary: 'Reject adapter profile change', target: 'learner_profile', payload: { changes: { rejected_preference: 'must-not-apply' } }, target_hash: null },
      });
      await apiJson(request, runtime, '/api/proposals', {
        method: 'POST', expectedStatus: 201, headers: { 'Idempotency-Key': 'adapter-accept-create' },
        data: { id: 'adapter-accept', type: 'profile_patch', origin: 'student_requested', summary: 'Accept adapter profile change', target: 'learner_profile', payload: { changes: { adapter_proof: 'edited-once' } }, target_hash: null },
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      const refreshedGuide = page.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(refreshedGuide.locator('body')).toContainText('The Agent Harness Path');
      const rejected = refreshedGuide.locator('article', { hasText: 'Reject adapter profile change' });
      await rejected.getByRole('button', { name: 'Reject' }).click();
      await expect(rejected).toContainText('Status: rejected');
      const afterReject = await apiJson(request, await runtimeCredentials(page), '/api/state');
      expect(afterReject.profile).toEqual({});
      expect(afterReject.audit).toContainEqual(expect.objectContaining({ proposal_id: 'adapter-reject', proposal_revision: 1, status: 'rejected' }));
      expect(await fileSha256(join(copy.courseRoot, 'courseweave.json'))).toBe(manifestBeforeProposals);

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
      expect(afterAccept.profile).toEqual({ adapter_proof: 'edited-once' });
      expect(afterAccept.revision).toBe((afterReject.revision as number) + 1);
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
      await refreshedGuide.getByLabel('Ask the teacher').fill('This request crosses an intentional backend interruption.');
      await refreshedGuide.getByRole('button', { name: 'Ask teacher' }).click();
      await expect(refreshedGuide.getByText('Teacher connection interrupted. Your draft is unsent.', { exact: true })).toBeVisible();
      milestone('backend interruption preserved the draft');
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
        providerEnvironment: {
          COURSEWEAVE_PROVIDER: 'openai',
          OPENAI_MODEL: 'stub-model',
          OPENAI_BASE_URL: fakeProvider.baseUrl,
          OPENAI_API_KEY: 'courseweave-local-provider-canary',
          COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS: '5',
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
    providerPage.on('pageerror', (error) => providerErrors.push(error.message));
    providerPage.on('console', (message) => providerConsole.push(`${message.type()}:${message.text()}`));
      await bootstrap(providerPage, await providerWorkspace.bootstrapUrl());
      const providerGuide = providerPage.frameLocator('iframe[title="CourseWeave guide"]');
      await expect(providerGuide.getByRole('region', { name: 'Reading' })).toContainText('Read the agent-loop lesson');
      const providerRuntime = await runtimeCredentials(providerPage);
      const reloadedState = await apiJson(request, providerRuntime, '/api/state');
      expect(reloadedState.predictions).toMatchObject({ 's01/predict/s01-prediction': { text: 'Dropping the assistant tool call breaks tool-result pairing.' } });
      expect(reloadedState.profile).toEqual({ adapter_proof: 'edited-once' });
      expect(reloadedState.audit).toEqual([
        { sequence: 1, proposal_id: 'adapter-reject', proposal_revision: 1, status: 'rejected', proposal_type: 'profile_patch' },
        { sequence: 2, proposal_id: 'adapter-accept', proposal_revision: 2, status: 'accepted', proposal_type: 'profile_patch' },
      ]);
      await providerGuide.getByLabel('Ask the teacher').fill('Give one short local explanation of the loop.');
      await providerGuide.getByRole('button', { name: 'Ask teacher' }).click();
      await expect(providerGuide.getByText('local teacher reply', { exact: true })).toBeVisible();
      expect(fakeProvider.requests).toHaveLength(1);
      expect(fakeProvider.requests[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer courseweave-local-provider-canary', body: { stream: true } });
      milestone('authoritative state reload and local provider chat verified');
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
    authorWorkspace = await custody.acquire(
      () => launchInstalledWorkspace('author', { courseRoot: copy.courseRoot }),
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
      const reloadedAuthor = authorPage.frameLocator('iframe[title="CourseWeave author"]');
      await expect(reloadedAuthor.getByRole('button', { name: 'Select module Adapter Browser Proof Edited' })).toBeVisible();
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
