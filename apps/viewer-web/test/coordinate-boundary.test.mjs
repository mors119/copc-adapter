import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transformPointBuffer,
  transformPointBufferToPointData,
} from '../src/coordinates/transform/createPointTransformer.ts';
import { inspectCopcPoint } from '../src/copc/points/pointInspection.ts';
import {
  worldBufferToLocal,
  worldToLocal,
} from '../src/coordinates/transform/worldCoordinates.ts';
import {
  buildStreamingHierarchy,
} from '../src/viewer/streaming/buildStreamingHierarchy.ts';
import {
  geographicToEcef,
} from '../src/viewer/streaming/view.ts';

function createGeographicMetadata() {
  return {
    pointCount: 2,
    bounds: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 11,
      maxY: 21,
      maxZ: 200,
    },
    cube: {
      minX: 10,
      minY: 20,
      minZ: 100,
      maxX: 11,
      maxY: 21,
      maxZ: 200,
    },
  };
}

test('shared point data retains source, geographic, and ECEF values as Float64', () => {
  const pointBuffer = {
    pointCount: 2,
    coordinates: new Float64Array([
      10.25, 20.5, 100,
      10.75, 20.75, 200,
    ]),
  };
  const data = transformPointBufferToPointData(createGeographicMetadata(), pointBuffer);

  assert.equal(data.source.coordinateSystem, 'copc-source');
  assert.equal(data.geographic.coordinateSystem, 'wgs84-geographic');
  assert.equal(data.world.coordinateSystem, 'wgs84-ecef-meters');
  assert.ok(data.source.coordinates instanceof Float64Array);
  assert.ok(data.geographic.coordinates instanceof Float64Array);
  assert.ok(data.world.coordinates instanceof Float64Array);
  assert.deepEqual([...data.source.coordinates], [...pointBuffer.coordinates]);
  assert.deepEqual([...data.geographic.coordinates], [...pointBuffer.coordinates]);

  const expected = geographicToEcef({ longitude: 10.25, latitude: 20.5, height: 100 });
  assert.deepEqual([...data.world.coordinates.slice(0, 3)], [expected.x, expected.y, expected.z]);

  const cesiumCompatible = transformPointBuffer(createGeographicMetadata(), pointBuffer);
  assert.equal(cesiumCompatible.coordinateSystem, 'wgs84-geographic');
  assert.equal(cesiumCompatible.sourceCoordinateSystem, 'copc-source');
  assert.equal(cesiumCompatible.worldCoordinateSystem, 'wgs84-ecef-meters');
  assert.deepEqual([...cesiumCompatible.coordinates], [...data.geographic.coordinates]);

  const inspection = inspectCopcPoint(
    { nodeKey: '0-0-0-0', pointIndex: 0 },
    { level: 0 },
    cesiumCompatible,
    'custom',
  );
  assert.deepEqual(inspection.world, {
    coordinateSystem: 'wgs84-ecef-meters',
    x: expected.x,
    y: expected.y,
    z: expected.z,
  });
});

test('world-to-local conversion subtracts a high-precision origin before GPU conversion', () => {
  const origin = {
    coordinateSystem: 'wgs84-ecef-meters',
    x: 6378137.123456,
    y: -1200000.75,
    z: 4300000.5,
  };
  const point = {
    coordinateSystem: 'wgs84-ecef-meters',
    x: origin.x + 0.125,
    y: origin.y - 12.5,
    z: origin.z + 2048.25,
  };
  const local = worldToLocal(point, origin);

  assert.equal(local.coordinateSystem, 'renderer-local');
  assert.ok(Math.abs(local.x - 0.125) < 1e-9);
  assert.ok(Math.abs(local.y + 12.5) < 1e-9);
  assert.ok(Math.abs(local.z - 2048.25) < 1e-9);

  const localBuffer = worldBufferToLocal(
    new Float64Array([point.x, point.y, point.z]),
    origin,
  );
  assert.ok(localBuffer instanceof Float64Array);
  assert.deepEqual([...localBuffer], [local.x, local.y, local.z]);
});

test('shared hierarchy geometry labels geographic boxes and ECEF spheres', () => {
  const [node] = buildStreamingHierarchy(createGeographicMetadata(), [{
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 2,
    pointDataOffset: 0,
    pointDataLength: 10,
  }]).values();

  assert.equal(node.bounds.coordinateSystem, 'wgs84-geographic');
  assert.equal(node.boundingSphere.coordinateSystem, 'wgs84-ecef-meters');
});
