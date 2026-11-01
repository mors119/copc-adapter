import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { expectSharedTileResources, resetServerStats } from './browser-utils.mjs';

test('Three.js TilesRenderer loads the same GLBs, points, colors and indexed metadata', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/test/browser/three.html');
  await resetServerStats(page);
  const result = await page.evaluate(() => window.startThree());

  assert.equal(result.pointCount, 6, 'the loaded GLTF POINTS geometries contain all six fixture points');
  assert.ok(result.allModelsLoadMilliseconds > 0);
  assert.ok(result.postLoadRenderMilliseconds >= 0);
  assert.equal(result.modelLoadMilliseconds.length, 2);
  assert.ok(result.activeTiles >= 2, 'the renderer has root and child tiles active');
  assert.ok(result.models.every((model) => model.colors.length > 0), 'RGB accessors reach Three.js vertex-color attributes');
  assert.ok(result.models.every((model) => model.metadataProperties.length === 1), 'structural metadata extension is consumed');
  const rootModel = result.models.find((model) => model.url.includes('726f6f74.glb'));
  assert.ok(rootModel, 'root GLB was parsed by GLTFLoader');
  assert.deepEqual(rootModel.colors[0], [1, 0, 0], 'normalized 16-bit LAS RGB retains the first point color');
  assert.deepEqual(rootModel.colors[1], [0, 1, 0], 'normalized 16-bit LAS RGB retains the second point color');
  assert.equal(rootModel.firstMetadataRow.intensity, 100);
  assert.equal(rootModel.firstMetadataRow.classification, 1);
  assert.ok(rootModel.firstPointWorld.every(Number.isFinite));
  assert.ok(Math.abs(rootModel.firstPointWorld[0] - 6378135) <= 0.01, 'tile placement preserves the expected ECEF X coordinate');
  assert.ok(Math.abs(rootModel.firstPointWorld[1] + 2) <= 0.01, 'tile placement preserves the expected ECEF Y coordinate');
  assert.ok(Math.abs(rootModel.firstPointWorld[2]) <= 0.01, 'tile placement preserves the expected ECEF Z coordinate');
  assert.ok(result.pixels.nonBlackPixels > 0, 'Three.js rendered non-background pixels from the loaded tiles');
  expectSharedTileResources(result);
  assert.ok(result.resources.cache.cacheEntries >= 3, 'the tile resource server reused bounded cached fixture resources');
  assert.deepEqual(pageErrors, []);
  console.log(`Three fixture: all models ${result.allModelsLoadMilliseconds.toFixed(1)} ms, post-load frames ${result.postLoadRenderMilliseconds.toFixed(1)} ms`);

  const cleanup = await page.evaluate(() => window.disposeThree());
  assert.ok(cleanup.activeTilesBeforeDispose >= 2);
  assert.equal(cleanup.activeTilesAfterDispose, 0, 'TilesRenderer.dispose releases its active tile records');
  assert.equal(cleanup.groupDetached, true, 'TilesRenderer.dispose detaches its group from the Three.js scene');
});
