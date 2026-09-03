import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

async function waitForJupyter(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await fetch(`${baseUrl}lab`, { redirect: 'manual' }); return; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  throw new Error('Installed Jupyter supervisor did not become reachable.');
}

async function bootstrapSocket(path: string): Promise<{ secret: Promise<string>; close(): Promise<void> }> {
  const server = createServer();
  let settled = false;
  const secret = new Promise<string>((resolveSecret, reject) => {
    const fail = (reason: unknown) => { if (!settled) { settled = true; reject(reason); } };
    server.once('error', fail);
    server.once('connection', (socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.once('end', () => {
        if (settled) return;
        settled = true;
        const received = Buffer.concat(chunks).toString('utf8');
        if (!/^https?:\/\//.test(received)) reject(new Error('Installed-wheel bootstrap handoff failed.'));
        else resolveSecret(received);
      });
      socket.once('error', () => fail(new Error('Installed-wheel bootstrap handoff failed.')));
    });
  });
  // Cleanup may race a failed start; absorb that internal rejection so it never
  // replaces the bounded bootstrap/navigation error with secret-bearing detail.
  void secret.catch(() => undefined);
  await new Promise<void>((resolveListen, rejectListen) => server.listen(path, () => resolveListen()).once('error', rejectListen));
  return { secret, close: async () => { settled = true; await new Promise<void>((resolveClose) => server.close(() => resolveClose())); } };
}

async function tokenlessBootstrap(secret: Promise<string>): Promise<{ url: string; jupyterToken(): string | null; close(): Promise<void> }> {
  let server: HttpServer | null = null;
  let jupyterToken: string | null = null;
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/bootstrap`;
  server = createHttpServer((request, response) => {
    if (request.url !== '/bootstrap') { response.writeHead(404).end(); return; }
    void (async () => {
      try {
        const target = await Promise.race([secret, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000))]);
        const upstream = await fetch(target, { redirect: 'manual' });
        const destination = new URL(target); destination.search = ''; destination.hash = '';
        jupyterToken = new URL(target).searchParams.get('token');
        const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
        response.writeHead(302, { Location: destination.href, ...(cookies.length > 0 ? { 'Set-Cookie': cookies } : {}) }).end();
      } catch {
        response.writeHead(502).end();
      }
    })();
  });
  await new Promise<void>((resolveListen, rejectListen) => server!.listen(port, '127.0.0.1', resolveListen).once('error', rejectListen));
  return { url, jupyterToken: () => jupyterToken, close: async () => new Promise<void>((resolveClose) => server!.close(() => resolveClose())) };
}

async function scanOwnedFiles(root: string, credentials: readonly string[]): Promise<{ files: number; credentialHits: number }> {
  const needles = credentials.map((credential) => Buffer.from(credential, 'utf8'));
  let files = 0;
  let credentialHits = 0;
  for (const name of await readdir(root, { recursive: true })) {
    const filename = join(root, name);
    if (!(await stat(filename)).isFile()) continue;
    files += 1;
    const bytes = await readFile(filename);
    if (needles.some((needle) => bytes.includes(needle))) credentialHits += 1;
  }
  return { files, credentialHits };
}

function assertNoNode(venv: string): void {
  const result = spawnSync('node', ['--version'], { env: { ...process.env, PATH: noNodePath(venv) }, encoding: 'utf8' });
  if (result.error?.code !== 'ENOENT' || result.status !== null) throw new Error('The installed Jupyter child PATH resolves Node.');
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  if (process.pid === undefined) return;
  const groupId = process.pid;
  const signalOwnedGroup = (signal: NodeJS.Signals) => {
    const result = spawnSync('/bin/kill', [`-${signal.slice(3)}`, `-${groupId}`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    if (result.error === undefined && result.status !== null && (result.status === 0 || /No such process/.test(result.stderr))) return;
    throw new Error('Owned CourseWeave process-group signal failed.');
  };
  const groupAlive = () => {
    // Playwright's Node worker rejects signal zero for a negative PID on
    // macOS. POSIX kill(1) still performs the exact process-group probe.
    const inspection = spawnSync('/bin/kill', ['-0', `-${groupId}`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    if (inspection.error !== undefined || inspection.status === null) {
      throw new Error('Owned CourseWeave process-group inspection failed.');
    }
    if (inspection.status === 0) return true;
    // The group was created by this same-user detached spawn.  BSD kill(1)
    // returns status 1 after that exact group no longer exists.
    if (inspection.status === 1) return false;
    throw new Error('Owned CourseWeave process-group inspection failed.');
  };
  const waitForGroupGone = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (groupAlive()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  if (!groupAlive()) return;
  signalOwnedGroup('SIGTERM');
  if (!(await waitForGroupGone(5_000))) {
    signalOwnedGroup('SIGKILL');
    if (!(await waitForGroupGone(5_000))) {
      throw new Error('Owned CourseWeave process group survived bounded termination.');
    }
  }
}

type OwnedCloseable = { close(): Promise<void> } | null;

interface OwnedCleanup {
  child: ChildProcess | null;
  handoff: OwnedCloseable;
  bootstrapProxy: OwnedCloseable;
  owned: string;
}

async function cleanupOwned(
  resources: OwnedCleanup,
  stopOwned: (child: ChildProcess) => Promise<void> = stop,
  removeOwned: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true }),
): Promise<void> {
  let stopFailure = false;
  if (resources.child !== null) {
    try { await stopOwned(resources.child); } catch { stopFailure = true; }
  }
  const closeResults = await Promise.allSettled([
    resources.handoff?.close(),
    resources.bootstrapProxy?.close(),
  ]);
  if (stopFailure) {
    throw new Error('Owned CourseWeave supervisor cleanup failed.');
  }
  let removeFailure = false;
  try { await removeOwned(resources.owned); } catch { removeFailure = true; }
  if (closeResults.some((result) => result.status === 'rejected') || removeFailure) {
    throw new Error('Installed-wheel non-process cleanup failed.');
  }
}

async function cleanupAfterFailure(
  resources: OwnedCleanup,
  failure: unknown,
  stopOwned?: (child: ChildProcess) => Promise<void>,
  removeOwned?: (path: string) => Promise<void>,
): Promise<never> {
  await cleanupOwned(resources, stopOwned, removeOwned);
  throw failure;
}

async function closeBrowserAndWorkspace(
  closeBrowser: () => Promise<void>,
  closeWorkspace: () => Promise<void>,
): Promise<void> {
  let browserFailed = false;
  let workspaceFailed = false;
  try { await closeBrowser(); } catch { browserFailed = true; }
  try { await closeWorkspace(); } catch { workspaceFailed = true; }
  if (browserFailed && workspaceFailed) {
    throw new Error('Browser and owned workspace cleanup failed.');
  }
  if (workspaceFailed) throw new Error('Owned workspace cleanup failed.');
  if (browserFailed) throw new Error('Browser cleanup failed.');
}

/** Focused failure-path probes use the production cleanup sequence. */
export const installedWheelTestOnly = { cleanupAfterFailure, cleanupOwned, closeBrowserAndWorkspace, stop };

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
  try {
    await mkdir(courseRoot, { recursive: true });
    await mkdir(join(owned, 'home'));
    await mkdir(join(owned, 'tmp'));
    if (!options.emptyCourse) await makeRichCourse(courseRoot);
    await mkdir(wheelRoot);
    await run('uv', ['build', '--wheel', '--out-dir', wheelRoot], { cwd: repoRoot });
    const wheelName = (await readdir(wheelRoot)).find((entry) => entry.endsWith('.whl'));
    if (wheelName === undefined) throw new Error('Fresh wheel build produced no wheel.');
    await run('uv', ['venv', '--python', '3.11', venv]);
    await run('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), join(wheelRoot, wheelName), 'jupyterlab==4.6.3']);
    assertNoNode(venv);
    const environment = runtimeEnvironment(owned, venv, browserHelper, socketPath);
    const installedPath = (await run(join(venv, 'bin', 'python'), ['-c', 'import courseweave; print(courseweave.__file__)'], { env: environment })).trim();
    if (!installedPath.startsWith(join(venv, 'lib'))) throw new Error('CourseWeave was not imported from the fresh venv.');
    const discovery = await run(join(venv, 'bin', 'jupyter'), ['labextension', 'list'], { env: environment });
    if (!/@courseweave\/lab/.test(discovery)) throw new Error('Installed JupyterLab did not discover @courseweave/lab.');
    handoff = await bootstrapSocket(socketPath);
    await writeFile(browserHelper, `#!${join(venv, 'bin', 'python')}\nimport os, socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.connect(os.environ['COURSEWEAVE_TEST_BOOTSTRAP_SOCKET'])\ns.sendall(sys.argv[-1].encode('utf-8'))\ns.close()\n`, 'utf8');
    await chmod(browserHelper, 0o700);
    const port = await availablePort();
    const jupyterBaseUrl = `http://127.0.0.1:${port}/`;
    launchProcess = spawn(join(venv, 'bin', 'courseweave'), [mode === 'learn' ? 'launch' : 'author', '--course-root', courseRoot, '--port', String(port)], { env: environment, stdio: 'ignore', detached: true });
    const child = launchProcess;
    await waitForJupyter(jupyterBaseUrl);
    bootstrapProxy = await tokenlessBootstrap(handoff.secret);
    return {
      baseUrl: `${jupyterBaseUrl}courseweave/`,
      bootstrapUrl: () => bootstrapProxy!.url,
      jupyterBaseUrl: () => jupyterBaseUrl,
      assertCredentialsAbsent: async (capabilityToken: string) => {
        const jupyterToken = bootstrapProxy!.jupyterToken();
        if (jupyterToken === null || !capabilityToken) throw new Error('Installed-wheel credential scan could not obtain runtime credentials.');
        const scan = await scanOwnedFiles(owned, [jupyterToken, capabilityToken]);
        if (scan.credentialHits !== 0) throw new Error('Installed-wheel credential scan found a retained credential.');
        return { files: scan.files, credentialHits: scan.credentialHits };
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
      close: async () => cleanupOwned({ child, handoff, bootstrapProxy, owned }),
    };
  } catch (error) {
    return cleanupAfterFailure({ child: launchProcess, handoff, bootstrapProxy, owned }, error);
  }
}
