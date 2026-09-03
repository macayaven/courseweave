import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoots = [
  'src/courseweave/labextension',
  'src/courseweave/static/learn',
  'src/courseweave/static/author'
];

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', () => rejectRun(new Error(`Could not start deterministic-build command: ${command}`)));
    child.once('exit', (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`Deterministic-build command failed: ${command}`)));
  });
}

function extractHead(destination) {
  return new Promise((resolveExtract, rejectExtract) => {
    const archive = spawn('git', ['archive', '--format=tar', 'HEAD'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
    const extract = spawn('tar', ['-xf', '-', '-C', destination], { stdio: ['pipe', 'inherit', 'inherit'] });
    archive.stdout.pipe(extract.stdin);
    let archiveOk = false;
    let extractOk = false;
    let settled = false;
    const finish = () => {
      if (!settled && archiveOk && extractOk) {
        settled = true;
        resolveExtract();
      }
    };
    const fail = () => {
      if (!settled) {
        settled = true;
        archive.kill();
        extract.kill();
        rejectExtract(new Error('Could not extract committed source for deterministic-build proof.'));
      }
    };
    archive.once('error', fail);
    extract.once('error', fail);
    archive.once('exit', (code) => { if (code === 0) { archiveOk = true; finish(); } else fail(); });
    extract.once('exit', (code) => { if (code === 0) { extractOk = true; finish(); } else fail(); });
  });
}

async function inventory(root) {
  const result = [];
  for (const outputRoot of outputRoots) {
    const absoluteRoot = join(root, outputRoot);
    for (const name of await readdir(absoluteRoot, { recursive: true })) {
      const path = join(absoluteRoot, name);
      let bytes;
      try { bytes = await readFile(path); } catch (error) {
        if (error.code === 'EISDIR') continue;
        throw error;
      }
      result.push({
        path: relative(root, path).split('\\').join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'courseweave-build-determinism-'));
try {
  const roots = [join(temporaryRoot, 'first'), join(temporaryRoot, 'second')];
  for (const root of roots) {
    await mkdir(root);
    await extractHead(root);
    await run('pnpm', ['install', '--frozen-lockfile'], join(root, 'frontend'));
    await run('pnpm', ['build'], join(root, 'frontend'));
  }
  const [first, second] = await Promise.all(roots.map(inventory));
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    const firstByPath = new Map(first.map((entry) => [entry.path, entry.sha256]));
    const secondByPath = new Map(second.map((entry) => [entry.path, entry.sha256]));
    const changed = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])]
      .filter((path) => firstByPath.get(path) !== secondByPath.get(path));
    throw new Error(`Independent build inventories differ: ${changed.join(', ')}`);
  }
  console.log(`Deterministic build proof passed for ${first.length} generated files.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
