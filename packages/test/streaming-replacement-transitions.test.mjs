import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplacementTransitionManager } from '../core/streaming/ReplacementTransitionManager.ts';

function createHarness(renderedNodes = {}) {
  const points = new Map(Object.entries(renderedNodes));
  const removedNodes = [];
  const renderer = {
    hasNode: (nodeKey) => points.has(nodeKey),
    getRenderedNodeKeys: () => [...points.keys()].sort(),
    getRenderedPointCount: () => [...points.values()].reduce((total, count) => total + count, 0),
    getRenderedNodePointCount: (nodeKey) => points.get(nodeKey),
  };
  const manager = new ReplacementTransitionManager({
    renderer,
    getHierarchyNodePointCount: () => undefined,
    removeNode: (nodeKey) => {
      removedNodes.push(nodeKey);
      points.delete(nodeKey);
    },
  });
  return { manager, points, removedNodes };
}

test('replacement groups retain old coverage until all new nodes are rendered', () => {
  const { manager, points, removedNodes } = createHarness({ old: 100 });
  manager.reconcile([{
    kind: 'refinement',
    oldNodeKeys: ['old'],
    newNodeKeys: ['child-a', 'child-b'],
  }], 4, ['child-a', 'child-b'], 9);

  assert.equal(manager.isReplacementOldNode('old'), true);
  assert.equal(manager.getProjectedPointCount('child-a', 30), 30);
  manager.updateDiagnostics();
  assert.deepEqual(manager.getDiagnostics(), {
    activeReplacementGroupCount: 1,
    replacementGroupsWaitingCount: 1,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 1,
  });

  points.set('child-a', 30);
  manager.commitReady(4);
  assert.deepEqual(removedNodes, []);
  points.set('child-b', 40);
  manager.commitReady(4);
  manager.updateDiagnostics();

  assert.deepEqual(removedNodes, ['old']);
  assert.equal(manager.isReplacementOldNode('old'), false);
  assert.deepEqual(manager.getDiagnostics(), {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 1,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  });
});

test('a new generation removes stale staged nodes and records cancellation', () => {
  const { manager, points, removedNodes } = createHarness({ old: 100 });
  manager.reconcile([{
    kind: 'refinement',
    oldNodeKeys: ['old'],
    newNodeKeys: ['staged'],
  }], 1, ['staged'], 3);
  points.set('staged', 20);

  manager.reconcile([{
    kind: 'retarget',
    oldNodeKeys: ['old'],
    newNodeKeys: ['next'],
  }], 2, ['next'], 4);

  assert.deepEqual(removedNodes, ['staged']);
  assert.equal(manager.isReplacementOldNode('old'), true);
  assert.equal(manager.isReplacementOldNode('staged'), false);
  assert.equal(manager.getDiagnostics().staleReplacementCancellationCount, 1);

  manager.reset();
  assert.deepEqual(manager.getDiagnostics(), {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  });
});

test('projected point counts use hierarchy counts when renderer counts are unavailable', () => {
  const points = new Set(['parent']);
  const manager = new ReplacementTransitionManager({
    renderer: {
      hasNode: (nodeKey) => points.has(nodeKey),
      getRenderedNodeKeys: () => [...points],
      getRenderedPointCount: () => 80,
      getRenderedNodePointCount: () => undefined,
    },
    getHierarchyNodePointCount: (nodeKey) => nodeKey === 'parent' ? 80 : undefined,
    removeNode: (nodeKey) => points.delete(nodeKey),
  });
  manager.reconcile([{
    kind: 'collapse',
    oldNodeKeys: ['parent'],
    newNodeKeys: ['child'],
  }], 1, ['child'], 1);

  assert.equal(manager.getProjectedPointCount('child', 25), 25);
});
