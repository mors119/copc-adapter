import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as Cesium from 'cesium';
import {
  transformPointBufferToPointData,
} from '../src/coordinates/transform/createPointTransformer.ts';
import {
  toCartesian3ArrayFromWorldBuffer,
} from '../src/cesium/render/renderPoints.ts';

const fixturePath = fileURLToPath(
  new URL('../../../crates/crs-audit/src/fixtures.json', import.meta.url),
);
const fixtureMatrix = JSON.parse(readFileSync(fixturePath, 'utf8'));
const fixture = fixtureMatrix.fixtures.find(
  (candidate) => candidate.id === 'epsg-5186-korean-central-belt-2010',
);

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function createMetadata() {
  const xs = fixture.points.map(({ x }) => x);
  const ys = fixture.points.map(({ y }) => y);
  const zs = fixture.points.map(({ z }) => z);
  return {
    pointCount: fixture.points.length,
    wkt: fixture.wkt,
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      minZ: Math.min(...zs),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
      maxZ: Math.max(...zs),
    },
  };
}

function createSourceBuffer() {
  return {
    pointCount: fixture.points.length,
    coordinates: new Float64Array(fixture.points.flatMap(({ x, y, z }) => [x, y, z])),
  };
}

test('EPSG:5186 proj4js path matches independent origin and Seoul controls', () => {
  assert.ok(fixture, 'EPSG:5186 fixture must be checked in');
  assert.match(fixture.source, /epsg\.org\/crs_5186/);
  assert.match(fixture.axis_order, /X to easting and Y to northing/);
  assert.equal(fixture.points[0].x, 200000);
  assert.equal(fixture.points[0].y, 600000);
  assert.deepEqual(fixture.expected[0], {
    longitude: 127,
    latitude: 38,
    height: 0,
    ecef: [-3028591.5686469036, 4019076.7579761064, 3905443.968419102],
  });

  const prepared = transformPointBufferToPointData(createMetadata(), createSourceBuffer());

  assert.equal(prepared.geographic.coordinateSystem, 'wgs84-geographic');
  assert.equal(prepared.world.coordinateSystem, 'wgs84-ecef-meters');
  for (let index = 0; index < fixture.expected.length; index += 1) {
    const offset = index * 3;
    const expected = fixture.expected[index];
    assertNear(
      prepared.geographic.coordinates[offset],
      expected.longitude,
      fixture.tolerance.longitude_degrees,
      `point ${index} longitude`,
    );
    assertNear(
      prepared.geographic.coordinates[offset + 1],
      expected.latitude,
      fixture.tolerance.latitude_degrees,
      `point ${index} latitude`,
    );
    assertNear(
      prepared.geographic.coordinates[offset + 2],
      expected.height,
      fixture.tolerance.height_meters,
      `point ${index} height`,
    );
    for (let axis = 0; axis < 3; axis += 1) {
      assertNear(
        prepared.world.coordinates[offset + axis],
        expected.ecef[axis],
        fixture.ecef_tolerance_meters,
        `point ${index} ECEF axis ${axis}`,
      );
    }
  }
});

test('EPSG:5186 prepared ECEF points place in the expected Korean region in Cesium', () => {
  assert.ok(fixture, 'EPSG:5186 fixture must be checked in');
  const prepared = transformPointBufferToPointData(createMetadata(), createSourceBuffer());

  // This is the same WGS84-ECEF-to-Cartesian3 bridge used by the Cesium renderer.
  const positions = toCartesian3ArrayFromWorldBuffer(prepared);
  assert.equal(positions.length, fixture.expected.length);
  for (let index = 0; index < positions.length; index += 1) {
    const placed = Cesium.Cartographic.fromCartesian(positions[index]);
    const expected = fixture.expected[index];
    assertNear(
      Cesium.Math.toDegrees(placed.longitude),
      expected.longitude,
      fixture.tolerance.longitude_degrees,
      `Cesium point ${index} longitude`,
    );
    assertNear(
      Cesium.Math.toDegrees(placed.latitude),
      expected.latitude,
      fixture.tolerance.latitude_degrees,
      `Cesium point ${index} latitude`,
    );
    assertNear(
      placed.height,
      expected.height,
      fixture.ecef_tolerance_meters,
      `Cesium point ${index} height`,
    );
    assert.ok(placed.longitude > Cesium.Math.toRadians(126)
      && placed.longitude < Cesium.Math.toRadians(128));
    assert.ok(placed.latitude > Cesium.Math.toRadians(33)
      && placed.latitude < Cesium.Math.toRadians(39));
  }
});
