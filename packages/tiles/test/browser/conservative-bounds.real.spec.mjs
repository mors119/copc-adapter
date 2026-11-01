import assert from 'node:assert/strict';
import { test } from '@playwright/test';

const cases = [
  {
    name: 'EPSG:4326 with undeclared vertical reference',
    path: '/__copc/geographic-4326.copc.laz',
    env: 'COPC_TILES_BOUNDS_4326_COPC',
    status: 'unsupported',
    reasonCode: 'unsupported-vertical-reference',
    horizontalCode: '4326',
  },
  {
    name: 'EPSG:4326 horizontal source with explicit ellipsoidal height',
    path: '/__copc/geographic-4326-ellipsoidal.copc.laz',
    env: 'COPC_TILES_BOUNDS_4326_ELLIPSOIDAL_COPC',
    status: 'supported',
    horizontalCode: '4326',
    heightOffsetMeters: 123.5,
  },
  {
    name: 'EPSG:4979 WGS84 source with ellipsoidal height',
    path: '/__copc/geographic-4979.copc.laz',
    env: 'COPC_TILES_BOUNDS_4979_COPC',
    status: 'supported',
    horizontalCode: '4326',
  },
  {
    name: 'projected EPSG:32611 source',
    path: '/__copc/projected-32611.copc.laz',
    env: 'COPC_TILES_BOUNDS_32611_COPC',
    status: 'unsupported',
    reasonCode: 'unsupported-horizontal-crs',
    horizontalCode: '32611',
  },
];

for (const sourceCase of cases) {
  for (const backend of ['copc-js', 'rust']) {
    test(`${sourceCase.name} conservative bounds through published /core and Tiles connector (${backend})`, async ({ page }) => {
      test.skip(!process.env[sourceCase.env], `Set ${sourceCase.env} to the local validated geographic COPC fixture.`);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto('/test/browser/adapter.html');
      let result;
      try {
        result = await page.evaluate((input) => window.verifyConservativeBounds(input), {
          url: sourceCase.path,
          backend,
          contextOptions: sourceCase.heightOffsetMeters === undefined
            ? undefined
            : { heightOffsetMeters: sourceCase.heightOffsetMeters },
        });
      } catch (error) {
        console.error('COPC request diagnostics', await page.evaluate(async () => (await fetch('/__stats')).json()));
        throw error;
      }

      assert.equal(result.conservativeBounds.status, sourceCase.status);
      assert.equal(result.sourceCoordinateSystem, 'copc-source');
      assert.equal(result.conservativeBounds.nodeKey, result.nodeKey);
      assert.equal(result.conservativeBounds.sourceGeneration, result.sourceGeneration);
      assert.equal(result.conservativeBounds.transformGeneration, result.transformGeneration);
      assert.equal(result.conservativeBounds.transformPlanIdentity, result.transformPlanIdentity);
      assert.equal(result.conservativeBounds.sourceCellBounds.minX, result.sourceCellBounds.minX);
      assert.equal(result.conservativeBounds.sourceCellBounds.maxZ, result.sourceCellBounds.maxZ);
      assert.equal(result.conservativeBounds.sourceIdentity, sourceCase.path);
      assert.equal(result.rangeRequestsDuringBoundsEvaluation, 0);
      assert.ok(result.totalRangeRequests > 0);
      assert.ok(result.nodePointCount > 0);
      assert.equal(result.decodedPointCount, result.nodePointCount);
      assert.equal(result.pointContentBoundsKind, 'decoded-point-content');
      assert.ok(result.pointContentBounds);

      if (sourceCase.status === 'supported') {
        assert.equal(result.conservativeBounds.coverage, 'full-source-cell-and-descendant-cells');
        assert.equal(result.conservativeBounds.verification, 'analytic-interval');
        assert.equal(result.conservativeBounds.encoderErrorPaddingRequired, true);
        assert.equal(result.conservativeBounds.boundsEcef.coordinateSystem, 'wgs84-ecef-meters');
        assert.equal(result.conservativeBounds.verticalReference, 'ellipsoidal');
        assert.equal(result.conservativeBounds.sourceVerticalUnitToMeters, 1);
        if (sourceCase.heightOffsetMeters !== undefined) {
          assert.equal(result.conservativeBounds.heightOffsetMeters, sourceCase.heightOffsetMeters);
        }
        assert.equal(result.horizontalCrs.authority, 'EPSG');
        assert.equal(result.horizontalCrs.code, sourceCase.horizontalCode);
        assert.equal(result.verticalHeightKind.value, 'ellipsoidal');
        assert.equal(result.allPointsContained, true);
        assert.notDeepEqual(result.conservativeBounds.boundsEcef, result.pointContentBounds);
      } else {
        assert.equal(result.conservativeBounds.reasonCode, sourceCase.reasonCode);
        assert.equal(result.horizontalCrs.code, sourceCase.horizontalCode);
        assert.equal('boundsEcef' in result.conservativeBounds, false);
        assert.equal(result.allPointsContained, false);
      }
      assert.deepEqual(pageErrors, []);
      console.log(JSON.stringify({
        fixture: sourceCase.name,
        backend,
        sourceCrs: result.horizontalCrs,
        verticalHeightKind: result.verticalHeightKind,
        node: result.nodeKey,
        points: result.nodePointCount,
        status: result.conservativeBounds.status,
        reasonCode: result.conservativeBounds.reasonCode,
        rangeRequestsDuringBoundsEvaluation: result.rangeRequestsDuringBoundsEvaluation,
        contained: result.allPointsContained,
      }));
    });
  }
}
