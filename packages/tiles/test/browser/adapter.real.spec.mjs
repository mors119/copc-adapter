import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@playwright/test';
import validator from 'gltf-validator';
import tilesValidator from '3d-tiles-validator';
import { resetServerStats } from './browser-utils.mjs';

for (const backend of ['copc-js', 'rust']) {
  test(`real Autzen ${backend} live provider rejects projected bounds before point reads`, async ({ page }) => {
    test.skip(!process.env.COPC_TILES_AUTZEN, 'Set COPC_TILES_AUTZEN to the verified Autzen COPC sample.');
    test.setTimeout(120_000);
    await page.goto('/test/browser/adapter.html');
    const result = await page.evaluate((selectedBackend) => window.verifyLiveProviderFailsClosed({
      url: '/__copc/autzen.copc.laz',
      backend: selectedBackend,
    }), backend);
    assert.equal(result.created, false);
    assert.equal(result.errorName, 'CopcTileResourceProviderError');
    assert.equal(result.errorCode, 'UNSUPPORTED_BOUNDS');
    assert.equal(result.nodeKey, '0-0-0-0');
    assert.equal(result.conservativeBoundsResult.status, 'unsupported');
    assert.equal(result.conservativeBoundsResult.reasonCode, 'unsupported-horizontal-crs');
    assert.equal(result.conservativeBoundsResult.sourceCoordinateSystem, 'copc-source');
    assert.equal(result.hierarchyPageReads, 1);
    assert.equal(result.pointReadCalls, 0);
    console.log(`Autzen live provider ${backend}: ${result.errorCode}/${result.conservativeBoundsResult.reasonCode}; hierarchy pages=${result.hierarchyPageReads}; point reads=${result.pointReadCalls}.`);
  });

  test(`packed Adapter /core ${backend} source feeds real Autzen content to Cesium and Three.js`, async ({ page }) => {
    test.skip(!process.env.COPC_TILES_AUTZEN, 'Set COPC_TILES_AUTZEN to the verified Autzen COPC sample.');
    test.setTimeout(120_000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/test/browser/adapter.html');
    await resetServerStats(page);
    const result = await page.evaluate((selectedBackend) => window.startRealAdapterIntegration({ backend: selectedBackend }), backend);
    const stats = await page.evaluate(async () => (await fetch('/__stats')).json());

  assert.equal(result.adapterBackend, backend);
  assert.ok(Number.isSafeInteger(result.adapterSourceGeneration) && result.adapterSourceGeneration >= 0);
  assert.ok(Number.isSafeInteger(result.adapterTransformGeneration) && result.adapterTransformGeneration >= 0);
  assert.ok(result.transformPlanIdentity.length > 0);
  assert.equal(result.decodedPointBoundsKind, 'decoded-point-content');
  assert.equal(result.conservativeBounds.status, 'unsupported');
  assert.equal(result.conservativeBounds.reasonCode, 'unsupported-horizontal-crs');
  assert.equal(result.conservativeBounds.sourceCellBounds.coordinateSystem, undefined);
  assert.equal(result.conservativeBounds.sourceCoordinateSystem, 'copc-source');
  assert.equal(result.conservativeBounds.sourceGeneration, result.adapterSourceGeneration);
  assert.equal(result.conservativeBounds.transformGeneration, result.adapterTransformGeneration);
  assert.equal(result.conservativeBounds.transformPlanIdentity, result.transformPlanIdentity);
  assert.equal(result.conservativeBoundsNetworkRequests, 0);
  assert.equal(result.sourceHorizontalCrs.authority, 'EPSG');
  assert.equal(result.sourceHorizontalCrs.code, '2992');
  assert.ok(Number.isSafeInteger(result.metadataPointCount) && result.metadataPointCount > 0);
  assert.equal(result.loadedPointCount, result.nodePointCount);
  assert.equal(result.encodedPointCount, result.nodePointCount);
  assert.ok(result.nodePointCount > 0 && result.nodePointCount <= 8192);
  assert.ok(result.hierarchyPagesRead <= 64);
  assert.ok(result.ecefFirstPoint.every(Number.isFinite));
  assert.ok(result.maxAbsoluteErrorMeters <= 0.01);
  assert.ok(result.multiNodeRetainedPointBufferBytes >= result.loadedPointCount * 3 * Float64Array.BYTES_PER_ELEMENT);
  assert.ok(result.multiNodeEncodedGlbBytes >= Math.floor(result.glbBase64.length * 3 / 4));
  assert.ok(result.tileset.root.geometricError > 0);
  assert.equal(result.pointsInsideBounds, true);
  assert.ok(['identified', 'unverified', 'unknown'].includes(result.sourceCrsStatus));
  assert.equal(result.verticalDatumStatus, 'unknown');
  assert.ok(result.availableFields.includes('position'));
  assert.equal(result.actualAttributes.red !== null, result.availableFields.includes('rgb'));
  assert.equal(result.actualAttributes.intensity !== null, result.availableFields.includes('intensity'));
  assert.equal(result.actualAttributes.classification !== null, result.availableFields.includes('classification'));
  assert.equal(result.actualAttributes.intensity, result.availableSamples.intensity);
  assert.equal(result.actualAttributes.classification, result.availableSamples.classification);
  assert.equal(result.actualAttributes.red, result.availableSamples.red);
  assert.equal(result.actualAttributes.green, result.availableSamples.green);
  assert.equal(result.actualAttributes.blue, result.availableSamples.blue);
  assert.ok(stats.copcRangeCount > 0, 'the browser used the local bounded HTTP Range source');
  assert.ok(stats.copcRangeBytes > 0);
  assert.ok(stats.copcRangeBytes < 81_123_042, 'the adapter did not fetch the full 81 MB object');
  assert.ok(stats.copcRequests.every((request) => request.method === 'GET' ? /^bytes=\d+-\d+$/.test(request.range) : request.method === 'HEAD'));
  const bytes = Buffer.from(result.glbBase64, 'base64');
  const gltfReport = await validator.validateBytes(new Uint8Array(bytes), { uri: 'autzen-node.glb' });
  assert.equal(gltfReport.issues.numErrors, 0, JSON.stringify(gltfReport.issues.messages));
  assert.equal(gltfReport.issues.numWarnings, 0, JSON.stringify(gltfReport.issues.messages));
  assert.deepEqual(pageErrors, []);
  console.log(`Autzen Adapter /core ${backend}: ${result.nodeKey}, ${result.nodePointCount} points, fields=${result.availableFields.join(',')}, ranges=${stats.copcRangeCount}, rangeBytes=${stats.copcRangeBytes}, GLB=${Math.floor(result.glbBase64.length * 3 / 4)} bytes, retained point buffers=${result.multiNodeRetainedPointBufferBytes} bytes, encoded node GLBs=${result.multiNodeEncodedGlbBytes} bytes, Khronos errors/warnings=${gltfReport.issues.numErrors}/${gltfReport.issues.numWarnings}, pipelineMs=${JSON.stringify(result.pipelineTimingsMilliseconds)}`);

  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-autzen-one-tile-'));
  try {
    await mkdir(join(directory, 'content'));
    await writeFile(join(directory, 'tileset.json'), JSON.stringify(result.tileset));
    await writeFile(join(directory, 'content', 'real.glb'), bytes);
    const report = await tilesValidator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'ERROR'), [], report.serialize());
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'WARNING'), [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  console.log(`Autzen real node encoding: Tileset validator errors/warnings=0/0; one decoded COPC node only, not the complete COPC hierarchy or a production LOD tileset.`);
  console.log(`Autzen conservative bounds: ${result.conservativeBounds.status}/${result.conservativeBounds.reasonCode}; source cell retained in EPSG:2992; bounds evaluation source requests=${result.conservativeBoundsNetworkRequests}.`);

  const upload = await page.request.post('/__autzen/upload', {
    data: { tileset: result.tileset, glbBase64: result.glbBase64 },
  });
  assert.equal(upload.status(), 204, await upload.text());

  await resetServerStats(page);
  await page.goto('/test/browser/cesium.html');
  const cesium = await page.evaluate((input) => window.startCesiumUrl(input), {
    tilesetUrl: '/fixture/autzen/tileset.json',
    originEcef: result.originEcef,
    halfExtents: result.halfExtents,
  });
  assert.deepEqual(cesium.tileLoadErrors, []);
  assert.equal(cesium.loadedPoints, result.encodedPointCount);
  assert.equal(cesium.visiblePoints, result.encodedPointCount);
  assert.ok(cesium.movedVisiblePoints > 0, 'Autzen point content remains visible after camera movement');
  assert.ok(cesium.movedPixels.nonBlackPixels > 0, 'Cesium renders Autzen points after camera movement');
  assert.ok(cesium.loadedTileCenters.length > 0);
  let maxBoundsCenterErrorMeters = 0;
  for (const center of cesium.loadedTileCenters) {
    const errorMeters = Math.hypot(...center.map((value, axis) => value - result.originEcef[axis]));
    maxBoundsCenterErrorMeters = Math.max(maxBoundsCenterErrorMeters, errorMeters);
    assert.ok(errorMeters <= 0.01, `Cesium tile bounds center differs from encoder origin by ${errorMeters} m`);
  }
  assert.ok(cesium.pixels.nonBlackPixels > 0, 'Cesium rendered point pixels rather than only loading the GLB');
  assert.ok(cesium.longitudeDegrees > -123.09 && cesium.longitudeDegrees < -123.05);
  assert.ok(cesium.latitudeDegrees > 44.04 && cesium.latitudeDegrees < 44.08);
  assert.ok(cesium.resources.httpRequests.includes('autzen/tileset.json'));
  assert.ok(cesium.resources.httpRequests.includes('autzen/content/real.glb'));
  assert.deepEqual(await page.evaluate(() => window.disposeCesium()), { viewerDestroyed: true });

  await resetServerStats(page);
  await page.goto('/test/browser/three.html');
  const three = await page.evaluate((input) => window.startThreeUrl(input), {
    tilesetUrl: '/fixture/autzen/tileset.json',
    originEcef: result.originEcef,
    halfExtents: result.halfExtents,
  });
  assert.deepEqual(three.loadError, []);
  assert.equal(three.pointCount, result.encodedPointCount);
  assert.ok(three.activeTiles > 0);
  assert.ok(three.initialPixels.nonBlackPixels > 0, 'Three.js rendered point pixels rather than only loading the GLB');
  assert.ok(three.movedPixels.nonBlackPixels > 0, 'Three.js keeps point content visible after camera movement');
  assert.ok(three.resources.httpRequests.includes('autzen/tileset.json'));
  assert.ok(three.resources.httpRequests.includes('autzen/content/real.glb'));
  const model = three.models.find((candidate) => candidate.points > 0);
  assert.ok(model, 'Three.js loaded a point model');
  if (result.availableFields.includes('rgb')) {
    assert.ok(model.colors.length > 0, 'Three.js exposes encoded RGB point colors');
    for (const [channel, axis] of [['red', 0], ['green', 1], ['blue', 2]]) {
      const expected = result.actualAttributes[channel] / 65_535;
      assert.ok(Math.abs(model.colors[0][axis] - expected) <= 1 / 65_535, `Three.js ${channel} matches the selected Adapter sample`);
    }
  }
  for (const property of result.encodedMetadataProperties) {
    assert.ok(model.metadataPropertyNames.includes(property), `Three.js exposes structural metadata property ${property}: ${JSON.stringify(model.firstMetadataRow)}`);
  }
  if (result.encodedMetadataProperties.includes('intensity')) {
    assert.equal(model.firstMetadataRow.intensity, result.actualAttributes.intensity);
  }
  if (result.encodedMetadataProperties.includes('classification')) {
    assert.equal(model.firstMetadataRow.classification, result.actualAttributes.classification);
  }
  assert.ok(model.firstPointWorld?.every(Number.isFinite));
  const positionErrorMeters = Math.hypot(...model.firstPointWorld.map((value, axis) => value - result.ecefFirstPoint[axis]));
  assert.ok(positionErrorMeters <= 0.01, `Three.js first point world-position error is ${positionErrorMeters} m`);
  const threeDispose = await page.evaluate(() => window.disposeThree());
  assert.ok(threeDispose.activeTilesBeforeDispose > 0);
  assert.equal(threeDispose.activeTilesAfterDispose, 0);
  assert.equal(threeDispose.groupDetached, true);

  console.log(`Real one-node Autzen rendering (${backend}): Cesium ${cesium.visiblePoints} visible points, ${cesium.pixels.nonBlackPixels}/${cesium.movedPixels.nonBlackPixels} initial/moved rendered pixels at ${cesium.longitudeDegrees.toFixed(6)},${cesium.latitudeDegrees.toFixed(6)}, browser load/render=${cesium.renderMilliseconds.toFixed(1)} ms; Three ${three.pointCount} points, ${three.initialPixels.nonBlackPixels}/${three.movedPixels.nonBlackPixels} initial/moved rendered pixels, browser load/render=${three.renderMilliseconds.toFixed(1)} ms; bounds-center/first-point world error=${maxBoundsCenterErrorMeters.toFixed(4)}/${positionErrorMeters.toFixed(4)} m; encoder error=${result.maxAbsoluteErrorMeters.toFixed(4)} m; cached resources=${cesium.resources.cache.cacheBytes} bytes.`);
  console.log(JSON.stringify({
    autzenPrecisionMeters: {
      maxBoundsCenterError: maxBoundsCenterErrorMeters,
      firstPointWorldError: positionErrorMeters,
      encoderMaxAbsoluteError: result.maxAbsoluteErrorMeters,
    },
  }));
  });
}
