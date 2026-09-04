import { access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OwnedProcessTracker, stopOwnedProcess } from './process-cleanup';

type LaunchMode = 'learn' | 'author';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const noNodePath = (venv: string) => `${join(venv, 'bin')}:/usr/bin:/bin`;

function runtimeEnvironment(
  owned: string,
  venv: string,
  browser: string,
  socket: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...extra,
    PATH: noNodePath(venv), HOME: join(owned, 'home'), TMPDIR: join(owned, 'tmp'),
    LANG: 'C', LC_ALL: 'C', BROWSER: browser, COURSEWEAVE_TEST_BOOTSTRAP_SOCKET: socket,
  };
}

function capabilities() {
  return {
    chat: false, hint_level: 'none', share_selection: false, share_cell: false,
    share_output: false, create_profile_proposal: false,
    create_course_proposal: false, create_workspace_proposal: false,
  };
}

/** A schema-v1 fixture owned exclusively by this installed-wheel smoke. */
export async function makeRichCourse(root: string): Promise<void> {
  await mkdir(join(root, 'lessons'), { recursive: true });
  await mkdir(join(root, 'notebooks'), { recursive: true });
  await mkdir(join(root, 'source'), { recursive: true });
  await writeFile(join(root, 'lesson.md'), '# Installed markdown\n', 'utf8');
  await writeFile(join(root, 'lessons', 'reader.html'), '<!doctype html><title>Installed reader</title><p>Reader fixture</p>', 'utf8');
  await writeFile(join(root, 'notebooks', 'lab.ipynb'), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }), 'utf8');
  await writeFile(join(root, 'source', 'exercise.py'), 'print("fixture source")\n', 'utf8');
  const sentinel = 'terminal-argv-must-not-run';
  const surfaces = [
    { id: 'markdown', type: 'markdown', role: 'primary', path: 'lesson.md' },
    { id: 'html', type: 'html', role: 'reference', path: 'lessons/reader.html' },
    { id: 'video', type: 'video', role: 'reference', url: 'https://video.example.test/video.mp4' },
    { id: 'notebook', type: 'notebook', role: 'exercise', path: 'notebooks/lab.ipynb' },
    { id: 'source', type: 'source', role: 'exercise', path: 'source/exercise.py' },
    { id: 'terminal', type: 'terminal', role: 'exercise', cwd: '.', argv: ['/usr/bin/touch', sentinel], label: 'Terminal instructions' },
  ];
  await writeFile(join(root, 'courseweave.json'), `${JSON.stringify({
    schema_version: 1, id: 'installed-wheel-rich-course', title: 'Installed wheel rich course',
    description: 'Ephemeral installed-wheel integration fixture.', entry_module_id: 'module',
    policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 8192, workspace_write_globs: [] },
    modules: [{ id: 'module', title: 'Installed module', description: '', phases: [{
      id: 'phase', title: 'Installed phase', kind: 'read', teacher_mode: 'reading_companion',
      surfaces, completion: { type: 'manual' }, capabilities: capabilities(),
    }] }],
  }, null, 2)}\n`, 'utf8');
}

const OUTPUT_LIMIT = 1_000_000;
const SETUP_TIMEOUT_MS = 180_000;

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  let output = '';
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true
  });
  const processTracker = child.pid === undefined ? undefined : new OwnedProcessTracker(child.pid);
  const capture = (chunk: Buffer) => {
    if (output.length < OUTPUT_LIMIT) output += chunk.toString().slice(0, OUTPUT_LIMIT - output.length);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveRun, rejectRun) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolveRun(); else rejectRun(error);
      };
      timer = setTimeout(() => finish(new Error(`Installed-wheel setup command timed out: ${command}`)), SETUP_TIMEOUT_MS);
      child.once('error', () => finish(new Error(`Installed-wheel setup command could not start: ${command}`)));
      child.once('exit', (code) => finish(code === 0 ? undefined : new Error(`Installed-wheel setup command failed: ${command}`)));
    });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await stopOwnedProcess(child, processTracker);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Installed-wheel setup command failed and cleanup also failed.',
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return output;
}

type ResourceCleanup = { priority: number; order: number; close(): Promise<void> };

export type TestResourceCustody = {
  acquire<T>(acquire: () => Promise<T>, close: (resource: T) => Promise<void>, priority?: number): Promise<T>;
};

export async function usingTestResourceCustody<T>(
  body: (custody: TestResourceCustody) => Promise<T>,
): Promise<T> {
  const cleanups: ResourceCleanup[] = [];
  let nextOrder = 0;
  const custody: TestResourceCustody = {
    acquire: async (acquire, close, priority = 0) => {
      const resource = await acquire();
      cleanups.push({ priority, order: nextOrder++, close: () => close(resource) });
      return resource;
    },
  };
  let completed = false;
  let result: T | undefined;
  let primaryFailure: unknown;
  try {
    result = await body(custody);
    completed = true;
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanups.sort((left, right) => left.priority - right.priority || left.order - right.order)) {
    try { await cleanup.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (!completed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        'Test failed and resource cleanup also failed.',
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Test resource cleanup failed.');
  }
  return result as T;
}

type CommittedCourseExpectation = {
  head: string;
  tree: string;
  manifestSha256: string;
};

type CommittedCourseSnapshot = CommittedCourseExpectation & { status: string };

const readOnlyGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
});

async function committedCourseSnapshot(sourceRoot: string): Promise<CommittedCourseSnapshot> {
  const git = async (args: string[]) => (
    await run('git', ['-C', sourceRoot, ...args], { env: readOnlyGitEnvironment() })
  ).trim();
  return {
    head: await git(['rev-parse', 'HEAD']),
    tree: await git(['rev-parse', 'HEAD^{tree}']),
    status: await git(['status', '--porcelain=v1', '--untracked-files=all']),
    manifestSha256: createHash('sha256').update(await readFile(join(sourceRoot, 'courseweave.json'))).digest('hex'),
  };
}

export async function prepareCommittedCourseCopy(
  sourceRoot: string,
  expected: CommittedCourseExpectation,
) {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-installed-adapter-copy-'));
  const courseRoot = join(owned, 'course');
  const archive = join(owned, 'adapter.tar');
  try {
    const sourceSnapshot = await committedCourseSnapshot(sourceRoot);
    if (sourceSnapshot.status !== ''
      || sourceSnapshot.head !== expected.head
      || sourceSnapshot.tree !== expected.tree
      || sourceSnapshot.manifestSha256 !== expected.manifestSha256) {
      throw new Error('Installed-adapter source does not match the expected clean commit.');
    }
    await mkdir(courseRoot);
    await run('git', ['-C', sourceRoot, 'archive', '--format=tar', '--output', archive, expected.head], {
      env: readOnlyGitEnvironment(),
    });
    await run('tar', ['-xf', archive, '-C', courseRoot]);
    await rm(archive, { force: true });
    const copiedManifestSha256 = createHash('sha256').update(await readFile(join(courseRoot, 'courseweave.json'))).digest('hex');
    if (copiedManifestSha256 !== expected.manifestSha256) {
      throw new Error('Installed-adapter committed archive did not reproduce the expected manifest.');
    }
    const after = await committedCourseSnapshot(sourceRoot);
    if (JSON.stringify(after) !== JSON.stringify(sourceSnapshot)) {
      throw new Error('Installed-adapter source changed while its committed archive was copied.');
    }
    let closePromise: Promise<void> | null = null;
    return {
      courseRoot,
      sourceSnapshot,
      manifestSha256: async () => createHash('sha256').update(await readFile(join(courseRoot, 'courseweave.json'))).digest('hex'),
      verifySourceUnchanged: async () => {
        const current = await committedCourseSnapshot(sourceRoot);
        if (JSON.stringify(current) !== JSON.stringify(sourceSnapshot)) {
          throw new Error('Installed-adapter source changed during the browser proof.');
        }
        return current;
      },
      close: () => {
        closePromise ??= rm(owned, { recursive: true, force: true });
        return closePromise;
      },
    };
  } catch (error) {
    try { await rm(owned, { recursive: true, force: true }); }
    catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Installed-adapter copy setup failed and cleanup also failed.',
        { cause: error },
      );
    }
    throw error;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => server.once('error', rejectListen).listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  if (address === null || typeof address === 'string') throw new Error('Could not reserve a loopback port.');
  return address.port;
}

async function bootstrapSocket(path: string): Promise<{ secret: Promise<string>; close(): Promise<void> }> {
  const server = createServer();
  const sockets = new Set<Socket>();
  let settled = false;
  let rejectSecret: (reason?: unknown) => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | null = null;
  const secret = new Promise<string>((resolveSecret, reject) => {
    rejectSecret = reject;
    timer = setTimeout(() => fail(new Error('Installed-wheel bootstrap handoff timed out.')), 30_000);
    const fail = (reason: unknown) => {
      if (!settled) { settled = true; if (timer !== undefined) clearTimeout(timer); reject(reason); }
    };
    server.once('error', fail);
    server.once('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        const received = Buffer.concat(chunks).toString('utf8');
        if (!/^https?:\/\//.test(received)) reject(new Error('Installed-wheel bootstrap handoff failed.'));
        else resolveSecret(received);
      });
      socket.once('error', () => fail(new Error('Installed-wheel bootstrap handoff failed.')));
    });
  });
  void secret.catch(() => undefined);
  const close = () => {
    closePromise ??= (async () => {
      if (!settled) {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        rejectSecret(new Error('Installed-wheel bootstrap handoff closed.'));
      }
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (
          error ? rejectClose(error) : resolveClose()
        )));
      }
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolveListen, rejectListen) => server.listen(path, () => resolveListen()).once('error', rejectListen));
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Installed-wheel bootstrap handoff setup failed and cleanup also failed.',
        { cause: error },
      );
    }
    throw error;
  }
  return {
    secret,
    close,
  };
}

async function tokenlessBootstrap(
  secret: Promise<string>,
  onBootstrap?: () => void
): Promise<{ url: string; jupyterToken(): string | null; close(): Promise<void> }> {
  let server: HttpServer | null = null;
  let jupyterToken: string | null = null;
  let used = false;
  let closePromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const fetches = new Set<AbortController>();
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/bootstrap`;
  server = createHttpServer((request, response) => {
    if (request.url !== '/bootstrap' || used) { response.writeHead(404).end(); return; }
    used = true;
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fetchTimer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      try {
        const target = await Promise.race([
          secret,
          new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10_000); })
        ]);
        if (timer !== undefined) clearTimeout(timer);
        const targetUrl = new URL(target);
        jupyterToken = targetUrl.searchParams.get('token');
        controller = new AbortController();
        fetches.add(controller);
        fetchTimer = setTimeout(() => controller?.abort(), 10_000);
        const upstream = await fetch(target, { redirect: 'manual', signal: controller.signal });
        onBootstrap?.();
        const destination = new URL(target); destination.search = ''; destination.hash = '';
        const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
        await upstream.body?.cancel();
        response.writeHead(302, { Location: destination.href, ...(cookies.length > 0 ? { 'Set-Cookie': cookies } : {}) }).end();
      } catch {
        response.writeHead(502).end();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (fetchTimer !== undefined) clearTimeout(fetchTimer);
        if (controller !== undefined) fetches.delete(controller);
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const close = () => {
    closePromise ??= (async () => {
      for (const controller of fetches) controller.abort();
      for (const socket of sockets) socket.destroy();
      if (server!.listening) {
        await new Promise<void>((resolveClose, rejectClose) => server!.close((error) => (
          error ? rejectClose(error) : resolveClose()
        )));
      }
    })();
    return closePromise;
  };
  try {
    await new Promise<void>((resolveListen, rejectListen) => server!.listen(port, '127.0.0.1', resolveListen).once('error', rejectListen));
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Installed-wheel tokenless bootstrap setup failed and cleanup also failed.',
        { cause: error },
      );
    }
    throw error;
  }
  return {
    url,
    jupyterToken: () => jupyterToken,
    close,
  };
}

export async function failingBootstrapProxy(secretToken: string): Promise<{ url: string; close(): Promise<void> }> {
  const proxy = await tokenlessBootstrap(Promise.resolve(`http://127.0.0.1:9/lab?token=${encodeURIComponent(secretToken)}`));
  return { url: proxy.url, close: proxy.close };
}

async function scanFiles(root: string, credentials: readonly string[]): Promise<number> {
  const needles = credentials.filter((credential) => credential.length > 0).map((credential) => Buffer.from(credential));
  let files = 0;
  let names: string[];
  try { names = await readdir(root, { recursive: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (name === undefined) return;
      const path = join(root, name);
      try {
        if (!(await lstat(path)).isFile()) continue;
        files += 1;
        const bytes = await readFile(path);
        if (needles.some((needle) => bytes.includes(needle))) {
          throw new Error('Installed-wheel credential scan found a retained credential.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, worker));
  return files;
}

export type CredentialAuditInput = {
  capabilityToken: string;
  pageConfig: Record<string, unknown>;
  storage: string;
  browserOutput: string;
  locations: string[];
  artifactRoots?: string[];
};

export type CredentialAuditResult = { filesScanned: number; retainedCredentials: 0 };

function assertNoNode(venv: string): void {
  const result = spawnSync('node', ['--version'], { env: { ...process.env, PATH: noNodePath(venv) }, encoding: 'utf8' });
  if (result.error?.code !== 'ENOENT' || result.status !== null) throw new Error('The installed Jupyter child PATH resolves Node.');
}

export async function launchInstalledWorkspace(mode: LaunchMode, options: {
  emptyCourse?: boolean;
  courseRoot?: string;
  providerEnvironment?: Record<string, string>;
  terminalCommandCanary?: { executable: string; markerName: string };
  shutdownCredentialCanary?: { value: string; fileName: string };
} = {}) {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-installed-wheel-'));
  const courseRoot = options.courseRoot ?? join(owned, 'course');
  const wheelRoot = join(owned, 'wheel');
  const venv = join(owned, 'venv');
  const socketPath = join(owned, 'bootstrap.sock');
  const browserHelper = join(owned, 'browser-handoff.py');
  const constraints = join(owned, 'constraints.txt');
  let launchProcess: ChildProcess | null = null;
  let handoff: Awaited<ReturnType<typeof bootstrapSocket>> | null = null;
  let bootstrapProxy: Awaited<ReturnType<typeof tokenlessBootstrap>> | null = null;
  let setupOutput = '';
  let launchOutput = '';
  let launchTracker: OwnedProcessTracker | undefined;
  try {
    await mkdir(courseRoot, { recursive: true });
    await mkdir(join(owned, 'home'));
    await mkdir(join(owned, 'tmp'));
    if (options.courseRoot === undefined && !options.emptyCourse) await makeRichCourse(courseRoot);
    await mkdir(wheelRoot);
    setupOutput += await run('uv', ['build', '--wheel', '--out-dir', wheelRoot], { cwd: repoRoot });
    const wheelName = (await readdir(wheelRoot)).find((entry) => entry.endsWith('.whl'));
    if (wheelName === undefined) throw new Error('Fresh wheel build produced no wheel.');
    setupOutput += await run('uv', ['venv', '--python', '3.11', venv]);
    setupOutput += await run('uv', ['export', '--frozen', '--all-groups', '--no-emit-project', '--no-hashes', '--output-file', constraints], { cwd: repoRoot });
    setupOutput += await run('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), '--constraint', constraints, join(wheelRoot, wheelName), 'jupyterlab==4.6.3', 'jupyter-server==2.21.0']);
    assertNoNode(venv);
    if (options.terminalCommandCanary !== undefined) {
      const canaryPath = join(venv, 'bin', options.terminalCommandCanary.executable);
      const markerPath = join(courseRoot, options.terminalCommandCanary.markerName);
      await writeFile(canaryPath, `#!${join(venv, 'bin', 'python')}\nfrom pathlib import Path\nPath(${JSON.stringify(markerPath)}).write_text('executed\\n', encoding='utf-8')\nraise SystemExit(97)\n`, 'utf8');
      await chmod(canaryPath, 0o700);
    }
    const environment = runtimeEnvironment(owned, venv, browserHelper, socketPath, options.providerEnvironment);
    const installedPathOutput = await run(join(venv, 'bin', 'python'), ['-c', 'import courseweave; print(courseweave.__file__)'], { env: environment });
    setupOutput += installedPathOutput;
    const installedPath = installedPathOutput.trim();
    if (!installedPath.startsWith(join(venv, 'lib'))) throw new Error('CourseWeave was not imported from the fresh venv.');
    const installedVersions = JSON.parse(await run(join(venv, 'bin', 'python'), ['-c', "import json; from importlib.metadata import version; print(json.dumps({'jupyterlab': version('jupyterlab'), 'jupyter-server': version('jupyter-server')}))"], { env: environment })) as Record<string, string>;
    if (installedVersions.jupyterlab !== '4.6.3' || installedVersions['jupyter-server'] !== '2.21.0') throw new Error('Installed Jupyter versions do not match the tested runtime contract.');
    const discovery = await run(join(venv, 'bin', 'jupyter'), ['labextension', 'list'], { env: environment });
    setupOutput += discovery;
    if (!/@courseweave\/lab/.test(discovery)) throw new Error('Installed JupyterLab did not discover @courseweave/lab.');
    handoff = await bootstrapSocket(socketPath);
    await writeFile(browserHelper, `#!${join(venv, 'bin', 'python')}\nimport os, socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(os.environ['COURSEWEAVE_TEST_BOOTSTRAP_SOCKET'])\ns.sendall(sys.argv[-1].encode('utf-8'))\ns.close()\n`, 'utf8');
    await chmod(browserHelper, 0o700);
    const port = await availablePort();
    launchProcess = spawn(join(venv, 'bin', 'courseweave'), [mode === 'learn' ? 'launch' : 'author', '--course-root', courseRoot, '--port', String(port)], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const child = launchProcess;
    if (child.pid === undefined) throw new Error('Installed CourseWeave supervisor did not start.');
    launchTracker = new OwnedProcessTracker(child.pid);
    const capture = (chunk: Buffer) => {
      if (launchOutput.length < OUTPUT_LIMIT) launchOutput += chunk.toString().slice(0, OUTPUT_LIMIT - launchOutput.length);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const childClosed = new Promise<void>((resolveClosed, rejectClosed) => {
      child.once('close', () => resolveClosed());
      child.once('error', () => rejectClosed(new Error('Installed CourseWeave supervisor stream failed.')));
    });
    void childClosed.catch(() => undefined);
    let shutdownCanaryReady: Promise<void> = Promise.resolve();
    if (options.shutdownCredentialCanary !== undefined) {
      if (!/^[A-Za-z0-9._-]+$/.test(options.shutdownCredentialCanary.fileName)) {
        throw new Error('Shutdown credential canary filename is invalid.');
      }
      shutdownCanaryReady = new Promise<void>((resolveCanary, rejectCanary) => {
        child.once('exit', () => {
          void writeFile(
            join(owned, options.shutdownCredentialCanary!.fileName),
            options.shutdownCredentialCanary!.value,
            'utf8',
          ).then(() => resolveCanary(), rejectCanary);
        });
        child.once('error', rejectCanary);
      });
    }
    bootstrapProxy = await tokenlessBootstrap(handoff.secret, () => launchTracker?.refresh());
    let finalAuditInput: CredentialAuditInput | null = null;
    let finalAuditResult: CredentialAuditResult | null = null;
    let closePromise: Promise<CredentialAuditResult | null> | null = null;
    let interrupted = false;
    const waitForStableOutput = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          childClosed,
          new Promise<void>((_, rejectStable) => {
            timer = setTimeout(() => rejectStable(new Error('Installed CourseWeave supervisor streams did not close.')), 5_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      await shutdownCanaryReady;
    };
    const interrupt = async () => {
      if (interrupted) return;
      await stopOwnedProcess(child, launchTracker, { failOnForcedTermination: true });
      await waitForStableOutput();
      interrupted = true;
    };
    const auditCredentials = async (input: CredentialAuditInput): Promise<CredentialAuditResult> => {
      const jupyterToken = bootstrapProxy!.jupyterToken();
      if (jupyterToken === null || jupyterToken.length === 0 || input.capabilityToken.length === 0) throw new Error('Installed-wheel credential audit could not obtain both credentials.');
      if (input.pageConfig.token !== jupyterToken) throw new Error('Installed-wheel PageConfig did not contain the expected standard Jupyter token.');
      if (JSON.stringify(input.pageConfig).includes(input.capabilityToken)) throw new Error('CourseWeave capability entered PageConfig.');
      const configuredCanaries = Object.entries(options.providerEnvironment ?? {})
        .filter(([name]) => name.endsWith('_API_KEY'))
        .map(([, value]) => value);
      const shutdownCanaries = options.shutdownCredentialCanary === undefined ? [] : [options.shutdownCredentialCanary.value];
      const forbidden = [jupyterToken, input.capabilityToken, ...configuredCanaries, ...shutdownCanaries];
      if ([input.storage, input.browserOutput, ...input.locations, setupOutput, launchOutput].some((value) => forbidden.some((credential) => value.includes(credential)))) {
        throw new Error('Installed-wheel credential entered storage, URL, or captured output.');
      }
      let filesScanned = await scanFiles(owned, forbidden);
      if (options.courseRoot !== undefined) filesScanned += await scanFiles(courseRoot, forbidden);
      for (const root of input.artifactRoots ?? []) filesScanned += await scanFiles(root, forbidden);
      return { filesScanned, retainedCredentials: 0 };
    };
    const close = () => {
      closePromise ??= (async () => {
        const failures: unknown[] = [];
        let processStable = interrupted;
        if (!interrupted) {
          try {
            await stopOwnedProcess(child, launchTracker, { failOnForcedTermination: true });
            await waitForStableOutput();
            processStable = true;
          } catch (error) {
            failures.push(error);
          }
        }
        for (const result of await Promise.allSettled([handoff?.close(), bootstrapProxy?.close()])) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
        if (processStable && finalAuditInput !== null) {
          try { finalAuditResult = await auditCredentials(finalAuditInput); }
          catch (error) { failures.push(error); }
        }
        if (processStable) {
          try { await rm(owned, { recursive: true, force: true }); }
          catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Installed-wheel finalization failed.');
        return finalAuditResult;
      })();
      return closePromise;
    };
    return {
      baseUrl: `http://127.0.0.1:${port}/courseweave/`,
      bootstrapUrl: () => bootstrapProxy!.url,
      jupyterBaseUrl: async () => {
        const safe = new URL(await handoff!.secret);
        safe.search = ''; safe.hash = '';
        return new URL('.', safe).href;
      },
      scheduleFinalCredentialAudit: (input: CredentialAuditInput) => {
        if (closePromise !== null) throw new Error('Installed-wheel finalization already started.');
        if (finalAuditInput !== null) throw new Error('Installed-wheel final credential audit already scheduled.');
        finalAuditInput = {
          ...input,
          pageConfig: { ...input.pageConfig },
          locations: [...input.locations],
          artifactRoots: input.artifactRoots === undefined ? undefined : [...input.artifactRoots],
        };
      },
      courseManifestExists: async () => access(join(courseRoot, 'courseweave.json')).then(() => true, () => false),
      coursePrivateStateExists: async () => access(join(courseRoot, '.courseweave')).then(() => true, () => false),
      terminalSentinelExists: async () => access(join(courseRoot, options.terminalCommandCanary?.markerName ?? 'terminal-argv-must-not-run')).then(() => true, () => false),
      shutdownCredentialCanaryExists: async () => options.shutdownCredentialCanary !== undefined
        && access(join(owned, options.shutdownCredentialCanary.fileName)).then(() => true, () => false),
      trackOwnedProcesses: () => { launchTracker?.refresh(); },
      courseFiles: async () => {
        const files: string[] = [];
        for (const name of await readdir(courseRoot, { recursive: true })) {
          if ((await stat(join(courseRoot, name))).isFile()) files.push(name);
        }
        return files.sort();
      },
      cleanupState: async () => ({
        ownedProcessesAlive: (launchTracker?.live().length ?? 0) > 0,
        ownedRootExists: await access(owned).then(() => true, () => false)
      }),
      interrupt,
      finalAuditResult: () => finalAuditResult,
      close,
    };
  } catch (error) {
    const results = await Promise.allSettled([
      launchProcess === null ? Promise.resolve() : stopOwnedProcess(launchProcess, launchTracker),
      handoff?.close(),
      bootstrapProxy?.close(),
    ]);
    const cleanupFailures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (results[0]?.status === 'fulfilled') {
      try { await rm(owned, { recursive: true, force: true }); }
      catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Installed-wheel setup failed and cleanup also failed.',
        { cause: error },
      );
    }
    throw error;
  }
}
