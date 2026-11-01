import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { childContentUri, expectSharedTileResources, resetServerStats, rootContentUri } from './browser-utils.mjs';

test('CesiumJS loads, places, refines, renders and destroys standard point-cloud tiles', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/test/browser/cesium.html');
  await resetServerStats(page);
  const result = await page.evaluate(() => window.startCesium());

  assert.equal(result.pointCount, 6, 'public Cesium tile contents report all six fixture points');
  assert.ok(result.tileLoads.length >= 2, 'root and refined child contents load');
  assert.ok(result.tileLoads.every((tile) => Number.isFinite(tile.center[0]) && Number.isFinite(tile.center[1]) && Number.isFinite(tile.center[2])));
  assert.ok(result.tileLoads.every((tile) => Math.abs(tile.center[0] - 6378135) < 10));
  assert.ok(result.tileLoads.every((tile) => Math.abs(tile.center[1]) < 10));
  assert.ok(result.tileLoads.every((tile) => Math.abs(tile.center[2]) < 10));
  assert.equal(result.tilesLoaded, true);
  assert.ok(result.initialTilesLoadMilliseconds > 0);
  assert.ok(result.postLoadRenderMilliseconds >= 0);
  assert.ok(result.pixels.nonBlackPixels > 0, 'Cesium rendered non-background pixels from the loaded tiles');
  assert.ok(result.pixels.colorPixels.red > 0, 'Cesium rendered the source red point color');
  assert.ok(result.pixels.colorPixels.green > 0, 'Cesium rendered the source green point color');
  assert.ok(result.pixels.colorPixels.blue > 0, 'Cesium rendered the source blue point color');
  expectSharedTileResources(result);
  assert.equal(result.resources.providerReads.filter((uri) => uri === 'tileset.json').length, 1);
  assert.equal(result.resources.providerReads.filter((uri) => uri === rootContentUri).length, 1);
  assert.equal(result.resources.providerReads.filter((uri) => uri === childContentUri).length, 1);
  assert.deepEqual(pageErrors, []);
  console.log(`Cesium fixture: initial tiles ${result.initialTilesLoadMilliseconds.toFixed(1)} ms, post-load frames ${result.postLoadRenderMilliseconds.toFixed(1)} ms`);

  const cleanup = await page.evaluate(() => window.disposeCesium());
  assert.equal(cleanup.viewerDestroyed, true, 'the public Viewer.destroy lifecycle completes');
});
