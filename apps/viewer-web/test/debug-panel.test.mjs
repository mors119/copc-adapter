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
  assert.equal(view.streamingUpdateCount, '7');
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
