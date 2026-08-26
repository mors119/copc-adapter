import assert from 'node:assert/strict';

import {
  CopcJsBackend,
  InMemoryByteSource,
  RustCopcBackend,
} from '../../src/index.ts';

/** XYZ values cross a different decoder boundary, so compare them explicitly. */
export const POINT_COORDINATE_EPSILON = 1e-6;

export async function openBackendPair(source, bytes) {
  const rust = await new RustCopcBackend({
    createByteSource: (requestedSource) => new InMemoryByteSource(bytes, requestedSource),
  }).open(source);
  const copcJs = await new CopcJsBackend().open(source);

  return { rust, copcJs };
}

export function normalizeRootHierarchy(subtree) {
  return [
    ...subtree.nodes.map((node) => ({
      key: node.key,
      kind: 'node',
      level: node.level,
      x: node.x,
      y: node.y,
      z: node.z,
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

export function assertMetadataParity(rustMetadata, copcJsMetadata) {
  assert.deepEqual(rustMetadata, copcJsMetadata);
}

export async function assertRootHierarchyParity(rust, copcJs) {
  assert.deepEqual(rust.getRootHierarchyPage(), copcJs.getRootHierarchyPage());

  const rustRoot = await rust.loadHierarchyPage(rust.getRootHierarchyPage());
  const copcJsRoot = await copcJs.loadHierarchyPage(copcJs.getRootHierarchyPage());

  assert.deepEqual(
    normalizeRootHierarchy(rustRoot),
    normalizeRootHierarchy(copcJsRoot),
  );

  return rustRoot;
}

export function pointSampleIndices(pointCount) {
  return [...new Set([0, Math.floor(pointCount / 2), pointCount - 1])];
}

export async function assertPointParity(rust, copcJs, node) {
  assert.ok(node.pointCount > 0, `${node.key} must contain at least one point`);

  const fields = new Set(['position', 'rgb']);
  const rustView = await rust.loadPointDataView(node, fields);
  const copcJsView = await copcJs.loadPointDataView(node, fields);

  assert.equal(rustView.pointCount, node.pointCount);
  assert.equal(copcJsView.pointCount, node.pointCount);
  assert.ok(rustView.availableFields.has('rgb'));
  assert.ok(copcJsView.availableFields.has('rgb'));

  for (const index of pointSampleIndices(node.pointCount)) {
    for (const component of ['x', 'y', 'z']) {
      assert.ok(
        Math.abs(rustView.getter(component)(index) - copcJsView.getter(component)(index))
          <= POINT_COORDINATE_EPSILON,
        `${node.key} point[${index}] ${component} differs beyond ${POINT_COORDINATE_EPSILON}`,
      );
    }

    for (const component of ['red', 'green', 'blue']) {
      assert.equal(
        rustView.getter(component)(index),
        copcJsView.getter(component)(index),
        `${node.key} point[${index}] ${component} differs`,
      );
    }
  }
}
