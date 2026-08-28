import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCopcDebugPanelView } from '../src/debug/CopcDebugPanel.ts';

function createSnapshot(overrides = {}) {
  return {
    lifecycle: 'ready',
    renderedNodeKeys: ['1-0-0-0', '1-1-0-0'],
    selectedNodeKeys: ['1-0-0-0', '1-1-0-0', '1-0-1-0'],
    renderedPointCount: 2345,
    streamingUpdateCount: 7,
    performance: {
      candidatesBeforeCulling: 12,
      frustumCulledCount: 5,
      maxScreenSpaceError: 8,
      configuredPointBudget: 250000,
      candidateSelectedPointCount: 3456,
      activeRenderedPointCount: 2345,
      deferredNodeCount: 2,
      deferredPointCount: 1111,
      budgetDeferDropCount: 2,
      budgetUtilizationPercent: 0.938,
      screenSpaceErrorMin: 2.5,
      screenSpaceErrorMax: 18.75,
      refinedNodeCount: 4,
      keptNodeCount: 3,
      visibleLevelRange: { min: 2, max: 5 },
      cameraDirection: { x: 0, y: 0.5, z: -0.8660254 },
    },
    pointCache: {
      cacheByteBudget: 1024,
      currentCacheBytes: 768,
      cachedNodeCount: 2,
      hits: 4,
      misses: 3,
      evictionCount: 1,
      bytesEvicted: 512,
      largestCachedEntryBytes: 640,
    },
    datasetUrl: '/samples/autzen.copc.laz?cache=1',
    attached: true,
    ...overrides,
  };
}

test('maps layer diagnostics and metadata into browser-visible values', () => {
  const view = buildCopcDebugPanelView({
    snapshot: createSnapshot(),
    metadata: {
      pointCount: 10653336,
      bounds: {
        minX: 1,
        minY: 2,
        minZ: 3,
        maxX: 4,
        maxY: 5,
        maxZ: 6,
      },
      scale: { x: 0.01, y: 0.01, z: 0.001 },
      offset: { x: 100, y: 200, z: 300 },
      cube: {
        minX: 0,
        minY: 0,
        minZ: 0,
        maxX: 10,
        maxY: 10,
        maxZ: 10,
      },
    },
  });

  assert.equal(view.datasetName, 'autzen.copc.laz');
  assert.equal(view.status, 'Ready');
  assert.equal(view.statusTone, 'ready');
  assert.equal(view.pointCount, '10,653,336');
  assert.equal(view.bounds, '1, 2, 3, 4, 5, 6');
  assert.equal(view.scale, '0.010000000, 0.010000000, 0.0010000000');
  assert.equal(view.offset, '100, 200, 300');
  assert.equal(view.selectedNodeCount, '3');
  assert.equal(view.selectedNodeKeys, '1-0-0-0, 1-1-0-0, 1-0-1-0');
  assert.equal(view.renderedNodeCount, '2');
  assert.equal(view.renderedPointCount, '2,345');
  assert.equal(view.configuredPointBudget, '250,000');
  assert.equal(view.candidateSelectedPointCount, '3,456');
  assert.equal(view.activeRenderedPointCount, '2,345');
  assert.equal(view.deferredNodeCount, '2');
  assert.equal(view.deferredPointCount, '1,111');
  assert.equal(view.budgetUtilization, '0.93800000%');
  assert.equal(view.budgetDeferDropCount, '2');
  assert.equal(view.streamingUpdateCount, '7');
  assert.equal(view.candidatesBeforeCulling, '12');
  assert.equal(view.frustumCulledCount, '5');
  assert.equal(view.maxScreenSpaceError, '8 px');
  assert.equal(view.representativeScreenSpaceError, '2.5000000–18.750000 px');
  assert.equal(view.refinedNodeCount, '4');
  assert.equal(view.keptNodeCount, '3');
  assert.equal(view.visibleLevelRange, '2–5');
  assert.equal(view.cameraDirection, '0, 0.50000000, -0.86602540');
  assert.equal(view.pointCacheBudget, '1,024 B');
  assert.equal(view.pointCacheBytes, '768 B');
  assert.equal(view.cachedNodeCount, '2');
  assert.equal(view.cacheHits, '4');
  assert.equal(view.cacheMisses, '3');
  assert.equal(view.cacheEvictionCount, '1');
  assert.equal(view.cacheBytesEvicted, '512 B');
  assert.equal(view.largestCachedEntryBytes, '640 B');
});

test('shows loading placeholders and gives runtime errors precedence', () => {
  const loading = buildCopcDebugPanelView({
    snapshot: createSnapshot({ lifecycle: 'loading', selectedNodeKeys: [] }),
  });

  assert.equal(loading.status, 'Loading');
  assert.equal(loading.statusTone, 'loading');
  assert.equal(loading.pointCount, '—');
  assert.equal(loading.selectedNodeKeys, '—');

  const failed = buildCopcDebugPanelView({
    snapshot: createSnapshot({ lifecycle: 'loading' }),
    lastError: 'Range request failed',
  });

  assert.equal(failed.status, 'Error');
  assert.equal(failed.statusTone, 'error');
  assert.equal(failed.error, 'Range request failed');
});
