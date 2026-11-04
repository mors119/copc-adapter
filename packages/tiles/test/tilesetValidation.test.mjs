import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertTilesetIssue, validateTilesetReport } from './tilesetValidation.mjs';

function tileset({ boundingVolume = { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, contentUri = 'content/points.glb' } = {}) {
  return {
    asset: { version: '1.1' },
    geometricError: 0,
    root: {
      boundingVolume,
      geometricError: 0,
      refine: 'ADD',
      content: { uri: contentUri },
    },
  };
}

async function writeTileset(directory, value) {
  const path = join(directory, 'tileset.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('reports missing files, invalid bounds and malformed GLB containers with error codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-validator-negative-'));
  try {
    const missingDirectory = join(directory, 'missing-resource');
    await mkdir(missingDirectory);
    const missingReport = await validateTilesetReport(await writeTileset(missingDirectory, tileset()));
    assertTilesetIssue(missingReport, { code: 'RESOURCE_MISSING', severity: 'ERROR' });

    const boundsDirectory = join(directory, 'invalid-bounds');
    await mkdir(boundsDirectory);
    const boundsReport = await validateTilesetReport(await writeTileset(boundsDirectory, tileset({
      boundingVolume: { box: [0, 1, 2] },
    })));
    assertTilesetIssue(boundsReport, { code: 'BOUNDING_VOLUME_VALUES', severity: 'ERROR' });

    const malformedDirectory = join(directory, 'malformed-glb');
    await mkdir(join(malformedDirectory, 'content'), { recursive: true });
    const malformedTileset = await writeTileset(malformedDirectory, tileset());
    await writeFile(join(malformedDirectory, 'content/points.glb'), Buffer.from('glTF'));
    const malformedReport = await validateTilesetReport(malformedTileset);
    assertTilesetIssue(malformedReport, { code: 'GLB_HEADER', severity: 'ERROR' });
    assert.equal(malformedReport.stats.glbs, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
