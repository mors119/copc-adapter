import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CopcJsBackend,
  CopcBackendError,
  InMemoryByteSource,
  RustCopcParseError,
  RustCopcBackend,
  RustCopcReader,
} from '../src/index.ts';
import {
  assertMetadataParity,
  assertPointParity,
  assertRootHierarchyParity,
  openBackendPair,
} from './support/backend-contract.mjs';
import { HierarchyLoader } from '../src/copc/hierarchy/HierarchyLoader.ts';

const samplePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../samples/local/autzen.copc.laz',
);

function putU16(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

function putU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

function putI32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(offset, value, true);
}

function putU64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(value), true);
}

function putI64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigInt64(offset, BigInt(value), true);
}

function putF64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat64(offset, value, true);
}

function putVlr(bytes, offset, userId, recordId, payload) {
  const encodedUserId = new TextEncoder().encode(userId);
  bytes.set(encodedUserId.subarray(0, 16), offset + 2);
  putU16(bytes, offset + 18, recordId);
  putU16(bytes, offset + 20, payload.length);
  bytes.set(payload, offset + 54);
  return offset + 54 + payload.length;
}

function makeFixture({ rootPageLength = 96 } = {}) {
  const headerSize = 375;
  const copcPayload = new Uint8Array(160);
  putF64(copcPayload, 0, 50);
  putF64(copcPayload, 8, 60);
  putF64(copcPayload, 16, 70);
  putF64(copcPayload, 24, 10);
  putF64(copcPayload, 32, 2.5);

  const wkt = new TextEncoder().encode('PROJCS["Fixture CRS"]\0');
  const copcVlrOffset = headerSize;
  const pointDataOffset = headerSize + (54 + copcPayload.length) + (54 + wkt.length);
  const rootPageOffset = pointDataOffset + 32;
  const bytes = new Uint8Array(rootPageOffset + Math.max(rootPageLength, 96));
  bytes.set(new TextEncoder().encode('LASF'), 0);
  bytes[24] = 1;
  bytes[25] = 4;
  putU16(bytes, 94, headerSize);
  putU32(bytes, 96, pointDataOffset);
  putU32(bytes, 100, 2);
  bytes[104] = 6;
  putU16(bytes, 105, 30);
  putU64(bytes, 247, 42);
  putF64(bytes, 131, 0.01);
  putF64(bytes, 139, 0.02);
  putF64(bytes, 147, 0.03);
  putF64(bytes, 155, 10);
  putF64(bytes, 163, 20);
  putF64(bytes, 171, 30);
  putF64(bytes, 179, 100);
  putF64(bytes, 187, 1);
  putF64(bytes, 195, 200);
  putF64(bytes, 203, 2);
  putF64(bytes, 211, 300);
  putF64(bytes, 219, 3);
  putU64(copcPayload, 40, rootPageOffset);
  putU64(copcPayload, 48, rootPageLength);
  let nextVlr = putVlr(bytes, copcVlrOffset, 'copc', 1, copcPayload);
  putVlr(bytes, nextVlr, 'LASF_Projection', 2112, wkt);

  const root = bytes.subarray(rootPageOffset);
  putI32(root, 0, 0);
  putI32(root, 4, 0);
  putI32(root, 8, 0);
  putI32(root, 12, 0);
  putI64(root, 16, 1000);
  putI32(root, 24, 200);
  putI32(root, 28, 10);
  putI32(root, 32, 1);
  putI32(root, 36, 0);
  putI32(root, 40, 0);
  putI32(root, 44, 0);
  putI64(root, 48, 1200);
  putI32(root, 56, 300);
  putI32(root, 60, 5);
  putI32(root, 64, 1);
  putI32(root, 68, 1);
  putI32(root, 72, 0);
  putI32(root, 76, 0);
  putI64(root, 80, 2000);
  putI32(root, 88, 64);
  putI32(root, 92, -1);

  return { bytes, rootPageOffset, rootPageLength };
}

function normalizeRoot(subtree) {
  return [
    ...subtree.nodes.map((node) => ({
      key: node.key,
      kind: 'node',
      pointCount: node.pointCount,
      offset: node.pointDataOffset,
      length: node.pointDataLength,
    })),
    ...subtree.pages.map((page) => ({
      key: page.key,
      kind: 'page',
      pointCount: null,
      offset: page.pageOffset,
      length: page.pageLength,
    })),
  ].sort((left, right) => left.key.localeCompare(right.key));
}

test('Rust reader parses project metadata and separates root page references', async () => {
  const fixture = makeFixture();
  const reader = await RustCopcReader.open(new InMemoryByteSource(fixture.bytes));

  assert.equal(reader.header.point_data_record_format, 6);
  assert.equal(reader.getMetadata().pointCount, 42);
  assert.deepEqual(reader.getMetadata().scale, { x: 0.01, y: 0.02, z: 0.03 });
  assert.deepEqual(reader.getMetadata().offset, { x: 10, y: 20, z: 30 });
  assert.deepEqual(reader.getMetadata().bounds, {
    minX: 1, minY: 2, minZ: 3, maxX: 100, maxY: 200, maxZ: 300,
  });
  assert.equal(reader.getRootHierarchyPage().pageOffset, fixture.rootPageOffset);
  assert.equal(reader.getRootHierarchyPage().pageLength, fixture.rootPageLength);
  assert.equal(reader.getMetadata().wkt, 'PROJCS["Fixture CRS"]');

  const root = await reader.loadRootHierarchy();
  assert.equal(root.nodes.length, 2);
  assert.equal(root.pages.length, 1);
  assert.deepEqual(root.pages[0], {
    key: '1-1-0-0', pageOffset: 2000, pageLength: 64,
  });
});

test('RustCopcBackend exposes the shared source contract without a viewer', async () => {
  const fixture = makeFixture();
  let requestedSource;
  const backend = new RustCopcBackend({
    createByteSource(source) {
      requestedSource = source;
      return new InMemoryByteSource(fixture.bytes, source);
    },
  });
  const source = await backend.open('memory://fixture.copc.laz');

  assert.equal(requestedSource, 'memory://fixture.copc.laz');
  assert.equal(source.source, 'memory://fixture.copc.laz');
  assert.equal(source.getMetadata().pointCount, 42);
  assert.deepEqual(source.getRootHierarchyPage(), {
    key: '0-0-0-0',
    pageOffset: fixture.rootPageOffset,
    pageLength: fixture.rootPageLength,
  });
  const subtree = await source.loadHierarchyPage(source.getRootHierarchyPage());
  assert.deepEqual(normalizeRoot(subtree), normalizeRoot(await RustCopcReader.open(
    new InMemoryByteSource(fixture.bytes),
  ).then((reader) => reader.loadRootHierarchy())));
});

test('RustCopcBackend maps source, header, and point-chunk failures', async () => {
  const fixture = makeFixture();
  const missingCopcInfo = makeFixture();
  putU32(missingCopcInfo.bytes, 100, 0);
  const backend = new RustCopcBackend({
    createByteSource(source) {
      if (source === 'memory://missing-info') {
        return new InMemoryByteSource(missingCopcInfo.bytes, source);
      }
      return new InMemoryByteSource(fixture.bytes, source);
    },
  });

  await assert.rejects(
    () => new RustCopcBackend({
      createByteSource: (source) => new InMemoryByteSource(new Uint8Array(10), source),
    }).open('memory://short'),
    (error) => error instanceof CopcBackendError
      && error.stage === 'source'
      && error.code === 'source-range'
      && error.cause?.code === 'out-of-bounds',
  );

  await assert.rejects(
    () => backend.open('memory://missing-info'),
    (error) => error instanceof CopcBackendError
      && error.stage === 'metadata'
      && error.code === 'header-parse'
      && error.cause instanceof RustCopcParseError,
  );

  const source = await backend.open('memory://fixture');
  const node = (await source.loadHierarchyPage(source.getRootHierarchyPage())).nodes[0];
  await assert.rejects(
    () => source.loadPointDataBuffer(node, new Set(['position'])),
    (error) => error instanceof CopcBackendError
      && error.stage === 'point-data'
      && error.code === 'point-chunk'
      && error.nodeKey === node.key
      && error.cause?.code === 'out-of-bounds',
  );
});

test('Rust hierarchy queries fetch fewer pages than forced traversal', async () => {
  const fixture = makeFixture();
  const childOffset = 2000;
  const bytes = new Uint8Array(Math.max(fixture.bytes.length, childOffset + 32));
  bytes.set(fixture.bytes);
  putI32(bytes, fixture.rootPageOffset + 88, 32);
  putI32(bytes, childOffset, 1);
  putI32(bytes, childOffset + 4, 1);
  putI32(bytes, childOffset + 8, 0);
  putI32(bytes, childOffset + 12, 0);
  putI64(bytes, childOffset + 16, 3000);
  putI32(bytes, childOffset + 24, 1);
  putI32(bytes, childOffset + 28, 1);

  const source = await new RustCopcBackend({
    createByteSource: (requestedSource) => new InMemoryByteSource(bytes, requestedSource),
  }).open('memory://paged-fixture');
  const partial = new HierarchyLoader(source, source.getMetadata().cube);
  const full = new HierarchyLoader(source, source.getMetadata().cube);

  await partial.query({ bounds: source.getMetadata().cube, maxLevel: 0 });
  await full.load();

  assert.ok(partial.getDiagnostics().pageRequests < full.getDiagnostics().pageRequests);
  assert.ok(
    partial.getDiagnostics().hierarchyBytesFetched
      < full.getDiagnostics().hierarchyBytesFetched,
  );
});

test('Autzen partial queries expose fewer target-level entries from its single root page', async () => {
  const bytes = await readFile(samplePath);
  const source = await new RustCopcBackend({
    createByteSource: (requestedSource) => new InMemoryByteSource(bytes, requestedSource),
  }).open('memory://autzen');
  const partial = new HierarchyLoader(source, source.getMetadata().cube);
  const full = new HierarchyLoader(source, source.getMetadata().cube);
  const partialTree = await partial.query({
    bounds: {
      minX: source.getMetadata().cube.minX,
      minY: source.getMetadata().cube.minY,
      minZ: source.getMetadata().cube.minZ,
      maxX: source.getMetadata().cube.minX + 100,
      maxY: source.getMetadata().cube.minY + 100,
      maxZ: source.getMetadata().cube.maxZ,
    },
    maxLevel: 1,
  });
  const fullTree = await full.load();

  assert.ok(partialTree.nodes.length < fullTree.nodes.length);
  assert.equal(partial.getDiagnostics().pageRequests, 1);
  assert.equal(
    partial.getDiagnostics().hierarchyBytesFetched,
    source.getRootHierarchyPage().pageLength,
  );
});

test('Rust malformed child hierarchy pages remain structured backend errors', async () => {
  const fixture = makeFixture();
  const bytes = new Uint8Array(Math.max(fixture.bytes.length, 2031));
  bytes.set(fixture.bytes);
  putI32(bytes, fixture.rootPageOffset + 88, 31);
  const source = await new RustCopcBackend({
    createByteSource: (requestedSource) => new InMemoryByteSource(bytes, requestedSource),
  }).open('memory://malformed-child');
  const loader = new HierarchyLoader(source, source.getMetadata().cube);

  await assert.rejects(
    () => loader.query({ bounds: source.getMetadata().cube, maxLevel: 1 }),
    (error) => error instanceof CopcBackendError
      && error.stage === 'hierarchy'
      && error.code === 'hierarchy'
      && error.cause instanceof RustCopcParseError
      && error.cause.code === 'invalid-hierarchy',
  );
});

test('RustCopcBackend and CopcJsBackend match on the same deterministic COPC file', async () => {
  const fixture = makeFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'copc-adapter-'));
  const fixturePath = path.join(directory, 'fixture.copc.laz');
  await writeFile(fixturePath, fixture.bytes);
  try {
    const { rust, copcJs } = await openBackendPair(fixturePath, fixture.bytes);
    assertMetadataParity(rust.getMetadata(), copcJs.getMetadata());
    await assertRootHierarchyParity(rust, copcJs);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Rust reader returns structured failures for malformed header and hierarchy input', async () => {
  const tooShort = {
    source: 'memory://short',
    async readRange() { return new Uint8Array(10); },
    async readRanges() { return []; },
    async size() { return 10; },
  };
  await assert.rejects(
    () => RustCopcReader.open(tooShort),
    (error) => error instanceof RustCopcParseError && error.code === 'truncated',
  );

  const missing = makeFixture();
  putU32(missing.bytes, 100, 0);
  await assert.rejects(
    () => RustCopcReader.open(new InMemoryByteSource(missing.bytes)),
    (error) => error instanceof RustCopcParseError && error.code === 'missing-copc-info',
  );

  const malformedCopc = makeFixture();
  putU16(malformedCopc.bytes, 375 + 20, 8);
  await assert.rejects(
    () => RustCopcReader.open(new InMemoryByteSource(malformedCopc.bytes)),
    (error) => error instanceof RustCopcParseError && error.code === 'malformed-copc-info',
  );

  const unaligned = makeFixture({ rootPageLength: 65 });
  await assert.rejects(
    async () => (await RustCopcReader.open(new InMemoryByteSource(unaligned.bytes))).loadRootHierarchy(),
    (error) => error instanceof RustCopcParseError && error.code === 'invalid-hierarchy',
  );

  const outOfBounds = makeFixture();
  putU64(outOfBounds.bytes, 375 + 54 + 40, 100_000);
  await assert.rejects(
    async () => (await RustCopcReader.open(new InMemoryByteSource(outOfBounds.bytes))).loadRootHierarchy(),
    (error) => error?.code === 'out-of-bounds',
  );

  const overflow = makeFixture();
  putU64(overflow.bytes, 375 + 54 + 40, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  await assert.rejects(
    () => RustCopcReader.open(new InMemoryByteSource(overflow.bytes)),
    (error) => error instanceof RustCopcParseError && error.code === 'unsupported-value',
  );
});

test('Autzen backend metadata and root entries match', { skip: !existsSync(samplePath) }, async () => {
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(samplePath));
  const { rust, copcJs } = await openBackendPair(samplePath, bytes);
  assertMetadataParity(rust.getMetadata(), copcJs.getMetadata());
  await assertRootHierarchyParity(rust, copcJs);
});

test('Rust decodes one Autzen node from its exact range and matches CopcJsBackend', {
  skip: !existsSync(samplePath),
}, async () => {
  class RecordingByteSource extends InMemoryByteSource {
    requests = [];

    async readRange(offset, length, options) {
      this.requests.push({ offset, length });
      return super.readRange(offset, length, options);
    }
  }

  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(samplePath));
  const byteSource = new RecordingByteSource(bytes, samplePath);
  const rust = await new RustCopcBackend({
    createByteSource: () => byteSource,
  }).open(samplePath);
  const root = (await rust.loadHierarchyPage(rust.getRootHierarchyPage())).nodes
    .find((node) => node.key === '0-0-0-0');
  assert.ok(root);

  const fields = new Set(['position', 'intensity', 'classification', 'rgb']);
  const rustBuffer = await rust.loadPointDataBuffer(root, fields);
  const js = await new CopcJsBackend().open(samplePath);
  const jsView = await js.loadPointDataView(root, fields);

  await assertPointParity(rust, js, root);

  assert.equal(rustBuffer.pointCount, root.pointCount);
  assert.equal(rustBuffer.pointCount, jsView.pointCount);
  const chunkRequest = byteSource.requests.find(
    ({ offset, length }) => offset === root.pointDataOffset && length === root.pointDataLength,
  );
  assert.deepEqual(chunkRequest, {
    offset: root.pointDataOffset,
    length: root.pointDataLength,
  });

  for (const index of [0, 1, 17, 1024, rustBuffer.pointCount - 1]) {
    assert.equal(rustBuffer.coordinates[index * 3], jsView.getter('x')(index));
    assert.equal(rustBuffer.coordinates[index * 3 + 1], jsView.getter('y')(index));
    assert.equal(rustBuffer.coordinates[index * 3 + 2], jsView.getter('z')(index));
    assert.equal(rustBuffer.attributes.intensity[index], jsView.getter('intensity')(index));
    assert.equal(rustBuffer.attributes.classification[index], jsView.getter('classification')(index));
    assert.equal(rustBuffer.attributes.red[index], jsView.getter('red')(index));
    assert.equal(rustBuffer.attributes.green[index], jsView.getter('green')(index));
    assert.equal(rustBuffer.attributes.blue[index], jsView.getter('blue')(index));
  }

  for (const selection of [
    { field: 'intensity', component: 'intensity' },
    { field: 'classification', component: 'classification' },
    { field: 'rgb', component: 'red' },
  ]) {
    const selected = await rust.loadPointDataBuffer(
      root,
      new Set(['position', selection.field]),
    );
    assert.equal(selected.pointCount, root.pointCount);
    assert.equal(selected.attributes[selection.component][17], jsView.getter(selection.component)(17));
    for (const field of ['intensity', 'classification', 'red', 'green', 'blue']) {
      if (field !== selection.component && !(selection.field === 'rgb' && ['red', 'green', 'blue'].includes(field))) {
        assert.equal(selected.attributes?.[field], undefined);
      }
    }
  }

  const xyzOnly = await rust.loadPointDataBuffer(root, new Set(['position']));
  assert.equal(xyzOnly.pointCount, root.pointCount);
  assert.equal(xyzOnly.attributes, undefined);
  assert.deepEqual(Array.from(xyzOnly.coordinates.slice(0, 6)), [
    jsView.getter('x')(0), jsView.getter('y')(0), jsView.getter('z')(0),
    jsView.getter('x')(1), jsView.getter('y')(1), jsView.getter('z')(1),
  ]);

  await assert.rejects(
    () => rust.loadPointDataBuffer({ ...root, pointCount: root.pointCount - 1 }, fields),
    (error) => error instanceof CopcBackendError
      && error.stage === 'decode'
      && error.code === 'laz-decode'
      && error.cause instanceof RustCopcParseError,
  );
  await assert.rejects(
    () => rust.loadPointDataBuffer({ ...root, pointDataLength: root.pointDataLength - 1 }, fields),
    (error) => error instanceof CopcBackendError
      && error.stage === 'decode'
      && error.code === 'laz-decode'
      && error.cause instanceof RustCopcParseError,
  );
});
