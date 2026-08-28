import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CopcBackendError,
  CopcJsBackend,
  InMemoryByteSource,
  RustCopcBackend,
} from '../src/index.ts';
import { HierarchyLoader } from '../src/copc/hierarchy/HierarchyLoader.ts';
import { createPointTransformer } from '../src/coordinates/transform/createPointTransformer.ts';
import { extractHorizontalUnitScale } from '../src/coordinates/crs/parseCopcWkt.ts';
import {
  assertHierarchyParity,
  assertMetadataParity,
  assertPointParity,
  openBackendPair,
  pointSampleIndices,
  runBackendContract,
} from './support/backend-contract.mjs';
import { createDeterministicCopcFixture, mutateU32 } from './support/copc-fixture.mjs';

const samplePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../samples/local/autzen.copc.laz',
);
const skipIntegration = process.env.CONFORMANCE_SKIP_INTEGRATION === '1';

async function withFixture(callback, options) {
  const fixture = createDeterministicCopcFixture(options);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'copc-conformance-'));
  const fixturePath = path.join(directory, 'fixture.copc.laz');
  await writeFile(fixturePath, fixture.bytes);
  try {
    return await callback(fixture, fixturePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function captureError(action) {
  try {
    await action();
    assert.fail('expected operation to fail');
  } catch (error) {
    assert.ok(error instanceof CopcBackendError, error);
    return { stage: error.stage, code: error.code };
  }
}

test('shared backend contract covers deterministic metadata and hierarchy semantics', async () => {
  await withFixture(async (fixture, fixturePath) => {
    await runBackendContract({
      source: fixturePath,
      bytes: fixture.bytes,
      async assertContract({ rust, copcJs }) {
        const metadata = rust.getMetadata();
        assert.equal(metadata.pointCount, 42);
        assert.deepEqual(metadata.bounds, {
          minX: 1, minY: 2, minZ: 3, maxX: 100, maxY: 200, maxZ: 300,
        });
        assert.deepEqual(metadata.scale, { x: 0.01, y: 0.02, z: 0.03 });
        assert.deepEqual(metadata.offset, { x: 10, y: 20, z: 30 });
        assert.equal(metadata.spacing, 2.5);
        assert.deepEqual(metadata.cube, {
          minX: 40, minY: 50, minZ: 60, maxX: 60, maxY: 70, maxZ: 80,
        });
        assert.equal(metadata.wkt, 'PROJCS["Fixture CRS"]');
        assertMetadataParity(metadata, copcJs.getMetadata());

        const { rustEntries } = await assertHierarchyParity(rust, copcJs);
        assert.deepEqual(rustEntries, [
          {
            key: '0-0-0-0', kind: 'node', level: 0, x: 0, y: 0, z: 0,
            pointCount: 100, offset: 1200, length: 10,
          },
          {
            key: '1-0-0-0', kind: 'node', level: 1, x: 0, y: 0, z: 0,
            pointCount: 60, offset: 1300, length: 20,
          },
          {
            key: '1-1-0-0', kind: 'node', level: 1, x: 1, y: 0, z: 0,
            pointCount: 40, offset: 1400, length: 5,
          },
          {
            key: '1-1-0-0', kind: 'page', pointCount: null, offset: 2048, length: 64,
          },
          {
            key: '2-3-0-0', kind: 'node', level: 2, x: 3, y: 0, z: 0,
            pointCount: 20, offset: 1500, length: 6,
          },
        ]);
      },
    });
  });
});

test('shared backend contract covers incremental hierarchy discovery from #41', async () => {
  await withFixture(async (fixture, fixturePath) => {
    const { rust, copcJs } = await openBackendPair(fixturePath, fixture.bytes);
    const loaders = [
      new HierarchyLoader(rust, rust.getMetadata().cube),
      new HierarchyLoader(copcJs, copcJs.getMetadata().cube),
    ];

    const shallowTrees = await Promise.all(loaders.map((loader) => loader.query({
      bounds: rust.getMetadata().cube,
      maxLevel: 0,
    })));
    for (const tree of shallowTrees) {
      assert.deepEqual(tree.nodes.map((node) => node.key), ['0-0-0-0']);
      assert.equal(tree.pages.length, 1);
    }
    assert.deepEqual(
      loaders.map((loader) => loader.getDiagnostics()),
      [
        {
          pageRequests: 1, pageCacheHits: 0, hierarchyBytesFetched: fixture.rootPage.pageLength,
          loadedPageCount: 1, loadedEntryCount: 3,
        },
        {
          pageRequests: 1, pageCacheHits: 0, hierarchyBytesFetched: fixture.rootPage.pageLength,
          loadedPageCount: 1, loadedEntryCount: 3,
        },
      ],
    );

    const deepTrees = await Promise.all(loaders.map((loader) => loader.query({
      bounds: rust.getMetadata().cube,
      maxLevel: 2,
    })));
    assert.deepEqual(
      deepTrees.map((tree) => tree.nodes.map((node) => node.key)),
      [
        ['0-0-0-0', '1-0-0-0', '1-1-0-0', '2-3-0-0'],
        ['0-0-0-0', '1-0-0-0', '1-1-0-0', '2-3-0-0'],
      ],
    );
    assert.deepEqual(
      loaders.map((loader) => loader.getDiagnostics().pageRequests),
      [2, 2],
    );
  });
});

test('Rust range instrumentation proves metadata, hierarchy, and node reads stay partial', async () => {
  const fixture = createDeterministicCopcFixture();
  class RecordingByteSource extends InMemoryByteSource {
    requests = [];

    async readRange(offset, length, options) {
      this.requests.push({ offset, length });
      return super.readRange(offset, length, options);
    }
  }

  const byteSource = new RecordingByteSource(fixture.bytes, 'memory://range-fixture');
  const source = await new RustCopcBackend({
    createByteSource: () => byteSource,
  }).open(byteSource.source);
  const root = await source.loadHierarchyPage(source.getRootHierarchyPage());
  await assert.rejects(
    () => source.loadPointDataView(root.nodes[0], new Set(['position'])),
    (error) => error instanceof CopcBackendError
      && error.stage === 'decode'
      && error.code === 'laz-decode',
  );

  assert.deepEqual(byteSource.requests, [
    { offset: 0, length: 375 },
    { offset: 0, length: fixture.pointDataOffset },
    { offset: fixture.rootPage.pageOffset, length: fixture.rootPage.pageLength },
    { offset: 1200, length: 10 },
  ]);
  assert.ok(byteSource.requests.every(({ length }) => length < fixture.bytes.length));
  assert.ok(byteSource.requests.reduce((total, { length }) => total + length, 0) < fixture.bytes.length);
});

test('both backends expose equivalent structured stages for deterministic failures', async () => {
  const fixture = createDeterministicCopcFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'copc-error-conformance-'));
  try {
    const fixturePath = path.join(directory, 'fixture.copc.laz');
    await writeFile(fixturePath, fixture.bytes);
    const rustBackend = new RustCopcBackend({
      createByteSource: (source) => source === 'memory://missing'
        ? new InMemoryByteSource(new Uint8Array(10), source)
        : new InMemoryByteSource(fixture.bytes, source),
    });
    const copcJsBackend = new CopcJsBackend();

    assert.deepEqual(
      await Promise.all([
        captureError(() => rustBackend.open('memory://missing')),
        captureError(() => copcJsBackend.open(path.join(directory, 'missing.copc.laz'))),
      ]),
      [
        { stage: 'source', code: 'source-range' },
        { stage: 'source', code: 'source-range' },
      ],
    );

    const malformedHeader = fixture.bytes.slice();
    malformedHeader[0] = 0;
    const malformedHeaderPath = path.join(directory, 'malformed-header.copc.laz');
    await writeFile(malformedHeaderPath, malformedHeader);
    assert.deepEqual(
      await Promise.all([
        captureError(() => new RustCopcBackend({
          createByteSource: (source) => new InMemoryByteSource(malformedHeader, source),
        }).open('memory://malformed-header')),
        captureError(() => copcJsBackend.open(malformedHeaderPath)),
      ]),
      [
        { stage: 'metadata', code: 'header-parse' },
        { stage: 'metadata', code: 'header-parse' },
      ],
    );

    const malformedHierarchy = createDeterministicCopcFixture({ rootPageLength: 65 });
    const malformedHierarchyPath = path.join(directory, 'malformed-hierarchy.copc.laz');
    await writeFile(malformedHierarchyPath, malformedHierarchy.bytes);
    const rustHierarchy = await new RustCopcBackend({
      createByteSource: (source) => new InMemoryByteSource(malformedHierarchy.bytes, source),
    }).open('memory://malformed-hierarchy');
    const copcJsHierarchy = await copcJsBackend.open(malformedHierarchyPath);
    assert.deepEqual(
      await Promise.all([
        captureError(() => rustHierarchy.loadHierarchyPage(rustHierarchy.getRootHierarchyPage())),
        captureError(() => copcJsHierarchy.loadHierarchyPage(copcJsHierarchy.getRootHierarchyPage())),
      ]),
      [
        { stage: 'hierarchy', code: 'hierarchy' },
        { stage: 'hierarchy', code: 'hierarchy' },
      ],
    );

    const rustPoint = await rustBackend.open('memory://point-decode');
    const copcJsPoint = await copcJsBackend.open(fixturePath);
    const rustNode = (await rustPoint.loadHierarchyPage(rustPoint.getRootHierarchyPage())).nodes[0];
    const copcJsNode = (await copcJsPoint.loadHierarchyPage(copcJsPoint.getRootHierarchyPage())).nodes[0];
    mutateU32(fixture.bytes, 1230, 1);
    await writeFile(fixturePath, fixture.bytes);
    const malformedRustNode = {
      ...rustNode,
      pointCount: 2,
      pointDataLength: 34,
    };
    const malformedCopcJsNode = {
      ...copcJsNode,
      pointCount: 2,
      pointDataLength: 34,
    };
    assert.deepEqual(
      await Promise.all([
        captureError(() => rustPoint.loadPointDataView(malformedRustNode, new Set(['position']))),
        captureError(() => copcJsPoint.loadPointDataView(malformedCopcJsNode, new Set(['position']))),
      ]),
      [
        { stage: 'decode', code: 'laz-decode' },
        { stage: 'decode', code: 'laz-decode' },
      ],
    );

    assert.deepEqual(
      await Promise.all([
        captureError(() => rustPoint.loadPointDataView(rustNode, new Set(['intensity']))),
        captureError(() => copcJsPoint.loadPointDataView(copcJsNode, new Set(['intensity']))),
      ]),
      [
        { stage: 'decode', code: 'unsupported' },
        { stage: 'decode', code: 'unsupported' },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Autzen backend contract compares metadata, hierarchy, and sampled point attributes', {
  skip: skipIntegration || !existsSync(samplePath),
}, async () => {
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(samplePath));
  const { rust, copcJs } = await openBackendPair(samplePath, bytes);
  assertMetadataParity(rust.getMetadata(), copcJs.getMetadata());
  const rootPage = await rust.loadHierarchyPage(rust.getRootHierarchyPage());
  const rootNode = rootPage.nodes.find((node) => node.key === '0-0-0-0');
  assert.ok(rootNode);

  await assertPointParity(rust, copcJs, rootNode);
  assert.ok(pointSampleIndices(rootNode.pointCount).length >= 5);

  for (const field of ['intensity', 'classification', 'rgb']) {
    await assertPointParity(rust, copcJs, rootNode, new Set(['position', field]));
    const rustView = await rust.loadPointDataView(rootNode, new Set(['position', field]));
    const copcJsView = await copcJs.loadPointDataView(rootNode, new Set(['position', field]));
    assert.deepEqual([...rustView.availableFields].sort(), ['position', field].sort());
    assert.deepEqual([...copcJsView.availableFields].sort(), ['position', field].sort());
    for (const unrequestedField of ['intensity', 'classification', 'rgb']
      .filter((candidate) => candidate !== field)) {
      assert.equal(rustView.availableFields.has(unrequestedField), false);
      assert.equal(copcJsView.availableFields.has(unrequestedField), false);
    }
  }

  const positionOnlyRust = await rust.loadPointDataView(rootNode, new Set(['position']));
  const positionOnlyJs = await copcJs.loadPointDataView(rootNode, new Set(['position']));
  assert.deepEqual([...positionOnlyRust.availableFields], ['position']);
  assert.deepEqual([...positionOnlyJs.availableFields], ['position']);
  for (const component of ['intensity', 'classification', 'red', 'green', 'blue']) {
    assert.throws(() => positionOnlyRust.getter(component)(0), /unavailable/i);
    assert.throws(() => positionOnlyJs.getter(component)(0), /unavailable/i);
  }

  const allFields = new Set(['position', 'intensity', 'classification', 'rgb']);
  const rustBuffer = await rust.loadPointDataBuffer(rootNode, allFields);
  assert.equal(rustBuffer.pointCount, rootNode.pointCount);
  assert.equal(rustBuffer.coordinates.length, rootNode.pointCount * 3);
  assert.equal(rustBuffer.attributes.intensity.length, rootNode.pointCount);
  assert.equal(rustBuffer.attributes.classification.length, rootNode.pointCount);
  assert.equal(rustBuffer.attributes.red.length, rootNode.pointCount);
  assert.equal(rustBuffer.attributes.green.length, rootNode.pointCount);
  assert.equal(rustBuffer.attributes.blue.length, rootNode.pointCount);
});

test('Autzen range instrumentation proves the selected node uses its exact chunk range', {
  skip: skipIntegration || !existsSync(samplePath),
}, async () => {
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(samplePath));
  class RecordingByteSource extends InMemoryByteSource {
    requests = [];

    async readRange(offset, length, options) {
      this.requests.push({ offset, length });
      return super.readRange(offset, length, options);
    }
  }

  const byteSource = new RecordingByteSource(bytes, samplePath);
  const rust = await new RustCopcBackend({ createByteSource: () => byteSource }).open(samplePath);
  const root = (await rust.loadHierarchyPage(rust.getRootHierarchyPage())).nodes
    .find((node) => node.key === '0-0-0-0');
  assert.ok(root);
  await rust.loadPointDataBuffer(root, new Set(['position', 'intensity', 'classification', 'rgb']));

  assert.ok(byteSource.requests.some(({ offset, length }) =>
    offset === root.pointDataOffset && length === root.pointDataLength));
  assert.ok(byteSource.requests.every(({ length }) => length < bytes.length));
  assert.ok(byteSource.requests.reduce((total, { length }) => total + length, 0) < bytes.length);
});

test('coordinate contract rejects axis, scale/offset, height, and projected-unit regressions', {
  skip: skipIntegration || !existsSync(samplePath),
}, async () => {
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(samplePath));
  const { rust, copcJs } = await openBackendPair(samplePath, bytes);
  const metadata = rust.getMetadata();
  assert.ok(metadata.scale.x > 0 && metadata.scale.y > 0 && metadata.scale.z > 0);
  assert.ok(Number.isFinite(metadata.offset.x));
  assert.ok(Number.isFinite(metadata.offset.y));
  assert.ok(Number.isFinite(metadata.offset.z));
  assert.ok(metadata.bounds.maxZ > metadata.bounds.minZ, 'height must not be flattened');

  const node = (await rust.loadHierarchyPage(rust.getRootHierarchyPage())).nodes
    .find((entry) => entry.key === '0-0-0-0');
  const rustView = await rust.loadPointDataView(node, new Set(['position']));
  const copcJsView = await copcJs.loadPointDataView(node, new Set(['position']));
  const index = pointSampleIndices(node.pointCount)[3];
  const rustPoint = ['x', 'y', 'z'].map((component) => rustView.getter(component)(index));
  const copcJsPoint = ['x', 'y', 'z'].map((component) => copcJsView.getter(component)(index));
  assert.ok(Math.abs(rustPoint[0] - rustPoint[1]) > 1, 'X/Y must remain distinct');
  assert.ok(Math.abs(rustPoint[2] - rustPoint[0]) > 1, 'height must remain distinct');
  assert.deepEqual(rustPoint, copcJsPoint);
  assert.ok(Math.abs(rustPoint[0] - metadata.offset.x) > metadata.scale.x);
  assert.ok(Math.abs(rustPoint[1] - metadata.offset.y) > metadata.scale.y);
  assert.ok(Math.abs(rustPoint[2] - metadata.offset.z) > metadata.scale.z);

  // Stable facts from the official Autzen sample, independently checked from
  // its LAS integer coordinates and header scale/offset.
  const firstPoint = [
    rustView.getter('x')(0),
    rustView.getter('y')(0),
    rustView.getter('z')(0),
  ];
  assert.deepEqual(firstPoint, [
    157440 * metadata.scale.x + metadata.offset.x,
    -192989 * metadata.scale.y + metadata.offset.y,
    -8554 * metadata.scale.z + metadata.offset.z,
  ]);

  const transform = createPointTransformer(metadata);
  const geographic = transform({ x: firstPoint[0], y: firstPoint[1], z: firstPoint[2] });
  assert.ok(Math.abs(geographic.longitude - -123.06253409115912) < 1e-9);
  assert.ok(Math.abs(geographic.latitude - 44.051092079742745) < 1e-9);
  assert.ok(Math.abs(geographic.height - 129.58902717805427) < 1e-9);
  assert.equal(extractHorizontalUnitScale(metadata.wkt), 0.3048);
});
