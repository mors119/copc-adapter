import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@playwright/test';
import validator from 'gltf-validator';
import tilesValidator from '3d-tiles-validator';
import { resetServerStats } from './browser-utils.mjs';

for (const backend of ['copc-js', 'rust']) {
test(`optional second real COPC /core ${backend}: bounded read, encode, validate and render`, async ({ page }) => {
  const url = process.env.COPC_TILES_SOFI_URL ?? process.env.COPC_TILES_SECOND_COPC_URL;
  test.skip(!url, 'Set COPC_TILES_SOFI_URL to the public CORS-enabled SoFi COPC source for this opt-in test.');
  test.setTimeout(180_000);
  const pageErrors = [];
  const rendererGlbHashes = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/fixture/autzen/content/real.glb') {
      rendererGlbHashes.push(response.body().then(bytes => createHash('sha256').update(bytes).digest('hex')));
    }
  });
  await page.goto('/test/browser/adapter.html');
  await resetServerStats(page);
  const result = await page.evaluate(({ sourceUrl, selectedBackend }) => window.startRealAdapterIntegration({
    url: sourceUrl,
    backend: selectedBackend,
    sourceIdentity: `release-audit:${new URL(sourceUrl).origin}${new URL(sourceUrl).pathname}`,
    rangeValidation: 'head-fallback',
    maxHierarchyPages: 512,
    nodeCount: 3,
    distinctLevels: true,
  }), { sourceUrl: url, selectedBackend: backend });
  assert.equal(result.adapterBackend, backend);
  assert.ok(Number.isSafeInteger(result.adapterSourceGeneration));
  assert.ok(Number.isSafeInteger(result.adapterTransformGeneration));
  assert.equal(result.decodedPointBoundsKind, 'decoded-point-content');
  assert.equal(result.conservativeBounds.status, 'unsupported');
  assert.equal(result.conservativeBounds.reasonCode, 'unsupported-horizontal-crs');
  assert.equal(result.conservativeBounds.sourceGeneration, result.adapterSourceGeneration);
  assert.equal(result.conservativeBounds.transformGeneration, result.adapterTransformGeneration);
  assert.equal(result.conservativeBounds.transformPlanIdentity, result.transformPlanIdentity);
  assert.equal(result.conservativeBoundsNetworkRequests, 0);
  assert.equal(result.sourceHorizontalCrs.authority, 'EPSG');
  assert.equal(result.sourceHorizontalCrs.code, '32611');
  assert.ok(result.nodePointCount > 0 && result.nodePointCount <= 8192);
  assert.equal(result.encodedPointCount, result.nodePointCount);
  assert.equal(result.multiNodeSummary.length, 3);
  assert.equal(new Set(result.multiNodeSummary.map(node => node.nodeKey)).size, 3);
  assert.equal(new Set(result.multiNodeSummary.map(node => node.level)).size, 3);
  assert.ok(result.multiNodeSummary.every(node => node.identityMatches && node.loadedPointCount === node.hierarchyPointCount && node.encodedPointCount === node.hierarchyPointCount));
  assert.ok(result.multiNodeSummary.some(parent => result.multiNodeSummary.some(child => (
    child.parentKey === parent.nodeKey && (parent.declaredChildren.length === 0 || parent.declaredChildren.includes(child.nodeKey))
  ))), 'the selected hierarchy contains at least one stable parent/child node-key pair');
  assert.ok(result.multiNodeSummary.every(node => node.retainedPointBufferBytes > 0 && node.glbBytes > 0));
  assert.equal(result.multiNodeRetainedPointBufferBytes, result.multiNodeSummary.reduce((total, node) => total + node.retainedPointBufferBytes, 0));
  assert.equal(result.multiNodeEncodedGlbBytes, result.multiNodeSummary.reduce((total, node) => total + node.glbBytes, 0));
  assert.equal(result.pointsInsideBounds, true);
  assert.ok(result.maxAbsoluteErrorMeters <= 0.01);
  assert.ok(result.ecefFirstPoint.every(Number.isFinite));
  assert.ok(['unknown', 'unverified', 'identified'].includes(result.sourceCrsStatus));
  assert.equal(result.verticalDatumStatus, 'unknown');
  for (const [field, value] of Object.entries({
    intensity: result.availableSamples.intensity,
    classification: result.availableSamples.classification,
    red: result.availableSamples.red,
    green: result.availableSamples.green,
    blue: result.availableSamples.blue,
  })) assert.equal(result.actualAttributes[field], value, `returned ${field} matches the public Adapter node view`);
  const copcRequests = result.sourceRequests.filter(request => request.isCopcSource);
  assert.ok(copcRequests.length > 0, 'the Adapter requested the configured second COPC URL');
  assert.ok(copcRequests.every(request => request.method === 'HEAD' || request.range), 'the Adapter did not issue an unbounded GET for the COPC object');
  const ranges = copcRequests.filter(request => request.range);
  const rangeBytes = ranges.reduce((total, request) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(request.range);
    return total + Number(end) - Number(start) + 1;
  }, 0);
  assert.ok(ranges.length > 0, 'the Adapter made bounded Range requests to the second COPC');
  assert.ok(ranges.every(request => request.status === 206), 'the source honored every requested Range');
  assert.ok(ranges.every(request => /^bytes=\d+-\d+$/.test(request.range)));
  assert.ok(rangeBytes < 50 * 1024 * 1024, 'the test did not download the complete multi-gigabyte source');
  assert.ok(copcRequests.some(request => request.method === 'HEAD'), 'head-fallback performed a compatibility HEAD request');
  assert.ok(copcRequests.some(request => request.range && request.contentRange === null), 'browser CORS did not expose Content-Range');

  const glb = Buffer.from(result.glbBase64, 'base64');
  const gltfReport = await validator.validateBytes(new Uint8Array(glb), { uri: 'second-source-node.glb' });
  assert.equal(gltfReport.issues.numErrors, 0, JSON.stringify(gltfReport.issues.messages));
  assert.equal(gltfReport.issues.numWarnings, 0, JSON.stringify(gltfReport.issues.messages));
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-second-source-'));
  try {
    await mkdir(join(directory, 'content'));
    await writeFile(join(directory, 'tileset.json'), JSON.stringify(result.tileset));
    await writeFile(join(directory, 'content', 'real.glb'), glb);
    const report = await tilesValidator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    assert.deepEqual(report.issues.filter(issue => issue.severity === 'ERROR'), [], report.serialize());
    assert.deepEqual(report.issues.filter(issue => issue.severity === 'WARNING'), [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(pageErrors, []);

  const upload = await page.request.post('/__autzen/upload', { data: { tileset: result.tileset, glbBase64: result.glbBase64 } });
  assert.equal(upload.status(), 204, await upload.text());
  await resetServerStats(page);
  await page.goto('/test/browser/cesium.html');
  const cesium = await page.evaluate(input => window.startCesiumUrl(input), {
    tilesetUrl: '/fixture/autzen/tileset.json', originEcef: result.originEcef, halfExtents: result.halfExtents,
  });
  assert.deepEqual(cesium.tileLoadErrors, []);
  assert.equal(cesium.visiblePoints, result.encodedPointCount);
  assert.ok(cesium.pixels.nonBlackPixels > 0);
  assert.ok(cesium.movedVisiblePoints > 0);
  assert.ok(cesium.movedPixels.nonBlackPixels > 0);
  assert.ok(cesium.resources.httpRequests.includes('autzen/tileset.json'));
  assert.ok(cesium.resources.httpRequests.includes('autzen/content/real.glb'));
  assert.deepEqual(await page.evaluate(() => window.disposeCesium()), { viewerDestroyed: true });

  await page.goto('/test/browser/three.html');
  const three = await page.evaluate(input => window.startThreeUrl(input), {
    tilesetUrl: '/fixture/autzen/tileset.json', originEcef: result.originEcef, halfExtents: result.halfExtents,
  });
  assert.deepEqual(three.loadError, []);
  assert.equal(three.pointCount, result.encodedPointCount);
  assert.ok(three.initialPixels.nonBlackPixels > 0);
  assert.ok(three.movedPixels.nonBlackPixels > 0);
  assert.ok(three.resources.httpRequests.includes('autzen/tileset.json'));
  assert.ok(three.resources.httpRequests.includes('autzen/content/real.glb'));
  const model = three.models.find(candidate => candidate.points > 0);
  assert.ok(model);
  assert.ok(model.firstPointWorld?.every(Number.isFinite));
  for (const property of result.encodedMetadataProperties) {
    assert.ok(model.metadataPropertyNames.includes(property), `Three.js exposes ${property}`);
  }
  if (result.encodedMetadataProperties.includes('intensity')) assert.equal(model.firstMetadataRow.intensity, result.actualAttributes.intensity);
  if (result.encodedMetadataProperties.includes('classification')) assert.equal(model.firstMetadataRow.classification, result.actualAttributes.classification);
  const worldError = Math.hypot(...model.firstPointWorld.map((value, axis) => value - result.ecefFirstPoint[axis]));
  assert.ok(worldError <= 0.01, `Three.js first point world error ${worldError} m`);
  const disposed = await page.evaluate(() => window.disposeThree());
  assert.equal(disposed.activeTilesAfterDispose, 0);
  assert.equal(disposed.groupDetached, true);
  const deliveredHashes = await Promise.all(rendererGlbHashes);
  const expectedHash = createHash('sha256').update(glb).digest('hex');
  assert.deepEqual(deliveredHashes, [expectedHash, expectedHash], 'Cesium and Three fetched identical GLB bytes from the same tile URL');
  assert.ok(cesium.longitudeDegrees > -118.37 && cesium.longitudeDegrees < -118.31);
  assert.ok(cesium.latitudeDegrees > 33.93 && cesium.latitudeDegrees < 33.97);

  console.log(JSON.stringify({
    source: 'SoFi COPC', nodeKey: result.nodeKey, points: result.nodePointCount, fields: result.availableFields,
    hierarchyPages: result.hierarchyPagesRead, hierarchyNodesSeen: result.hierarchyNodeCount,
    childPageRefsSeen: result.hierarchyChildPageRefs, hierarchyLevelCounts: result.hierarchyLevelCounts,
    multiNodeSummary: result.multiNodeSummary, multiNodeRetainedPointBufferBytes: result.multiNodeRetainedPointBufferBytes,
    multiNodeEncodedGlbBytes: result.multiNodeEncodedGlbBytes, sourceRangeCount: ranges.length, sourceRangeBytesIncludingRepeatedReads: rangeBytes,
    sourceObjectLengthBytes: Number(copcRequests.find(request => request.method === 'HEAD')?.contentLength),
    sourceRequests: result.sourceRequests, timingsMilliseconds: result.pipelineTimingsMilliseconds,
    glbBytes: glb.byteLength, glbSha256: expectedHash, maxPositionErrorMeters: result.maxAbsoluteErrorMeters,
    cesium: { visiblePoints: cesium.visiblePoints, initialPixels: cesium.pixels.nonBlackPixels, movedPixels: cesium.movedPixels.nonBlackPixels, loadRenderMilliseconds: cesium.renderMilliseconds },
    three: { points: three.pointCount, initialPixels: three.initialPixels.nonBlackPixels, movedPixels: three.movedPixels.nonBlackPixels, loadRenderMilliseconds: three.renderMilliseconds },
    threeWorldErrorMeters: worldError, sourceCrs: result.sourceCrsStatus, verticalDatum: result.verticalDatumStatus,
    cesiumGeographicPosition: { longitude: cesium.longitudeDegrees, latitude: cesium.latitudeDegrees },
  }));
});
}
