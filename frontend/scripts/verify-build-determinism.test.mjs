import assert from 'node:assert/strict';
import test from 'node:test';

import { outputRoots, verifyGeneratedInventories } from './verify-build-determinism.mjs';

test('the deterministic inventory covers every required generated root', () => {
  assert.deepEqual(outputRoots, [
    'frontend/packages/lab/lib',
    'src/courseweave/labextension',
    'src/courseweave/static/learn',
    'src/courseweave/static/author'
  ]);
});

test('an orphaned committed generated file fails even when independent builds match', () => {
  const built = [{ path: 'frontend/packages/lab/lib/index.js', sha256: 'built' }];
  const committed = [
    ...built,
    { path: 'frontend/packages/lab/lib/orphan.js', sha256: 'stale' }
  ];

  assert.throws(
    () => verifyGeneratedInventories({ first: built, second: built, committed }),
    /Committed generated output differs from fresh build: frontend\/packages\/lab\/lib\/orphan\.js/
  );
});
