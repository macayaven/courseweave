import { access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { kill as signalProcess } from 'node:process';
import { fileURLToPath } from 'node:url';

type LaunchMode = 'learn' | 'author';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const noNodePath = (venv: string) => `${join(venv, 'bin')}:/usr/bin:/bin`;

function runtimeEnvironment(owned: string, venv: string, browser: string, socket: string): NodeJS.ProcessEnv {
  return {
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

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  let output = '';
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', () => rejectRun(new Error(`Installed-wheel setup command could not start: ${command}`)));
    child.once('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Installed-wheel setup command failed: ${command}`)));
  });
  return output;
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
  await new Promise<void>((resolveListen, rejectListen) => server.listen(path, () => resolveListen()).once('error', rejectListen));
  return {
    secret,
    close: () => {
      closePromise ??= (async () => {
        if (!settled) {
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          rejectSecret(new Error('Installed-wheel bootstrap handoff closed.'));
        }
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      })();
      return closePromise;
    }
  };
}

async function tokenlessBootstrap(secret: Promise<string>): Promise<{ url: string; jupyterToken(): string | null; close(): Promise<void> }> {
  let server: HttpServer | null = null;
  let jupyterToken: string | null = null;
  let used = false;
  let closePromise: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/bootstrap`;
  server = createHttpServer((request, response) => {
    if (request.url !== '/bootstrap' || used) { response.writeHead(404).end(); return; }
    used = true;
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const target = await Promise.race([
          secret,
          new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10_000); })
        ]);
        if (timer !== undefined) clearTimeout(timer);
        const targetUrl = new URL(target);
        jupyterToken = targetUrl.searchParams.get('token');
        const upstream = await fetch(target, { redirect: 'manual' });
        const destination = new URL(target); destination.search = ''; destination.hash = '';
        const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
        await upstream.body?.cancel();
        response.writeHead(302, { Location: destination.href, ...(cookies.length > 0 ? { 'Set-Cookie': cookies } : {}) }).end();
      } catch {
        if (timer !== undefined) clearTimeout(timer);
        response.writeHead(502).end();
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, rejectListen) => server!.listen(port, '127.0.0.1', resolveListen).once('error', rejectListen));
  return {
    url,
    jupyterToken: () => jupyterToken,
    close: () => {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
      })();
      return closePromise;
    }
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

function assertNoNode(venv: string): void {
  const result = spawnSync('node', ['--version'], { env: { ...process.env, PATH: noNodePath(venv) }, encoding: 'utf8' });
  if (result.error?.code !== 'ENOENT' || result.status !== null) throw new Error('The installed Jupyter child PATH resolves Node.');
}

function processGroupAlive(processGroup: number): boolean {
  try { signalProcess(-processGroup, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new Error(`Owned CourseWeave process-group check failed (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`);
  }
}

async function waitForProcessGroupExit(processGroup: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(processGroup) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return !processGroupAlive(processGroup);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const processGroup = child.pid;
  const signalOwnedGroup = (signal: NodeJS.Signals) => {
    try { signalProcess(-processGroup, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Owned CourseWeave supervisor signal failed.');
    }
  };
  if (!processGroupAlive(processGroup)) return;
  signalOwnedGroup('SIGTERM');
  if (!(await waitForProcessGroupExit(processGroup, 10_000))) {
    signalOwnedGroup('SIGKILL');
    if (!(await waitForProcessGroupExit(processGroup, 15_000))) throw new Error('Owned CourseWeave process group survived bounded cleanup.');
  }
}

export async function launchInstalledWorkspace(mode: LaunchMode, options: { emptyCourse?: boolean } = {}) {
  const owned = await mkdtemp(join(tmpdir(), 'courseweave-installed-wheel-'));
  const courseRoot = join(owned, 'course');
  const wheelRoot = join(owned, 'wheel');
  const venv = join(owned, 'venv');
  const socketPath = join(owned, 'bootstrap.sock');
  const browserHelper = join(owned, 'browser-handoff.py');
  let launchProcess: ChildProcess | null = null;
  let handoff: Awaited<ReturnType<typeof bootstrapSocket>> | null = null;
  let bootstrapProxy: Awaited<ReturnType<typeof tokenlessBootstrap>> | null = null;
  let setupOutput = '';
  let launchOutput = '';
  try {
    await mkdir(courseRoot, { recursive: true });
    await mkdir(join(owned, 'home'));
    await mkdir(join(owned, 'tmp'));
    if (!options.emptyCourse) await makeRichCourse(courseRoot);
    await mkdir(wheelRoot);
    setupOutput += await run('uv', ['build', '--wheel', '--out-dir', wheelRoot], { cwd: repoRoot });
    const wheelName = (await readdir(wheelRoot)).find((entry) => entry.endsWith('.whl'));
    if (wheelName === undefined) throw new Error('Fresh wheel build produced no wheel.');
    setupOutput += await run('uv', ['venv', '--python', '3.11', venv]);
    setupOutput += await run('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), join(wheelRoot, wheelName), 'jupyterlab==4.6.3']);
    assertNoNode(venv);
    const environment = runtimeEnvironment(owned, venv, browserHelper, socketPath);
    const installedPathOutput = await run(join(venv, 'bin', 'python'), ['-c', 'import courseweave; print(courseweave.__file__)'], { env: environment });
    setupOutput += installedPathOutput;
    const installedPath = installedPathOutput.trim();
    if (!installedPath.startsWith(join(venv, 'lib'))) throw new Error('CourseWeave was not imported from the fresh venv.');
    const discovery = await run(join(venv, 'bin', 'jupyter'), ['labextension', 'list'], { env: environment });
    setupOutput += discovery;
    if (!/@courseweave\/lab/.test(discovery)) throw new Error('Installed JupyterLab did not discover @courseweave/lab.');
    handoff = await bootstrapSocket(socketPath);
    await writeFile(browserHelper, `#!${join(venv, 'bin', 'python')}\nimport os, socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(os.environ['COURSEWEAVE_TEST_BOOTSTRAP_SOCKET'])\ns.sendall(sys.argv[-1].encode('utf-8'))\ns.close()\n`, 'utf8');
    await chmod(browserHelper, 0o700);
    const port = await availablePort();
    launchProcess = spawn(join(venv, 'bin', 'courseweave'), [mode === 'learn' ? 'launch' : 'author', '--course-root', courseRoot, '--port', String(port)], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const child = launchProcess;
    const capture = (chunk: Buffer) => {
      if (launchOutput.length < 1_000_000) launchOutput += chunk.toString().slice(0, 1_000_000 - launchOutput.length);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', () => { void handoff?.close().catch(() => undefined); });
    child.once('exit', () => { void handoff?.close().catch(() => undefined); });
    bootstrapProxy = await tokenlessBootstrap(handoff.secret);
    let closePromise: Promise<void> | null = null;
    const close = () => {
      closePromise ??= (async () => {
        const results = await Promise.allSettled([stop(child), handoff?.close(), bootstrapProxy?.close()]);
        const stopResult = results[0];
        if (stopResult.status === 'rejected') {
          throw new Error(stopResult.reason instanceof Error ? stopResult.reason.message : 'Owned CourseWeave supervisor cleanup failed.');
        }
        await rm(owned, { recursive: true, force: true });
        if (results.slice(1).some((result) => result.status === 'rejected')) throw new Error('Installed-wheel local transport cleanup failed.');
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
      auditCredentials: async (input: { capabilityToken: string; pageConfig: Record<string, unknown>; storage: string; locations: string[]; artifactRoots?: string[] }) => {
        const jupyterToken = bootstrapProxy!.jupyterToken();
        if (jupyterToken === null || jupyterToken.length === 0 || input.capabilityToken.length === 0) throw new Error('Installed-wheel credential audit could not obtain both credentials.');
        if (input.pageConfig.token !== jupyterToken) throw new Error('Installed-wheel PageConfig did not contain the expected standard Jupyter token.');
        if (JSON.stringify(input.pageConfig).includes(input.capabilityToken)) throw new Error('CourseWeave capability entered PageConfig.');
        const forbidden = [jupyterToken, input.capabilityToken];
        if ([input.storage, ...input.locations, setupOutput, launchOutput].some((value) => forbidden.some((credential) => value.includes(credential)))) {
          throw new Error('Installed-wheel credential entered storage, URL, or captured output.');
        }
        let filesScanned = await scanFiles(owned, forbidden);
        for (const root of input.artifactRoots ?? []) filesScanned += await scanFiles(root, forbidden);
        return { filesScanned, retainedCredentials: 0 };
      },
      courseManifestExists: async () => access(join(courseRoot, 'courseweave.json')).then(() => true, () => false),
      coursePrivateStateExists: async () => access(join(courseRoot, '.courseweave')).then(() => true, () => false),
      terminalSentinelExists: async () => access(join(courseRoot, 'terminal-argv-must-not-run')).then(() => true, () => false),
      courseFiles: async () => {
        const files: string[] = [];
        for (const name of await readdir(courseRoot, { recursive: true })) {
          if ((await stat(join(courseRoot, name))).isFile()) files.push(name);
        }
        return files.sort();
      },
      cleanupState: async () => ({
        processGroupAlive: child.pid === undefined ? false : processGroupAlive(child.pid),
        ownedRootExists: await access(owned).then(() => true, () => false)
      }),
      close,
    };
  } catch (error) {
    const results = await Promise.allSettled([launchProcess === null ? Promise.resolve() : stop(launchProcess), handoff?.close(), bootstrapProxy?.close()]);
    if (results[0]?.status === 'fulfilled') await rm(owned, { recursive: true, force: true });
    if (results[0]?.status === 'rejected') throw new Error('Owned CourseWeave supervisor cleanup failed.');
    throw error;
  }
}
