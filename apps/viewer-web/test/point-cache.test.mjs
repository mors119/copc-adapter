import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  InMemoryByteSource,
  RustCopcBackend,
} from '../src/index.ts';
import {
  createNodePointCache,
  estimateDecodedCpuPointBufferBytes,
} from '../src/viewer/streaming/createNodePointCache.ts';

function pointBuffer(pointCount, attributes = {}) {
  return {
    pointCount,
    coordinates: new Float64Array(pointCount * 3),
    attributes,
  };
}

test('estimates XYZ-only decoded CPU point-buffer bytes from byteLength', () => {
  const buffer = pointBuffer(4);

  assert.equal(
    estimateDecodedCpuPointBufferBytes(buffer),
    buffer.coordinates.byteLength,
  );
});

test('accounts for RGB, intensity, classification, and nested typed arrays', () => {
  const buffer = pointBuffer(4, {
    red: new Uint16Array(4),
    green: new Uint16Array(4),
    blue: new Uint16Array(4),
    intensity: new Uint16Array(4),
    classification: new Uint8Array(4),
  });
  buffer.extra = { futureAttribute: new Float32Array(4) };

  assert.equal(
    estimateDecodedCpuPointBufferBytes(buffer),
    4 * 3 * Float64Array.BYTES_PER_ELEMENT
      + 4 * 4 * Uint16Array.BYTES_PER_ELEMENT
      + 4 * Uint8Array.BYTES_PER_ELEMENT
      + 4 * Float32Array.BYTES_PER_ELEMENT,
  );
});

test('different-sized nodes have different cache costs and pressure evicts entries', async () => {
  const values = new Map([
    ['small', pointBuffer(1)],
    ['large', pointBuffer(4)],
  ]);
  const smallBytes = estimateDecodedCpuPointBufferBytes(values.get('small'));
  const largeBytes = estimateDecodedCpuPointBufferBytes(values.get('large'));
  const cache = createNodePointCache(
    async (nodeKey) => values.get(nodeKey),
    { maxEntries: 10, maxBytes: smallBytes + largeBytes - 1 },
  );

  await cache.load('small');
  await cache.load('large');

  assert.equal(cache.has('small'), false);
  assert.equal(cache.has('large'), true);
  assert.equal(cache.getDiagnostics().largestCachedEntryBytes, largeBytes);
  assert.equal(cache.getDiagnostics().bytesEvicted, smallBytes);
  assert.equal(cache.getDiagnostics().evictionCount, 1);
});

test('inactive least-recently-used entries evict before active entries', async () => {
  const values = new Map([
    ['a', pointBuffer(1)],
    ['b', pointBuffer(1)],
    ['c', pointBuffer(1)],
  ]);
  const entryBytes = estimateDecodedCpuPointBufferBytes(values.get('a'));
  const cache = createNodePointCache(
    async (nodeKey) => values.get(nodeKey),
    { maxEntries: 10, maxBytes: entryBytes * 2 },
  );

  await cache.load('a');
  await cache.load('b');
  await cache.load('a');
  cache.setRequiredNodeKeys(['b']);
  await cache.load('c');

  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
});

test('cache hits reuse the pending or resolved value without another load', async () => {
  let loadCount = 0;
  const value = pointBuffer(2);
  const cache = createNodePointCache(
    async () => {
      loadCount += 1;
      return value;
    },
    { maxEntries: 2, maxBytes: value.coordinates.byteLength },
  );

  const [first, second] = await Promise.all([cache.load('a'), cache.load('a')]);
  const third = await cache.load('a');

  assert.equal(loadCount, 1);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.deepEqual(cache.getDiagnostics(), {
    cacheByteBudget: value.coordinates.byteLength,
    currentCacheBytes: value.coordinates.byteLength,
    cachedNodeCount: 1,
    hits: 2,
    misses: 1,
    evictionCount: 0,
    bytesEvicted: 0,
    largestCachedEntryBytes: value.coordinates.byteLength,
  });
});

test('required oversized entries are deterministic and inactive oversized entries are evicted', async () => {
  const value = pointBuffer(4);
  const bytes = value.coordinates.byteLength;
  const cache = createNodePointCache(async () => value, {
    maxEntries: 1,
    maxBytes: 1,
  });

  cache.setRequiredNodeKeys(['oversized']);
  await cache.load('oversized');
  assert.equal(cache.has('oversized'), true);
  assert.equal(cache.getDiagnostics().currentCacheBytes, bytes);

  cache.setRequiredNodeKeys([]);
  assert.equal(cache.has('oversized'), false);
  assert.equal(cache.getDiagnostics().currentCacheBytes, 0);
  assert.equal(cache.getDiagnostics().bytesEvicted, bytes);
});

test('tiny budgets and lifecycle clear never produce negative or overflowing counters', async () => {
  const value = pointBuffer(1);
  const cache = createNodePointCache(async () => value, {
    maxEntries: 2,
    maxBytes: 0,
  });

  await cache.load('a');
  assert.equal(cache.getSize(), 0);
  assert.equal(cache.getDiagnostics().currentCacheBytes, 0);
  assert.equal(cache.getDiagnostics().bytesEvicted, value.coordinates.byteLength);

  cache.delete('missing');
  cache.clear();
  assert.deepEqual(cache.getDiagnostics(), {
    cacheByteBudget: 0,
    currentCacheBytes: 0,
    cachedNodeCount: 0,
    hits: 0,
    misses: 0,
    evictionCount: 0,
    bytesEvicted: 0,
    largestCachedEntryBytes: 0,
  });
});

const samplePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../samples/local/autzen.copc.laz',
);

test('Autzen region A -> region B -> return A reuses or evicts by byte budget', {
  skip: !existsSync(samplePath),
}, async () => {
  const bytes = await readFile(samplePath);
  const source = await new RustCopcBackend({
    createByteSource: (requestedSource) => new InMemoryByteSource(bytes, requestedSource),
  }).open('memory://autzen-cache');
  const root = await source.loadHierarchyPage(source.getRootHierarchyPage());
  const [regionA, regionB] = root.nodes
    .filter((node) => node.pointCount > 0)
    .slice(0, 2);
  assert.ok(regionA);
  assert.ok(regionB);

  const loadBuffer = async (nodeKey) => {
    const node = [regionA, regionB].find((candidate) => candidate.key === nodeKey);
    return source.loadPointDataBuffer(node, new Set(['position']));
  };
  const firstA = await loadBuffer(regionA.key);
  const firstB = await loadBuffer(regionB.key);
  const aBytes = estimateDecodedCpuPointBufferBytes(firstA);
  const bBytes = estimateDecodedCpuPointBufferBytes(firstB);

  const retained = createNodePointCache(loadBuffer, {
    maxEntries: 10,
    maxBytes: aBytes + bBytes,
  });
  retained.setRequiredNodeKeys([regionA.key]);
  await retained.load(regionA.key);
  retained.setRequiredNodeKeys([regionB.key]);
  await retained.load(regionB.key);
  retained.setRequiredNodeKeys([regionA.key]);
  await retained.load(regionA.key);
  assert.equal(retained.getDiagnostics().hits, 1);

  const budget = Math.max(aBytes, bBytes);
  const evicted = createNodePointCache(loadBuffer, {
    maxEntries: 10,
    maxBytes: budget,
  });
  evicted.setRequiredNodeKeys([regionA.key]);
  await evicted.load(regionA.key);
  evicted.setRequiredNodeKeys([regionB.key]);
  await evicted.load(regionB.key);
  evicted.setRequiredNodeKeys([regionA.key]);
  await evicted.load(regionA.key);
  assert.equal(evicted.getDiagnostics().misses, 3);
  assert.equal(evicted.getDiagnostics().evictionCount >= 1, true);
});
