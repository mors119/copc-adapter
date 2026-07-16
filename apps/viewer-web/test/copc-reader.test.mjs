import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CopcViewer as PublicCopcViewer,
  createCopcViewer,
} from '../src/index.ts';
import { Getter } from 'copc';
import {
  toCopcHierarchyNode,
  toCopcHierarchyPage,
} from '../src/copc/adapters/hierarchyAdapter.ts';
import { toCopcMetadata } from '../src/copc/adapters/metadataAdapter.ts';
import { createCopcContext } from '../src/copc/context/createCopcContext.ts';
import { createCopcGetter } from '../src/copc/getter/createCopcGetter.ts';
import { toCartesian3Array } from '../src/cesium/render/renderPoints.ts';
import { loadRootHierarchy } from '../src/copc/hierarchy/loadRootHierarchy.ts';
import { loadCopcMetadata } from '../src/copc/metadata/loadMetadata.ts';
import {
  loadCopcPointBuffer,
  loadCopcPoints,
  loadPointDataView,
} from '../src/copc/points/loadPointData.ts';
import { createPointReader, readAllPoints } from '../src/copc/points/readPoint.ts';
import {
  createPointTransformer,
  transformPointBuffer,
} from '../src/coordinates/transform/createPointTransformer.ts';
import { buildStreamingHierarchy } from '../src/viewer/streaming/buildStreamingHierarchy.ts';
import { createNodePointCache } from '../src/viewer/streaming/createNodePointCache.ts';

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

test('toCopcHierarchyPage maps hierarchy page offsets', () => {
  assert.deepEqual(
    toCopcHierarchyPage('1-0-0-0', {
      pageOffset: 256,
      pageLength: 512,
    }),
    {
      key: '1-0-0-0',
      pageOffset: 256,
      pageLength: 512,
    },
  );
});

test('toCopcMetadata maps header and cube data to project metadata', () => {
  assert.deepEqual(
    toCopcMetadata({
      header: {
        pointCount: 10,
        min: [1, 2, 3],
        max: [4, 5, 6],
        scale: [0.1, 0.2, 0.3],
        offset: [7, 8, 9],
      },
      info: {
        spacing: 4.5,
        cube: [11, 12, 13, 14, 15, 16],
      },
      wkt: 'GEOGCS["WGS 84"]',
    }),
    {
      pointCount: 10,
      bounds: {
        minX: 1,
        minY: 2,
        minZ: 3,
        maxX: 4,
        maxY: 5,
        maxZ: 6,
      },
      spacing: 4.5,
      scale: {
        x: 0.1,
        y: 0.2,
        z: 0.3,
      },
      offset: {
        x: 7,
        y: 8,
        z: 9,
      },
      cube: {
        minX: 11,
        minY: 12,
        minZ: 13,
        maxX: 14,
        maxY: 15,
        maxZ: 16,
      },
      wkt: 'GEOGCS["WGS 84"]',
    },
  );
});

test('createCopcGetter chooses HTTP, browser-relative, and local getters correctly', () => {
  const originalWindow = globalThis.window;
  const originalHttp = Getter.http;
  const originalCreate = Getter.create;
  const calls = [];

  Getter.http = (source) => {
    calls.push(['http', source]);
    return { kind: 'http', source };
  };
  Getter.create = (source) => {
    calls.push(['create', source]);
    return { kind: 'create', source };
  };

  assert.deepEqual(createCopcGetter('https://example.com/data.copc.laz'), {
    kind: 'http',
    source: 'https://example.com/data.copc.laz',
  });

  globalThis.window = {
    location: {
      href: 'https://viewer.example/app/',
    },
  };

  assert.deepEqual(createCopcGetter('/samples/autzen.copc.laz'), {
    kind: 'http',
    source: 'https://viewer.example/samples/autzen.copc.laz',
  });

  globalThis.window = undefined;

  assert.deepEqual(createCopcGetter(samplePath), {
    kind: 'create',
    source: samplePath,
  });
  assert.deepEqual(calls, [
    ['http', 'https://example.com/data.copc.laz'],
    ['http', 'https://viewer.example/samples/autzen.copc.laz'],
    ['create', samplePath],
  ]);

  Getter.http = originalHttp;
  Getter.create = originalCreate;
  globalThis.window = originalWindow;
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

test('createCopcContext initializes reusable COPC state', async () => {
  const context = await createCopcContext(samplePath);
  const metadata = context.getMetadata();

  assert.equal(context.source, samplePath);
  assert.equal(metadata.pointCount, 10653336);
  assert.equal(metadata.spacing, 36.37117187500007);
});

test('loadCopcMetadata supports a shared context', async () => {
  const context = await createCopcContext(samplePath);
  const metadata = await loadCopcMetadata(context);

  assert.equal(metadata.pointCount, 10653336);
  assert.equal(metadata.bounds.minX, 635577.79);
  assert.match(metadata.wkt, /PROJCS\["NAD83 \/ Oregon GIC Lambert \(ft\)"/);
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
  assert.deepEqual(metadata.cube, {
    minX: 635577.79,
    minY: 848882.15,
    minZ: 406.1400000000003,
    maxX: 640233.3,
    maxY: 853537.66,
    maxZ: 5061.65000000001,
  });
  assert.match(metadata.wkt, /PROJCS\["NAD83 \/ Oregon GIC Lambert \(ft\)"/);
});

test('loadRootHierarchy returns traversed sample hierarchy nodes', async () => {
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
    children: ['1-0-0-0', '1-1-0-0', '1-0-1-0', '1-1-1-0'],
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

test('shared context loads point data without recreating source inputs', async () => {
  const context = await createCopcContext(samplePath);
  const nodes = await loadRootHierarchy(context);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);

  const view = await loadPointDataView(context, rootNode);
  const buffer = await loadCopcPointBuffer(context, rootNode);

  assert.equal(view.pointCount, 61201);
  assert.equal(buffer.pointCount, 61201);
  assert.deepEqual(Array.from(buffer.coordinates.slice(0, 3)), [
    638865.15,
    849280.01,
    425.15999999999997,
  ]);
});

test('loadCopcPointBuffer decodes sample points through Rust WASM', async () => {
  const nodes = await loadRootHierarchy(samplePath);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);

  const buffer = await loadCopcPointBuffer(samplePath, rootNode);

  assert.equal(buffer.pointCount, 61201);
  assert.equal(buffer.coordinates.length, 183603);
  assert.deepEqual(Array.from(buffer.coordinates.slice(0, 6)), [
    638865.15,
    849280.01,
    425.15999999999997,
    638852.82,
    849328.6,
    424.53999999999996,
  ]);
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

test('transformPointBuffer converts interleaved buffers to geographic triples', async () => {
  const metadata = await loadCopcMetadata(samplePath);
  const nodes = await loadRootHierarchy(samplePath);
  const rootNode = nodes.find((node) => node.key === '0-0-0-0');

  assert.ok(rootNode);

  const pointBuffer = await loadCopcPointBuffer(samplePath, rootNode);
  const geographicBuffer = transformPointBuffer(metadata, pointBuffer);

  assert.equal(geographicBuffer.pointCount, 61201);
  assertClose(geographicBuffer.coordinates[0], -123.06253409115912, 1e-9);
  assertClose(geographicBuffer.coordinates[1], 44.051092079742745, 1e-9);
  assertClose(geographicBuffer.coordinates[2], 129.58902717805427, 1e-9);
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
    cube: {
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

test('buildStreamingHierarchy links children and computes node centers', async () => {
  const metadata = await loadCopcMetadata(samplePath);
  const nodes = await loadRootHierarchy(samplePath);
  const hierarchy = buildStreamingHierarchy(metadata, nodes);
  const rootNode = hierarchy.get('0-0-0-0');
  const childNode = hierarchy.get('1-0-0-0');

  assert.ok(rootNode);
  assert.ok(childNode);
  assert.deepEqual(rootNode.children.sort(), [
    '1-0-0-0',
    '1-0-1-0',
    '1-1-0-0',
    '1-1-1-0',
  ]);
  assert.ok(rootNode.approximateSizeMeters > childNode.approximateSizeMeters);
  assert.ok(rootNode.boundingRadiusMeters > childNode.boundingRadiusMeters);
  assert.ok(rootNode.bounds.minX < rootNode.bounds.maxX);
  assert.ok(rootNode.bounds.minY < rootNode.bounds.maxY);
  assertClose(rootNode.center.longitude, -123.0664124403113, 1e-9);
  assertClose(rootNode.center.latitude, 44.056302479022975, 1e-9);
});

test('createNodePointCache deduplicates repeated node loads', async () => {
  let callCount = 0;
  const cache = createNodePointCache(async (nodeKey) => {
    callCount += 1;

    return [{ longitude: -123, latitude: 44, height: nodeKey.length }];
  }, { maxEntries: 2 });

  const [first, second] = await Promise.all([
    cache.load('1-0-0-0'),
    cache.load('1-0-0-0'),
  ]);

  assert.equal(callCount, 1);
  assert.equal(cache.getSize(), 1);
  assert.equal(cache.has('1-0-0-0'), true);
  assert.deepEqual(first, second);
});

test('createNodePointCache evicts the least recently used entry', async () => {
  const cache = createNodePointCache(async (nodeKey) => nodeKey, {
    maxEntries: 2,
  });

  await cache.load('0-0-0-0');
  await cache.load('1-0-0-0');
  await cache.load('0-0-0-0');
  await cache.load('2-0-0-0');

  assert.equal(cache.getSize(), 2);
  assert.equal(cache.has('0-0-0-0'), true);
  assert.equal(cache.has('1-0-0-0'), false);
  assert.equal(cache.has('2-0-0-0'), true);
});

test('createNodePointCache clears stored entries', async () => {
  const cache = createNodePointCache(async (nodeKey) => nodeKey, {
    maxEntries: 3,
  });

  await cache.load('0-0-0-0');
  await cache.load('1-0-0-0');
  cache.clear();

  assert.equal(cache.getSize(), 0);
  assert.equal(cache.has('0-0-0-0'), false);
  assert.equal(cache.has('1-0-0-0'), false);
});

test('public API exports CopcViewer and createCopcViewer', () => {
  assert.equal(typeof PublicCopcViewer, 'function');
  assert.equal(typeof createCopcViewer, 'function');
});

test('CopcViewer snapshot exposes lifecycle and dataset info', () => {
  const viewer = new PublicCopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  assert.deepEqual(viewer.getSnapshot(), {
    lifecycle: 'idle',
    renderedNodeKeys: [],
    selectedNodeKeys: [],
    renderedPointCount: 0,
    datasetUrl: '/samples/autzen.copc.laz',
  });

  viewer.destroy();

  assert.equal(viewer.getSnapshot().lifecycle, 'destroyed');
});

test('CopcViewer metadata API is empty before load', () => {
  const viewer = new PublicCopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  assert.equal(viewer.getMetadata(), undefined);
});

test('CopcViewer load rejects when init has not run', async () => {
  const viewer = new PublicCopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  await assert.rejects(
    () => viewer.load(),
    /CopcViewer must be initialized before load/,
  );
});

test('CopcViewer selection bounding sphere is empty before rendering', () => {
  const viewer = new PublicCopcViewer({
    container: 'cesium-container',
    url: '/samples/autzen.copc.laz',
  });

  assert.equal(viewer.getSelectionBoundingSphere(), undefined);
});
