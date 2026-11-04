import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { normalizeAdapterLcov } from '../../scripts/normalize-lcov.mjs';

const packageDirectory = resolve('/repo/packages/adapter');

function record(path) {
  return `TN:\nSF:${path}\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
}

test('normalizes Adapter LCOV paths to repository-relative paths', () => {
  const input = record('core/coordinates/transform.ts')
    + record('cesium/layer.ts')
    + record('three/render.ts')
    + record('core.ts');
  const result = normalizeAdapterLcov(input, packageDirectory);
  assert.deepEqual(
    [...result.matchAll(/^SF:(.*)$/gm)].map((match) => match[1]),
    [
      'packages/adapter/core/coordinates/transform.ts',
      'packages/adapter/cesium/layer.ts',
      'packages/adapter/three/render.ts',
      'packages/adapter/core.ts',
    ],
  );
});

test('excludes tests, unrelated workspaces, tooling, and outside paths', () => {
  const input = record('core/point.ts')
    + record('test/core/point.test.mjs')
    + record('core/some.test.mjs')
    + record('scripts/run-tests.mjs')
    + record('../tiles/src/tile.ts')
    + record('node_modules/tsx/index.js');
  const output = normalizeAdapterLcov(input, packageDirectory);
  assert.match(output, /^SF:packages\/adapter\/core\/point.ts$/m);
  assert.equal([...output.matchAll(/^SF:/gm)].length, 1);
});

test('rejects empty Adapter source coverage instead of uploading a misleading report', () => {
  assert.throws(
    () => normalizeAdapterLcov(record('test/only.test.mjs'), packageDirectory),
    /did not contain any Adapter source records/,
  );
});
