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
  ].sort((left, right) => {
    const keyOrder = left.key.localeCompare(right.key);
    if (keyOrder !== 0) {
      return keyOrder;
    }
    return left.kind === right.kind ? 0 : left.kind === 'node' ? -1 : 1;
  });
}

export function normalizeHierarchySubtree(subtree) {
  return [
    ...normalizeRootHierarchy(subtree),
  ];
}

export function normalizeHierarchyTree(tree) {
  return normalizeHierarchySubtree(tree);
}

function compareHierarchyEntries(left, right) {
  const keyOrder = left.key.localeCompare(right.key);
  if (keyOrder !== 0) {
    return keyOrder;
  }
  return left.kind === right.kind ? 0 : left.kind === 'node' ? -1 : 1;
}

export function assertMetadataParity(rustMetadata, copcJsMetadata) {
  assert.equal(rustMetadata.pointCount, copcJsMetadata.pointCount);
  assert.deepEqual(rustMetadata.bounds, copcJsMetadata.bounds);
  assert.deepEqual(rustMetadata.scale, copcJsMetadata.scale);
  assert.deepEqual(rustMetadata.offset, copcJsMetadata.offset);
  assert.equal(rustMetadata.spacing, copcJsMetadata.spacing);
  assert.deepEqual(rustMetadata.cube, copcJsMetadata.cube);

  const meaningfulWkt = (value) => value?.replaceAll('\0', '').trim() || undefined;
  assert.equal(meaningfulWkt(rustMetadata.wkt), meaningfulWkt(copcJsMetadata.wkt));
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

export async function assertHierarchyParity(rust, copcJs) {
  assertMetadataParity(rust.getMetadata(), copcJs.getMetadata());
  assert.deepEqual(rust.getRootHierarchyPage(), copcJs.getRootHierarchyPage());

  const rustPages = new Map([[rust.getRootHierarchyPage().key, rust.getRootHierarchyPage()]]);
  const copcJsPages = new Map([[copcJs.getRootHierarchyPage().key, copcJs.getRootHierarchyPage()]]);
  const rustEntries = [];
  const copcJsEntries = [];

  for (const [pages, source, entries] of [
    [rustPages, rust, rustEntries],
    [copcJsPages, copcJs, copcJsEntries],
  ]) {
    const loadedPages = new Set();
    for (const page of pages.values()) {
      if (loadedPages.has(page.key)) {
        continue;
      }
      loadedPages.add(page.key);
      const subtree = await source.loadHierarchyPage(page);
      entries.push(...normalizeHierarchySubtree(subtree));
      for (const childPage of subtree.pages) {
        pages.set(childPage.key, childPage);
      }
    }
  }

  assert.deepEqual(
    rustEntries.sort(compareHierarchyEntries),
    copcJsEntries.sort(compareHierarchyEntries),
  );

  return { rustEntries, copcJsEntries };
}

export function pointSampleIndices(pointCount) {
  return [...new Set([
    0,
    1,
    Math.floor(pointCount / 7),
    Math.floor(pointCount * 2 / 5),
    Math.floor(pointCount / 2),
    Math.floor(pointCount * 4 / 5),
    pointCount - 1,
  ])].filter((index) => index >= 0 && index < pointCount);
}

const FIELD_COMPONENTS = {
  position: ['x', 'y', 'z'],
  intensity: ['intensity'],
  classification: ['classification'],
  rgb: ['red', 'green', 'blue'],
};

export async function assertPointParity(
  rust,
  copcJs,
  node,
  fields = new Set(['position', 'intensity', 'classification', 'rgb']),
) {
  assert.ok(node.pointCount > 0, `${node.key} must contain at least one point`);

  const rustView = await rust.loadPointDataView(node, fields);
  const copcJsView = await copcJs.loadPointDataView(node, fields);

  assert.equal(rustView.pointCount, node.pointCount);
  assert.equal(copcJsView.pointCount, node.pointCount);
  assert.deepEqual(
    [...rustView.availableFields].sort(),
    [...copcJsView.availableFields].sort(),
  );

  for (const index of pointSampleIndices(node.pointCount)) {
    for (const field of fields) {
      if (!rustView.availableFields.has(field)) {
        continue;
      }
      for (const component of FIELD_COMPONENTS[field]) {
        const rustValue = rustView.getter(component)(index);
        const copcJsValue = copcJsView.getter(component)(index);
        if (field === 'position') {
          assert.ok(
            Math.abs(rustValue - copcJsValue) <= POINT_COORDINATE_EPSILON,
            `${node.key} point[${index}] ${component} differs beyond ${POINT_COORDINATE_EPSILON}`,
          );
        } else {
          assert.equal(rustValue, copcJsValue, `${node.key} point[${index}] ${component} differs`);
        }
      }
    }
  }

  for (const field of fields) {
    if (rustView.availableFields.has(field)) {
      continue;
    }

    for (const component of FIELD_COMPONENTS[field]) {
      assert.throws(
        () => rustView.getter(component)(0),
        /unavailable/i,
        `${node.key} Rust should keep ${component} unavailable`,
      );
      assert.throws(
        () => copcJsView.getter(component)(0),
        /unavailable/i,
        `${node.key} copc.js should keep ${component} unavailable`,
      );
    }
  }
}

/** Run one semantic contract against both public backend implementations. */
export async function runBackendContract({ source, bytes, assertContract }) {
  const backends = await openBackendPair(source, bytes);
  await assertContract(backends);
  return backends;
}
