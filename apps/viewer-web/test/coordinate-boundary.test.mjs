import test from 'node:test';
import assert from 'node:assert/strict';

import {
  transformPointBuffer,
  transformPointBufferToPointData,
} from '../src/coordinates/transform/createPointTransformer.ts';
import { inspectCopcPoint } from '../src/copc/points/pointInspection.ts';
import {
  createDatasetLocalFrame,
  datasetLocalDirectionToWorld,
  datasetLocalToWorld,
  worldBoundsToDatasetLocal,
  worldBufferToDatasetLocal,
  worldDirectionToDatasetLocal,
  worldToDatasetLocal,
} from '../src/coordinates/transform/datasetLocalFrame.ts';
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

test('dataset-local frame uses a deterministic cube-centre ENU origin', () => {
  const metadata = createGeographicMetadata();
  const frame = createDatasetLocalFrame(metadata);
  const repeatedFrame = createDatasetLocalFrame(metadata);
  const expectedOrigin = geographicToEcef({
    longitude: 10.5,
    latitude: 20.5,
    height: 150,
  });

  assert.ok(Object.isFrozen(frame));
  assert.ok(Object.isFrozen(frame.origin));
  assert.deepEqual(frame.origin, expectedOrigin);
  assert.deepEqual(frame, repeatedFrame);
  assert.deepEqual(worldToDatasetLocal(frame.origin, frame), {
    coordinateSystem: 'renderer-local',
    x: 0,
    y: 0,
    z: 0,
  });
  assert.equal(frame.axisConvention, 'enu');
  assert.equal(frame.units, 'metres');
  assert.ok([
    ...Object.values(frame.east),
    ...Object.values(frame.north),
    ...Object.values(frame.up),
  ].every(Number.isFinite));
});

test('dataset-local ENU positions and camera vectors round-trip consistently', () => {
  const frame = createDatasetLocalFrame(createGeographicMetadata());
  const localPositions = [
    { x: 12.5, y: -30, z: 2 },
    { x: -1200, y: 800, z: 450 },
    { x: 0, y: 0, z: -15.25 },
  ];
  const localDirections = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0.25, y: -0.75, z: 0.6 },
  ];

  for (const localPosition of localPositions) {
    const world = datasetLocalToWorld({
      coordinateSystem: 'renderer-local',
      ...localPosition,
    }, frame);
    const roundTrip = worldToDatasetLocal(world, frame);

    assert.ok(Math.abs(roundTrip.x - localPosition.x) < 1e-9);
    assert.ok(Math.abs(roundTrip.y - localPosition.y) < 1e-9);
    assert.ok(Math.abs(roundTrip.z - localPosition.z) < 1e-9);
    assert.ok(Object.values(world).slice(1).every(Number.isFinite));
  }

  for (const localDirection of localDirections) {
    const worldDirection = datasetLocalDirectionToWorld(localDirection, frame);
    const roundTrip = worldDirectionToDatasetLocal(worldDirection, frame);

    assert.ok(Math.abs(roundTrip.x - localDirection.x) < 1e-12);
    assert.ok(Math.abs(roundTrip.y - localDirection.y) < 1e-12);
    assert.ok(Math.abs(roundTrip.z - localDirection.z) < 1e-12);
  }
});

test('dataset-local conversion preserves nearby Earth-scale points before Float32 upload', () => {
  const frame = createDatasetLocalFrame(createGeographicMetadata());
  const firstWorld = datasetLocalToWorld({
    coordinateSystem: 'renderer-local',
    x: 1000,
    y: 2000,
    z: 10,
  }, frame);
  const secondWorld = datasetLocalToWorld({
    coordinateSystem: 'renderer-local',
    x: 1000.01,
    y: 2000,
    z: 10,
  }, frame);
  const firstLocal = worldToDatasetLocal(firstWorld, frame);
  const secondLocal = worldToDatasetLocal(secondWorld, frame);
  const localBuffer = worldBufferToDatasetLocal(new Float64Array([
    firstWorld.x,
    firstWorld.y,
    firstWorld.z,
    secondWorld.x,
    secondWorld.y,
    secondWorld.z,
  ]), frame);
  const directEarthScaleFirst = new Float32Array([
    firstWorld.x,
    firstWorld.y,
    firstWorld.z,
  ]);
  const directEarthScaleSecond = new Float32Array([
    secondWorld.x,
    secondWorld.y,
    secondWorld.z,
  ]);
  const localGpuFirst = new Float32Array([
    firstLocal.x,
    firstLocal.y,
    firstLocal.z,
  ]);
  const localGpuSecond = new Float32Array([
    secondLocal.x,
    secondLocal.y,
    secondLocal.z,
  ]);

  assert.deepEqual([...directEarthScaleFirst], [...directEarthScaleSecond]);
  assert.notEqual(localGpuFirst[0], localGpuSecond[0]);
  assert.ok(Math.abs(localGpuSecond[0] - localGpuFirst[0] - 0.01) < 1e-4);
  assert.ok(Math.abs(localBuffer[0] - firstLocal.x) < 1e-9);
  assert.ok(Math.abs(localBuffer[3] - secondLocal.x) < 1e-9);
});

test('renderer-local bounds are derived without replacing shared world bounds', () => {
  const frame = createDatasetLocalFrame(createGeographicMetadata());
  const worldBounds = {
    coordinateSystem: 'wgs84-ecef-meters',
    minX: frame.origin.x - 10,
    minY: frame.origin.y - 20,
    minZ: frame.origin.z - 30,
    maxX: frame.origin.x + 10,
    maxY: frame.origin.y + 20,
    maxZ: frame.origin.z + 30,
  };
  const localBounds = worldBoundsToDatasetLocal(worldBounds, frame);

  assert.equal(worldBounds.coordinateSystem, 'wgs84-ecef-meters');
  assert.equal(localBounds.coordinateSystem, 'renderer-local');
  assert.ok(localBounds.minX < 0 && localBounds.maxX > 0);
  assert.ok(localBounds.minY < 0 && localBounds.maxY > 0);
  assert.ok(localBounds.minZ < 0 && localBounds.maxZ > 0);
  assert.ok(Object.values(localBounds).slice(1).every(Number.isFinite));
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
