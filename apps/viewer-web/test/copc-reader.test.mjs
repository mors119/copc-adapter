import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CopcCesiumLayer,
  CopcJsBackend,
  CopcHierarchyLoadError,
  CopcMetadataError,
  CopcSourceError,
  getCopcPointFieldSelection,
} from '../src/index.ts';
import { Getter } from 'copc';
import {
  toCopcHierarchyNode,
  toCopcHierarchyPage,
} from '../src/copc/adapters/hierarchyAdapter.ts';
import { toCopcPointView } from '../src/copc/backend/copcJsBackend.ts';
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
  validateCopcPointBuffer,
} from '../src/copc/points/loadPointData.ts';
import { createPointReader, readAllPoints } from '../src/copc/points/readPoint.ts';
import {
  createPointTransformer,
  transformPointBuffer,
} from '../src/coordinates/transform/createPointTransformer.ts';
import { buildStreamingHierarchy } from '../src/viewer/streaming/buildStreamingHierarchy.ts';
import { createNodePointCache } from '../src/viewer/streaming/createNodePointCache.ts';
import { NodeSelector } from '../src/viewer/streaming/NodeSelector.ts';
import { extractHorizontalUnitScale } from '../src/coordinates/crs/parseCopcWkt.ts';
import { decodeCopcPointBuffer } from '../src/wasm/copcDecoder.ts';

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
    availableFields: new Set(['position']),
    getter(component) {
      const values = {
        x: [10, 40],
        y: [20, 50],
        z: [30, 60],
      };

      return (index) => values[component][index];
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

test('createCopcContext wraps source failures and preserves their cause', async () => {
  const missingPath = path.resolve(__dirname, 'missing.copc.laz');

  await assert.rejects(
    () => createCopcContext(missingPath),
    (error) => {
      assert.ok(error instanceof CopcSourceError);
      assert.equal(error.stage, 'source');
      assert.equal(error.source, missingPath);
      assert.ok(error.cause);
      assert.match(error.message, /Failed to create COPC source context/);
      assert.match(error.message, /range requests and CORS/);
      return true;
    },
  );
});

test('source errors do not expose URL credentials, query values, or fragments', () => {
  const error = new CopcSourceError(
    'https://reader:secret@example.com/data.copc.laz?token=private#section',
  );

  assert.match(error.message, /https:\/\/example.com\/data.copc.laz/);
  assert.doesNotMatch(error.message, /reader|secret|token|private|section/);
  assert.equal(
    error.source,
    'https://reader:secret@example.com/data.copc.laz?token=private#section',
  );
});

test('loadCopcMetadata wraps metadata read failures and preserves their cause', async () => {
  const cause = new Error('copc.js implementation detail');
  const context = {
    source: 'https://example.com/broken.copc.laz',
    getMetadata() {
      throw cause;
    },
  };

  await assert.rejects(
    () => loadCopcMetadata(context),
    (error) => {
      assert.ok(error instanceof CopcMetadataError);
      assert.equal(error.stage, 'metadata');
      assert.equal(error.source, context.source);
      assert.equal(error.cause, cause);
      assert.doesNotMatch(error.message, /implementation detail/);
      return true;
    },
  );
});

test('loadCopcMetadata rejects projected coordinates without actionable CRS metadata', async () => {
  const context = {
    source: 'https://example.com/missing-crs.copc.laz',
    getMetadata() {
      return {
        pointCount: 1,
        bounds: {
          minX: 635577,
          minY: 848882,
          minZ: 406,
          maxX: 639003,
          maxY: 853537,
          maxZ: 615,
        },
        cube: {
          minX: 635577,
          minY: 848882,
          minZ: 406,
          maxX: 639003,
          maxY: 853537,
          maxZ: 615,
        },
      };
    },
  };

  await assert.rejects(
    () => loadCopcMetadata(context),
    (error) => {
      assert.ok(error instanceof CopcMetadataError);
      assert.equal(error.stage, 'metadata');
      assert.match(error.message, /CRS is missing, malformed, or unsupported/);
      assert.match(error.message, /WKT is required/);
      assert.ok(error.cause);
      return true;
    },
  );
});

test('loadCopcMetadata rejects invalid numeric metadata before hierarchy loading', async () => {
  const validMetadata = {
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
  };
  const cases = [
    {
      metadata: { ...validMetadata, pointCount: -1 },
      message: /pointCount must be a non-negative safe integer/,
    },
    {
      metadata: {
        ...validMetadata,
        bounds: { ...validMetadata.bounds, minX: Number.NaN },
      },
      message: /bounds must contain only finite numbers/,
    },
    {
      metadata: {
        ...validMetadata,
        cube: { ...validMetadata.cube, minZ: 21 },
      },
      message: /cube minimum values must not exceed maximum values/,
    },
    {
      metadata: { ...validMetadata, spacing: 0 },
      message: /spacing must be a positive finite number/,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const context = {
      source: `https://example.com/invalid-${index}.copc.laz`,
      getMetadata: () => testCase.metadata,
    };

    await assert.rejects(
      () => loadCopcMetadata(context),
      (error) => {
        assert.ok(error instanceof CopcMetadataError);
        assert.match(error.message, testCase.message);
        return true;
      },
    );
  }
});

test('loadRootHierarchy wraps hierarchy failures with source context', async () => {
  const cause = new Error('range read failed');
  const context = {
    source: 'https://example.com/broken-hierarchy.copc.laz',
    getRootHierarchyPage() {
      return { key: '0-0-0-0', pageOffset: 128, pageLength: 64 };
    },
    async loadHierarchyPage() {
      throw cause;
    },
  };

  await assert.rejects(
    () => loadRootHierarchy(context),
    (error) => {
      assert.ok(error instanceof CopcHierarchyLoadError);
      assert.equal(error.stage, 'hierarchy');
      assert.equal(error.source, context.source);
      assert.equal(error.cause.cause, cause);
      assert.match(error.message, /broken-hierarchy\.copc\.laz/);
      return true;
    },
  );
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
  assert.ok(view.availableFields.has('intensity'));
  assert.ok(view.availableFields.has('classification'));
  assert.ok(view.availableFields.has('rgb'));

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

test('a fake backend source covers metadata, hierarchy, and point paths', async () => {
  const node = {
    key: '0-0-0-0',
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    pointCount: 1,
    pointDataOffset: 100,
    pointDataLength: 20,
  };
  const view = {
    pointCount: 1,
    availableFields: new Set(['position']),
    getter(component) {
      const values = { x: [-123], y: [44], z: [10] };
      return (index) => values[component][index];
    },
  };
  const source = {
    source: 'memory://fake.copc.laz',
    getMetadata() {
      return {
        pointCount: 1,
        bounds: {
          minX: -123,
          minY: 44,
          minZ: 10,
          maxX: -123,
          maxY: 44,
          maxZ: 10,
        },
        cube: {
          minX: -123,
          minY: 44,
          minZ: 10,
          maxX: -122,
          maxY: 45,
          maxZ: 11,
        },
      };
    },
    getRootHierarchyPage() {
      return { key: node.key, pageOffset: 10, pageLength: 10 };
    },
    async loadHierarchyPage(page) {
      assert.equal(page.key, node.key);
      return { nodes: [node], pages: [] };
    },
    async loadPointDataView(requestedNode, fields) {
      assert.equal(requestedNode.key, node.key);
      assert.deepEqual([...fields], ['position', 'intensity', 'classification', 'rgb']);
      return view;
    },
  };
  const opened = [];
  const backend = {
    async open(sourceUrl) {
      opened.push(sourceUrl);
      return source;
    },
  };
  const decoder = {
    async decode(requestedView) {
      assert.equal(requestedView, view);
      return {
        pointCount: 1,
        coordinates: new Float64Array([-123, 44, 10]),
      };
    },
  };

  const context = await createCopcContext('memory://fake.copc.laz', backend);
  const metadata = await loadCopcMetadata(context);
  const nodes = await loadRootHierarchy(context);
  const pointView = await loadPointDataView(context, nodes[0]);
  const buffer = await loadCopcPointBuffer(context, nodes[0], decoder);

  assert.deepEqual(opened, ['memory://fake.copc.laz']);
  assert.equal(metadata.pointCount, 1);
  assert.deepEqual(nodes, [{ ...node, children: [] }]);
  assert.equal(pointView, view);
  assert.deepEqual(Array.from(buffer.coordinates), [-123, 44, 10]);
});

test('render field selection is minimal and backend-neutral', () => {
  assert.deepEqual([...getCopcPointFieldSelection('fixed')], ['position']);
  assert.deepEqual([...getCopcPointFieldSelection('elevation')], ['position']);
  assert.deepEqual([...getCopcPointFieldSelection('rgb')], ['position', 'rgb']);
  assert.deepEqual([...getCopcPointFieldSelection('intensity')], ['position', 'intensity']);
  assert.deepEqual(
    [...getCopcPointFieldSelection('classification')],
    ['position', 'classification'],
  );
});

test('point view exposes only requested fields and preserves unavailable attributes', () => {
  const sourceView = {
    pointCount: 1,
    dimensions: {
      X: {},
      Y: {},
      Z: {},
      Intensity: {},
      Classification: {},
      Red: {},
      Green: {},
      Blue: {},
    },
    getter(name) {
      return () => ({
        X: 1,
        Y: 2,
        Z: 3,
        Intensity: 4,
        Classification: 5,
        Red: 65535,
        Green: 0,
        Blue: 0,
      }[name]);
    },
  };
  const view = toCopcPointView(sourceView, getCopcPointFieldSelection('fixed'));

  assert.deepEqual([...view.availableFields], ['position']);
  assert.deepEqual(Array.from({ length: 1 }, (_, index) => view.getter('x')(index)), [1]);
  assert.throws(() => view.getter('red'), /unavailable/);
});

test('point view marks a source field unavailable when its source component is missing', () => {
  const view = toCopcPointView(
    {
      pointCount: 1,
      dimensions: { X: {}, Y: {}, Z: {}, Red: {}, Green: {} },
      getter() {
        return () => 0;
      },
    },
    getCopcPointFieldSelection('rgb'),
  );

  assert.deepEqual([...view.availableFields], ['position']);

  const classificationView = toCopcPointView(
    {
      pointCount: 1,
      dimensions: { X: {}, Y: {}, Z: {} },
      getter() {
        return () => 0;
      },
    },
    getCopcPointFieldSelection('classification'),
  );

  assert.deepEqual([...classificationView.availableFields], ['position']);
});

test('point buffer validation rejects partial coordinate and attribute arrays', () => {
  assert.throws(
    () => validateCopcPointBuffer({
      pointCount: 2,
      coordinates: new Float64Array([1, 2, 3]),
    }),
    /three values per point/,
  );
  assert.throws(
    () => validateCopcPointBuffer({
      pointCount: 2,
      coordinates: new Float64Array([1, 2, 3, 4, 5, 6]),
      attributes: { intensity: new Uint16Array([1]) },
    }),
    /attribute length mismatch: intensity/,
  );
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
  assert.deepEqual(Array.from(buffer.attributes.intensity.slice(0, 2)), [
    29952,
    18688,
  ]);
  assert.deepEqual(Array.from(buffer.attributes.classification.slice(0, 2)), [
    2,
    2,
  ]);
  assert.deepEqual(Array.from(buffer.attributes.red.slice(0, 2)), [
    44544,
    22016,
  ]);
  assert.deepEqual(Array.from(buffer.attributes.green.slice(0, 2)), [
    44032,
    28416,
  ]);
  assert.deepEqual(Array.from(buffer.attributes.blue.slice(0, 2)), [
    37632,
    27648,
  ]);
  assert.equal(buffer.attributes.intensity.length, buffer.pointCount);
  assert.equal(buffer.attributes.classification.length, buffer.pointCount);
  assert.equal(buffer.attributes.red.length, buffer.pointCount);
  assert.equal(buffer.attributes.green.length, buffer.pointCount);
  assert.equal(buffer.attributes.blue.length, buffer.pointCount);
});

test('decodeCopcPointBuffer omits attributes absent from the point format', async () => {
  const values = {
    X: [10, 40],
    Y: [20, 50],
    Z: [30, 60],
    Intensity: [1024, 2048],
    Classification: [2, 6],
  };
  const buffer = await decodeCopcPointBuffer({
    pointCount: 2,
    availableFields: new Set(['position', 'intensity', 'classification']),
    getter(component) {
      const components = {
        x: 'X',
        y: 'Y',
        z: 'Z',
        intensity: 'Intensity',
        classification: 'Classification',
      };
      if (!(components[component] in values)) {
        throw new Error(`No extractor for component: ${component}`);
      }

      return (index) => values[components[component]][index];
    },
  });

  assert.deepEqual(Array.from(buffer.coordinates), [
    10, 20, 30,
    40, 50, 60,
  ]);
  assert.deepEqual(Array.from(buffer.attributes.intensity), [1024, 2048]);
  assert.deepEqual(Array.from(buffer.attributes.classification), [2, 6]);
  assert.equal(buffer.attributes.red, undefined);
  assert.equal(buffer.attributes.green, undefined);
  assert.equal(buffer.attributes.blue, undefined);

  const xyzOnlyBuffer = await decodeCopcPointBuffer({
    pointCount: 2,
    availableFields: new Set(['position']),
    getter(component) {
      const components = { x: 'X', y: 'Y', z: 'Z' };
      return (index) => values[components[component]][index];
    },
  });

  assert.equal(xyzOnlyBuffer.attributes, undefined);
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

test('transformPointBuffer preserves optional COPC point attributes', () => {
  const attributes = {
    intensity: new Uint16Array([1024]),
    classification: new Uint8Array([2]),
    red: new Uint16Array([65535]),
    green: new Uint16Array([32768]),
    blue: new Uint16Array([0]),
  };
  const geographicBuffer = transformPointBuffer({
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
  }, {
    pointCount: 1,
    coordinates: new Float64Array([-123.05, 44.05, 15]),
    attributes,
  });

  assert.equal(geographicBuffer.coordinates[2], 15);
  assert.equal(geographicBuffer.attributes, attributes);
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

test('Autzen uses the projected linear unit for streaming size and refines', async () => {
  const metadata = await loadCopcMetadata(samplePath);
  const nodes = await loadRootHierarchy(samplePath);
  const hierarchy = buildStreamingHierarchy(metadata, nodes);
  const rootNode = hierarchy.get('0-0-0-0');

  assert.ok(rootNode);
  assert.equal(extractHorizontalUnitScale(metadata.wkt), 0.3048);
  assert.ok(rootNode.children.length > 0);
  assert.ok(rootNode.approximateSizeMeters > 1418);
  assert.ok(rootNode.approximateSizeMeters < 1420);

  const selector = new NodeSelector({
    maxNodes: 24,
    maxDepth: 6,
    refineDistanceMultiplier: 6,
    maxRenderDistanceMeters: 12000,
  });
  const farSelection = selector.selectVisibleNodes({
    longitude: rootNode.center.longitude,
    latitude: rootNode.center.latitude,
    height: 100000,
    viewDistanceMeters: 200000,
  }, hierarchy);
  const nearSelection = selector.selectVisibleNodes({
    longitude: rootNode.center.longitude,
    latitude: rootNode.center.latitude,
    height: 1000,
    viewDistanceMeters: 6000,
  }, hierarchy);

  assert.deepEqual(farSelection.map((entry) => entry.node.key), ['0-0-0-0']);
  assert.ok(nearSelection.length > farSelection.length);
  assert.ok(nearSelection.length <= 24);
  assert.ok(nearSelection.every((entry) => entry.node.level > 0));
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

test('public API exports CopcCesiumLayer', () => {
  assert.equal(typeof CopcCesiumLayer, 'function');
  assert.equal(typeof CopcJsBackend, 'function');
});

test('CopcCesiumLayer snapshot exposes lifecycle and dataset info', () => {
  const layer = new CopcCesiumLayer({
    url: '/samples/autzen.copc.laz',
  });

  assert.deepEqual(layer.getSnapshot(), {
    lifecycle: 'idle',
    renderedNodeKeys: [],
    selectedNodeKeys: [],
    renderedPointCount: 0,
    streamingUpdateCount: 0,
    datasetUrl: '/samples/autzen.copc.laz',
    attached: false,
    backend: 'copc-js',
  });

  layer.destroy();

  assert.equal(layer.getSnapshot().lifecycle, 'destroyed');
});

test('CopcCesiumLayer reports the selected backend without changing its viewer boundary', () => {
  const layer = new CopcCesiumLayer({
    url: '/samples/autzen.copc.laz',
    backend: 'rust',
  });

  assert.equal(layer.getSnapshot().backend, 'rust');
});

test('CopcCesiumLayer metadata API is empty before load', () => {
  const layer = new CopcCesiumLayer({
    url: '/samples/autzen.copc.laz',
  });

  assert.equal(layer.getMetadata(), undefined);
});

test('CopcCesiumLayer loads, unloads, and reloads a COPC URL before attachment', async () => {
  const layer = new CopcCesiumLayer({
    url: samplePath,
  });

  await layer.load();

  assert.equal(layer.getSnapshot().lifecycle, 'ready');
  assert.equal(layer.getSnapshot().attached, false);
  assert.equal(layer.getMetadata()?.pointCount, 10653336);

  layer.unload();
  assert.equal(layer.getSnapshot().lifecycle, 'idle');
  assert.equal(layer.getMetadata(), undefined);

  await layer.reload();
  assert.equal(layer.getMetadata()?.pointCount, 10653336);

  layer.destroy();
});

test('CopcCesiumLayer rejects loading after destroy', async () => {
  const layer = new CopcCesiumLayer({
    url: '/samples/autzen.copc.laz',
  });
  layer.destroy();

  await assert.rejects(() => layer.load(), /CopcCesiumLayer has been destroyed/);
});
