import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTilesLcov } from '../scripts/run-coverage-tests.mjs';

const root = '/tmp/fixtures/packages/tiles';
const fixture = (path) => 'TN:\nSF:' + path + '\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';

test('Tiles LCOV includes staged source and rewrites repo-relative paths', () => {
  const report = normalizeTilesLcov(
    fixture('src/gltf/pointCloudGlb.ts') + fixture('file:///tmp/fixtures/packages/tiles/src/tileset/explicitTileset.ts'),
    root,
  );
  assert.deepEqual([...report.matchAll(/^SF:(.*)$/gm)].map((m) => m[1]), [
    'packages/tiles/src/gltf/pointCloudGlb.ts',
    'packages/tiles/src/tileset/explicitTileset.ts',
  ]);
});

test('Tiles LCOV ignores tests, other workspaces and off-root records', () => {
  const report = normalizeTilesLcov(
    fixture('src/gltf/pointCloudGlb.ts') + fixture('test/example.test.mjs') +
    fixture('../adapter/core.ts') + fixture('src/partial.test.mjs'),
    root,
  );
  assert.equal([...report.matchAll(/^SF:/gm)].length, 1);
});

test('Tiles LCOV rejects missing measured source lines', () => {
  assert.throws(() => normalizeTilesLcov(fixture('test/example.test.mjs'), root), /No Tiles source records/);
});
