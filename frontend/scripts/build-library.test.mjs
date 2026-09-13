import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const emitted = new URL('../packages/lab/lib/surfaces.js', import.meta.url);
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
test('library rebuild replaces restored emitted bytes even with a current incremental cache', async () => {
  run(['--filter','@courseweave/lab','exec','tsc','-b','.','--force']);
  const expected = await readFile(emitted);
  try {
    await writeFile(emitted, 'obsolete emitted output\n');
    run(['--filter','@courseweave/lab','run','build:lib']);
    assert.deepEqual(await readFile(emitted), expected);
  } finally {
    await writeFile(emitted, expected);
  }
});
