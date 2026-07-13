import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toCopcHierarchyNode } from '../src/copc/adapters/hierarchyAdapter.ts';
import { toCartesian3Array } from '../src/cesium/render/renderPoints.ts';
import { loadRootHierarchy } from '../src/copc/hierarchy/loadRootHierarchy.ts';
import { loadCopcMetadata } from '../src/copc/metadata/loadMetadata.ts';
import {
  loadCopcPoints,
  loadPointDataView,
} from '../src/copc/points/loadPointData.ts';
import { createPointReader, readAllPoints } from '../src/copc/points/readPoint.ts';
import { createPointTransformer } from '../src/coordinates/transform/createPointTransformer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(
  __dirname,
  '../../../samples/local/autzen.copc.laz',
);

function assertClose(actual, expected, epsilon = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

test('toCopcHierarchyNode parses a hierarchy key', () => {
  const node = toCopcHierarchyNode('4-2-3-1', {
    pointCount: 42,
    pointDataOffset: 128,
    pointDataLength: 256,
  });

  assert.deepEqual(node, {
    key: '4-2-3-1',
    level: 4,
    x: 2,
    y: 3,
    z: 1,
    pointCount: 42,
    pointDataOffset: 128,
    pointDataLength: 256,
  });
});

test('toCopcHierarchyNode rejects an invalid hierarchy key', () => {
  assert.throws(
    () =>
      toCopcHierarchyNode('bad-key', {
        pointCount: 1,
        pointDataOffset: 0,
        pointDataLength: 1,
      }),
    /Invalid COPC hierarchy key/,
  );
});

test('readPoint utilities decode all coordinates from a point view', () => {
  const view = {
    pointCount: 2,
    getter(name) {
      const values = {
        X: [10, 40],
        Y: [20, 50],
        Z: [30, 60],
      };

      return (index) => values[name][index];
    },
  };

  const reader = createPointReader(view);

  assert.deepEqual(reader.read(0), {
    x: 10,
    y: 20,
    z: 30,
  });

  assert.deepEqual(readAllPoints(view), [
    { x: 10, y: 20, z: 30 },
    { x: 40, y: 50, z: 60 },
  ]);
});

test('loadCopcMetadata reads sample metadata', async () => {
  const metadata = await loadCopcMetadata(samplePath);

  assert.equal(metadata.pointCount, 10653336);
  assert.equal(metadata.spacing, 36.37117187500007);
  assert.deepEqual(metadata.bounds, {
    minX: 635577.79,
    minY: 848882.15,
    minZ: 406.14,
    maxX: 639003.73,
    maxY: 853537.66,
    maxZ: 615.26,
  });
  assert.deepEqual(metadata.scale, {
    x: 0.01,
    y: 0.01,
    z: 0.01,
  });
  assert.deepEqual(metadata.offset, {
    x: 637290.75,
    y: 851209.9,
    z: 510.7,
  });
  assert.match(metadata.wkt, /PROJCS\["NAD83 \/ Oregon GIC Lambert \(ft\)"/);
});

test('loadRootHierarchy returns sample root hierarchy nodes', async () => {
  const nodes = await loadRootHierarchy(samplePath);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);
  assert.ok(nodes.length > 200);
  assert.deepEqual(rootNode, {
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 61201,
    pointDataOffset: 79462688,
    pointDataLength: 763258,
  });
});

test('loadPointDataView and loadCopcPoints decode sample node points', async () => {
  const nodes = await loadRootHierarchy(samplePath);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);

  const view = await loadPointDataView(samplePath, rootNode);

  assert.equal(view.pointCount, 61201);

  const points = await loadCopcPoints(samplePath, rootNode);

  assert.equal(points.length, 61201);
  assert.deepEqual(points[0], {
    x: 638865.15,
    y: 849280.01,
    z: 425.15999999999997,
  });
  assert.deepEqual(points[1], {
    x: 638852.82,
    y: 849328.6,
    z: 424.53999999999996,
  });
});

test('createPointTransformer converts projected COPC points to WGS84', async () => {
  const metadata = await loadCopcMetadata(samplePath);
  const nodes = await loadRootHierarchy(samplePath);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);

  const points = await loadCopcPoints(samplePath, rootNode);
  const transformPoint = createPointTransformer(metadata);
  const geographicPoint = transformPoint(points[0]);

  assertClose(geographicPoint.longitude, -123.06253409115912, 1e-9);
  assertClose(geographicPoint.latitude, 44.051092079742745, 1e-9);
  assertClose(geographicPoint.height, 129.58902717805427, 1e-9);
});

test('createPointTransformer falls back to geographic coordinates when metadata is already geodetic', () => {
  const transformPoint = createPointTransformer({
    pointCount: 1,
    bounds: {
      minX: -123.1,
      minY: 44,
      minZ: 10,
      maxX: -123,
      maxY: 44.1,
      maxZ: 20,
    },
    wkt: undefined,
  });

  assert.deepEqual(
    transformPoint({
      x: -123.05,
      y: 44.05,
      z: 15,
    }),
    {
      longitude: -123.05,
      latitude: 44.05,
      height: 15,
    },
  );
});

test('toCartesian3Array converts transformed points into Cesium positions', () => {
  const [position] = toCartesian3Array([
    {
      longitude: -123.06253409115912,
      latitude: 44.051092079742745,
      height: 129.58902717805427,
    },
  ]);

  assert.ok(Number.isFinite(position.x));
  assert.ok(Number.isFinite(position.y));
  assert.ok(Number.isFinite(position.z));
});
