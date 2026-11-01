import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import tilesValidator from '3d-tiles-validator';
import gltfValidator from 'gltf-validator';
import { getFloat32EcefReconstructionErrorBound } from '../src/geometry/tileLocalCoordinates.ts';
import { createCopcTileResourceProvider, CopcTileResourceProviderError } from '../src/resources/copcTileResourceProvider.ts';
import { getExplicitTileContentUri } from '../src/tileset/explicitTileset.ts';
import { createBrowserFixtureSource } from './browser/fixture.ts';

test('builds the complete explicit hierarchy from metadata and reads points only for requested content', async () => {
  const source = createBrowserFixtureSource(7);
  const provider = await createCopcTileResourceProvider(source, {
    scanCompleteHierarchy: true,
    selection: { attributes: { rgb: true, intensity: true, classification: true } },
  });

  assert.equal(provider.hierarchyPagesRead, 2);
  assert.equal(provider.hierarchyPageBytesRead, 64);
  assert.deepEqual(source.diagnostics.nodes, []);
  assert.equal(source.diagnostics.conservativeBounds, 2);
  assert.equal(source.diagnostics.hierarchyPages, 2);

  const tilesetBytes = await provider.getResource('tileset.json', new AbortController().signal);
  assert.ok(tilesetBytes);
  const tileset = JSON.parse(new TextDecoder().decode(tilesetBytes));
  assert.equal(tileset.asset.version, '1.1');
  assert.equal(tileset.root.refine, 'ADD');
  assert.equal(tileset.root.content.uri, getExplicitTileContentUri('root'));
  assert.equal(tileset.root.children[0].content.uri, getExplicitTileContentUri('left'));
  assert.ok(tileset.root.geometricError >= tileset.root.children[0].geometricError);
  assert.deepEqual(source.diagnostics.nodes, []);

  const rootBytes = await provider.getResource(getExplicitTileContentUri('root'), new AbortController().signal);
  assert.ok(rootBytes);
  assert.deepEqual(source.diagnostics.nodes, ['root']);
  const gltfReport = await gltfValidator.validateBytes(rootBytes, { uri: 'root.glb' });
  assert.equal(gltfReport.issues.numErrors, 0, JSON.stringify(gltfReport.issues.messages));
  assert.equal(gltfReport.issues.numWarnings, 0, JSON.stringify(gltfReport.issues.messages));

  const childBytes = await provider.getResource(getExplicitTileContentUri('left'), new AbortController().signal);
  assert.ok(childBytes);
  assert.deepEqual(source.diagnostics.nodes, ['root', 'left']);
  assert.equal(await provider.getResource('content/not-in-the-tree.glb', new AbortController().signal), undefined);

  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-live-provider-'));
  try {
    await writeFile(join(directory, 'tileset.json'), tilesetBytes);
    for (const [nodeKey, bytes] of [['root', rootBytes], ['left', childBytes]]) {
      const path = join(directory, getExplicitTileContentUri(nodeKey));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const report = await tilesValidator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'ERROR'), [], report.serialize());
    assert.deepEqual(report.issues.filter((issue) => issue.severity === 'WARNING'), [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('decoded-content preprocessing accounts for every point and emits distinct per-node and descendant provenance', async () => {
  const source = createBrowserFixtureSource(70);
  const progress = [];
  const provider = await createCopcTileResourceProvider(source, {
    scanCompleteHierarchy: true,
    boundsStrategy: 'decoded-content',
    allowDecodedContentBounds: true,
    selection: { attributes: { rgb: true } },
    onDecodedContentProgress: (value) => progress.push(value),
  });

  assert.equal(provider.boundsStrategy, 'decoded-content');
  assert.deepEqual(source.diagnostics.nodes, ['root', 'left'], 'every content node is read before a Tileset is returned');
  assert.deepEqual(provider.decodedContentScan, {
    strategy: 'decoded-content',
    status: 'complete',
    coverage: 'all-content-points-in-complete-hierarchy',
    sourceIdentity: 'browser-fixture-source',
    sourceGeneration: 70,
    transformGeneration: 1,
    transformPlanIdentity: 'browser-fixture-transform-v1',
    sourceCrs: {
      status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre',
    },
    verticalDatum: {
      status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [],
    },
    verticalPlacement: 'verified',
    hierarchyNodes: 2,
    hierarchyPages: 2,
    hierarchyPageBytes: 64,
    tilesetNodes: 2,
    contentNodes: 2,
    emptyNodes: 0,
    emptyNodesOmittedFromTileset: 0,
    totalPoints: 6,
    scannedPoints: 6,
    totalPointDataBytes: 144,
    decodedEcefBytesScanned: 144,
    peakDecodedEcefBufferBytes: 72,
    scanDurationMilliseconds: provider.decodedContentScan.scanDurationMilliseconds,
    metadataOnlySourceCellStatus: 'supported',
    contentBounds: provider.decodedContentScan.contentBounds,
  });
  assert.equal(provider.decodedContentScan.contentBounds.length, 2);
  assert.deepEqual(provider.decodedContentScan.contentBounds.map(({ nodeKey, pointCount, scannedPointCount, coverage }) => ({
    nodeKey, pointCount, scannedPointCount, coverage,
  })), [
    { nodeKey: 'root', pointCount: 3, scannedPointCount: 3, coverage: 'all-points-in-node' },
    { nodeKey: 'left', pointCount: 3, scannedPointCount: 3, coverage: 'all-points-in-node' },
  ]);
  assert.deepEqual(progress.map(({ phase }) => phase), ['hierarchy', 'hierarchy', 'preflight', 'points', 'points', 'complete']);

  const bytes = await provider.getResource('tileset.json', new AbortController().signal);
  assert.ok(bytes);
  const tileset = JSON.parse(new TextDecoder().decode(bytes));
  assert.deepEqual(tileset.extras, {
    boundsStrategy: 'decoded-content',
    boundsCoverage: 'all-content-points-in-complete-hierarchy',
    sourceCellCoverage: false,
    hierarchyNodes: 2,
    tilesetNodes: 2,
    emptyNodesOmittedFromTileset: 0,
    sourceIdentity: 'browser-fixture-source',
    sourceGeneration: 70,
    transformGeneration: 1,
    transformPlanIdentity: 'browser-fixture-transform-v1',
    sourceCrs: { status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' },
    verticalDatum: { status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [] },
    heightOffsetMeters: 0,
    verticalPlacement: 'verified',
  });
  assert.equal(tileset.root.refine, 'ADD');
  assert.equal(tileset.root.extras.boundsStrategy, 'decoded-content');
  assert.equal(tileset.root.extras.contentCoverage, 'all-points-in-node');
  assert.equal(tileset.root.children[0].extras.nodeKey, 'left');
  assert.equal(tileset.root.children[0].extras.contentCoverage, 'all-points-in-node');
  assert.equal(tileset.root.extras.descendantCoverage, 'all-descendant-content-points');
  assert.equal(tileset.root.extras.descendantBoundsEcef.minX, 6_378_132.5);
  assert.equal(tileset.root.extras.descendantBoundsEcef.minY, -7);
  assert.equal(tileset.root.extras.descendantBoundsEcef.minZ, -5);
  assert.equal(tileset.root.extras.descendantBoundsEcef.maxY, 2);
  assert.equal(tileset.root.extras.descendantBoundsEcef.maxZ, 0);
  assertTileBoxContains(tileset.root, tileset.root.children[0]);

  const rootGlb = await provider.getResource(getExplicitTileContentUri('root'), new AbortController().signal);
  const childGlb = await provider.getResource(getExplicitTileContentUri('left'), new AbortController().signal);
  assert.ok(rootGlb && childGlb);
  for (const [nodeKey, glb] of [['root', rootGlb], ['left', childGlb]]) {
    const tile = nodeKey === 'root' ? tileset.root : tileset.root.children[0];
    assertGlbPointsInside(glb, tile.transform, nodeKey === 'root' ? undefined : tileset.root.transform, tile.extras.paddedContentBoundsEcef);
    const report = await gltfValidator.validateBytes(glb, { uri: `${nodeKey}.glb` });
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
    assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues.messages));
  }
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-decoded-content-'));
  try {
    await writeFile(join(directory, 'tileset.json'), bytes);
    for (const [nodeKey, glb] of [['root', rootGlb], ['left', childGlb]]) {
      const path = join(directory, getExplicitTileContentUri(nodeKey));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, glb);
    }
    const tilesReport = await tilesValidator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    assert.deepEqual(tilesReport.issues.filter((issue) => issue.severity === 'ERROR'), [], tilesReport.serialize());
    assert.deepEqual(tilesReport.issues.filter((issue) => issue.severity === 'WARNING'), [], tilesReport.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(source.diagnostics.nodes, ['root', 'left', 'root', 'left']);
  await provider.close();
});

test('decoded-content requires authorization and rejects over-budget or incomplete hierarchies before point reads', async () => {
  const source = createBrowserFixtureSource(71);
  await assert.rejects(
    createCopcTileResourceProvider(source, {
      scanCompleteHierarchy: true,
      boundsStrategy: 'decoded-content',
    }),
    (error) => error instanceof CopcTileResourceProviderError && error.code === 'CONTENT_SCAN_NOT_AUTHORIZED',
  );
  assert.deepEqual(source.diagnostics.nodes, []);

  await assert.rejects(
    createCopcTileResourceProvider(source, {
      scanCompleteHierarchy: true,
      boundsStrategy: 'decoded-content',
      allowDecodedContentBounds: true,
      tilesetOptions: { maxTotalPoints: 5 },
    }),
    (error) => error instanceof CopcTileResourceProviderError && error.code === 'CONTENT_SCAN_LIMIT' && /No point payloads were read/.test(error.message),
  );
  assert.deepEqual(source.diagnostics.nodes, []);

  const incompleteBase = createBrowserFixtureSource(72);
  const incomplete = {
    ...incompleteBase,
    loadHierarchyPage: async (page, signal) => {
      const result = await incompleteBase.loadHierarchyPage(page, signal);
      return page.key === 'root-page'
        ? { ...result, nodes: result.nodes.map((node) => ({ ...node, childrenComplete: false })) }
        : result;
    },
  };
  await assert.rejects(
    createCopcTileResourceProvider(incomplete, {
      scanCompleteHierarchy: true,
      boundsStrategy: 'decoded-content',
      allowDecodedContentBounds: true,
    }),
    (error) => error.code === 'INCOMPLETE_HIERARCHY',
  );
  assert.deepEqual(incompleteBase.diagnostics.nodes, []);
});

test('decoded-content omits empty terminal leaves and keeps empty ancestors around content descendants', async () => {
  const base = createBrowserFixtureSource(721);
  const rootPage = { key: 'empty-branch-root', pageOffset: 0, pageLength: 32 };
  const childPage = { key: 'empty-branch-children', pageOffset: 32, pageLength: 32 };
  const emptyRoot = {
    key: 'root', level: 0, x: 0, y: 0, z: 0,
    pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
    children: ['left', 'empty-leaf'], childrenComplete: true,
  };
  const emptyLeaf = {
    key: 'empty-leaf', level: 1, x: 1, y: 0, z: 0,
    pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
    children: [], childrenComplete: true,
  };
  const source = {
    ...base,
    getRootHierarchyPage: () => rootPage,
    loadHierarchyPage: async (page) => page.key === rootPage.key
      ? { nodes: [emptyRoot], pages: [childPage] }
      : {
        nodes: [
          { key: 'left', level: 1, x: 0, y: 0, z: 0, pointCount: 3, pointDataOffset: 100, pointDataLength: 72, children: [], childrenComplete: true },
          emptyLeaf,
        ],
        pages: [],
      },
  };
  const provider = await createCopcTileResourceProvider(source, {
    scanCompleteHierarchy: true,
    boundsStrategy: 'decoded-content',
    allowDecodedContentBounds: true,
  });
  assert.deepEqual(base.diagnostics.nodes, ['left']);
  assert.equal(provider.decodedContentScan.hierarchyNodes, 3);
  assert.equal(provider.decodedContentScan.tilesetNodes, 2);
  assert.equal(provider.decodedContentScan.emptyNodes, 2);
  assert.equal(provider.decodedContentScan.emptyNodesOmittedFromTileset, 1);
  const bytes = await provider.getResource('tileset.json', new AbortController().signal);
  assert.ok(bytes);
  const tileset = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(tileset.root.children.length, 1);
  assert.equal(tileset.root.children[0].extras.nodeKey, 'left');
  assert.equal(tileset.extras.emptyNodesOmittedFromTileset, 1);
  const glb = await provider.getResource(getExplicitTileContentUri('left'), new AbortController().signal);
  assert.ok(glb);
  await provider.close();
});

test('decoded-content preserves original node identity when pruning an empty child from a content-bearing parent', async () => {
  const base = createBrowserFixtureSource(722);
  const rootPage = { key: 'content-parent-root', pageOffset: 0, pageLength: 32 };
  const childPage = { key: 'content-parent-children', pageOffset: 32, pageLength: 32 };
  const contentRoot = {
    key: 'root', level: 0, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 100, pointDataLength: 72,
    children: ['left', 'empty-leaf'], childrenComplete: true,
  };
  const contentChild = {
    key: 'left', level: 1, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 172, pointDataLength: 72,
    children: [], childrenComplete: true,
  };
  const emptyLeaf = {
    key: 'empty-leaf', level: 1, x: 1, y: 0, z: 0,
    pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
    children: [], childrenComplete: true,
  };
  const source = {
    ...base,
    getRootHierarchyPage: () => rootPage,
    loadHierarchyPage: async (page) => page.key === rootPage.key
      ? { nodes: [contentRoot], pages: [childPage] }
      : { nodes: [contentChild, emptyLeaf], pages: [] },
  };

  const provider = await createCopcTileResourceProvider(source, {
    scanCompleteHierarchy: true,
    boundsStrategy: 'decoded-content',
    allowDecodedContentBounds: true,
  });
  assert.equal(provider.decodedContentScan.status, 'complete');
  assert.equal(provider.decodedContentScan.hierarchyNodes, 3);
  assert.equal(provider.decodedContentScan.tilesetNodes, 2);
  assert.equal(provider.decodedContentScan.scannedPoints, 6);

  const tilesetBytes = await provider.getResource('tileset.json', new AbortController().signal);
  assert.ok(tilesetBytes);
  const tileset = JSON.parse(new TextDecoder().decode(tilesetBytes));
  assert.equal(tileset.root.content.uri, getExplicitTileContentUri('root'));
  assert.deepEqual(tileset.root.children.map((child) => child.extras.nodeKey), ['left']);

  const rootGlb = await provider.getResource(getExplicitTileContentUri('root'), new AbortController().signal);
  const childGlb = await provider.getResource(getExplicitTileContentUri('left'), new AbortController().signal);
  assert.ok(rootGlb, 'content read receives the original parent hierarchy node');
  assert.ok(childGlb);
  assert.deepEqual(base.diagnostics.nodes, ['root', 'left', 'root', 'left']);
  await provider.close();
});

test('decoded-content cancels and rejects source replacement while scanning', async () => {
  const base = createBrowserFixtureSource(73);
  const controller = new AbortController();
  let signalPointRead;
  let reachedPointRead;
  const entered = new Promise((resolve) => { reachedPointRead = resolve; });
  const source = {
    ...base,
    loadNode: (node, _selection, signal) => new Promise((_resolve, reject) => {
      signalPointRead = signal;
      reachedPointRead();
      const abort = () => reject(new DOMException('Point read cancelled.', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    }),
  };
  const scan = createCopcTileResourceProvider(source, {
    scanCompleteHierarchy: true,
    boundsStrategy: 'decoded-content',
    allowDecodedContentBounds: true,
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  assert.equal(signalPointRead?.aborted, true);
  await assert.rejects(scan, (error) => error.code === 'ABORTED' || error.name === 'AbortError');
  assert.deepEqual(base.diagnostics.nodes, []);

  const currentBase = createBrowserFixtureSource(74);
  let generation = 74;
  const replaced = {
    ...currentBase,
    get sourceGeneration() { return generation; },
    loadNode: async (...args) => {
      const view = await currentBase.loadNode(...args);
      generation += 1;
      return view;
    },
  };
  await assert.rejects(
    createCopcTileResourceProvider(replaced, {
      scanCompleteHierarchy: true,
      boundsStrategy: 'decoded-content',
      allowDecodedContentBounds: true,
    }),
    (error) => error.code === 'STALE_SOURCE',
  );
  assert.deepEqual(currentBase.diagnostics.nodes, ['root']);
});

test('decoded-content refuses non-finite prepared positions and content that changes after preprocessing', async () => {
  const base = createBrowserFixtureSource(75);
  const nonFinite = {
    ...base,
    loadNode: async (...args) => {
      const view = await base.loadNode(...args);
      const ecef = view.ecef.slice();
      ecef[0] = Number.NaN;
      return { ...view, ecef };
    },
  };
  await assert.rejects(
    createCopcTileResourceProvider(nonFinite, {
      scanCompleteHierarchy: true,
      boundsStrategy: 'decoded-content',
      allowDecodedContentBounds: true,
    }),
    /finite|coordinate/i,
  );

  const changingBase = createBrowserFixtureSource(76);
  const reads = new Map();
  const changing = {
    ...changingBase,
    loadNode: async (...args) => {
      const view = await changingBase.loadNode(...args);
      const node = args[0];
      const count = (reads.get(node.key) ?? 0) + 1;
      reads.set(node.key, count);
      if (count === 1) return view;
      const ecef = view.ecef.slice();
      ecef[0] += 1;
      return { ...view, ecef };
    },
  };
  const provider = await createCopcTileResourceProvider(changing, {
    scanCompleteHierarchy: true,
    boundsStrategy: 'decoded-content',
    allowDecodedContentBounds: true,
  });
  await assert.rejects(
    provider.getResource(getExplicitTileContentUri('root'), new AbortController().signal),
    (error) => error instanceof CopcTileResourceProviderError &&
      ['POINT_OUTSIDE_DECODED_BOUNDS', 'NODE_CONTENT_MISMATCH'].includes(error.code),
  );
  await provider.close();
});

test('preserves unsupported conservative-bounds results and never falls back to decoded point bounds', async () => {
  const base = createBrowserFixtureSource(8);
  const { boundsEcef: _supportedBounds, ...resultWithoutBounds } = base.getConservativeNodeEcefBounds('root');
  const unsupported = Object.freeze({
    ...resultWithoutBounds,
    status: 'unsupported',
    reasonCode: 'unsupported-horizontal-crs',
    reason: 'The source horizontal CRS has no certified conservative ECEF transform.',
  });
  const source = Object.freeze({
    ...base,
    getConservativeNodeEcefBounds: () => unsupported,
  });

  await assert.rejects(
    createCopcTileResourceProvider(source, { scanCompleteHierarchy: true }),
    (error) => error instanceof CopcTileResourceProviderError &&
      error.code === 'UNSUPPORTED_BOUNDS' &&
      error.conservativeBoundsResult.reasonCode === 'unsupported-horizontal-crs' &&
      error.conservativeBoundsResult.reason === unsupported.reason &&
      !('boundsEcef' in error.conservativeBoundsResult),
  );
  assert.equal(base.diagnostics.hierarchyPages, 1, 'unsupported root bounds stop before scanning child hierarchy pages');
  assert.equal(base.diagnostics.conservativeBounds, 1);
  assert.deepEqual(base.diagnostics.nodes, []);
});

test('enforces an explicit Float32 bounds-padding budget and checks cancellation before point reads', async () => {
  const source = createBrowserFixtureSource(9);
  await assert.rejects(
    createCopcTileResourceProvider(source, { scanCompleteHierarchy: true, maxEncoderPaddingMeters: 0 }),
    (error) => error instanceof CopcTileResourceProviderError && error.code === 'ENCODER_PADDING_LIMIT',
  );

  const provider = await createCopcTileResourceProvider(source, { scanCompleteHierarchy: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.getResource(getExplicitTileContentUri('root'), controller.signal),
    (error) => error?.code === 'ABORTED',
  );
  assert.deepEqual(source.diagnostics.nodes, []);
  await provider.close();
  assert.equal(provider.isCurrent(), false);
});

test('applies encoder padding to content nodes and propagates it through oversized empty ancestors', async () => {
  const base = createBrowserFixtureSource(10);
  const rawContentBounds = base.getConservativeNodeEcefBounds('left').boundsEcef;
  const contentPadding = getFloat32EcefReconstructionErrorBound({
    minimum: [rawContentBounds.minX, rawContentBounds.minY, rawContentBounds.minZ],
    maximum: [rawContentBounds.maxX, rawContentBounds.maxY, rawContentBounds.maxZ],
  });
  assert.ok(contentPadding > 0 && contentPadding <= 0.01);
  const rootPage = { key: 'empty-root-page', pageOffset: 0, pageLength: 32 };
  const childPage = { key: 'content-child-page', pageOffset: 32, pageLength: 32 };
  const emptyRoot = {
    key: 'root', level: 0, x: 0, y: 0, z: 0,
    pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
    children: ['left'], childrenComplete: true,
  };
  const contentChild = {
    key: 'left', level: 1, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 100, pointDataLength: 72,
    children: [], childrenComplete: true,
  };
  const source = {
    ...base,
    getRootHierarchyPage: () => rootPage,
    loadHierarchyPage: async (page) => page.key === rootPage.key
      ? { nodes: [emptyRoot], pages: [childPage] }
      : { nodes: [contentChild], pages: [] },
    getConservativeNodeEcefBounds: (nodeKey) => {
      const result = base.getConservativeNodeEcefBounds(nodeKey);
      if (nodeKey !== 'root') return result;
      return {
        ...result,
        boundsEcef: {
          ...result.boundsEcef,
          minX: 6_000_000, maxX: 6_750_000,
          minY: -375_000, maxY: 375_000,
          minZ: -375_000, maxZ: 375_000,
        },
      };
    },
  };
  const rawEmptyRootBounds = source.getConservativeNodeEcefBounds('root').boundsEcef;
  const rootBoundsPadding = getFloat32EcefReconstructionErrorBound({
    minimum: [rawEmptyRootBounds.minX, rawEmptyRootBounds.minY, rawEmptyRootBounds.minZ],
    maximum: [rawEmptyRootBounds.maxX, rawEmptyRootBounds.maxY, rawEmptyRootBounds.maxZ],
  });
  assert.ok(rootBoundsPadding > 0.01, 'the empty root would exceed the default budget if encoded');
  const provider = await createCopcTileResourceProvider(source, { scanCompleteHierarchy: true });
  const tilesetBytes = await provider.getResource('tileset.json', new AbortController().signal);
  assert.ok(tilesetBytes);
  const tileset = JSON.parse(new TextDecoder().decode(tilesetBytes));
  assert.equal(Object.hasOwn(tileset.root, 'content'), false);
  assert.equal(tileset.root.children[0].content.uri, getExplicitTileContentUri('left'));
  assert.ok(Math.abs(tileset.root.boundingVolume.box[3] - (375_000 + contentPadding)) < 1e-7);
  assert.ok(Math.abs(
    tileset.root.children[0].boundingVolume.box[3] - ((rawContentBounds.maxX - rawContentBounds.minX) / 2 + contentPadding),
  ) < 1e-7);
  assert.deepEqual(base.diagnostics.nodes, []);

  const bytes = await provider.getResource(getExplicitTileContentUri('left'), new AbortController().signal);
  assert.ok(bytes);
  const gltfReport = await gltfValidator.validateBytes(bytes, { uri: 'left.glb' });
  assert.equal(gltfReport.issues.numErrors, 0, JSON.stringify(gltfReport.issues.messages));
  assert.deepEqual(base.diagnostics.nodes, ['left']);
  await provider.close();
});

test('rejects resources after the Adapter source generation changes', async () => {
  const base = createBrowserFixtureSource(11);
  let generation = 11;
  const source = { ...base, get sourceGeneration() { return generation; } };
  const provider = await createCopcTileResourceProvider(source, { scanCompleteHierarchy: true });
  generation += 1;
  assert.equal(provider.isCurrent(), false);
  await assert.rejects(
    provider.getResource('tileset.json', new AbortController().signal),
    (error) => error instanceof CopcTileResourceProviderError && error.code === 'STALE_SOURCE',
  );
  assert.deepEqual(base.diagnostics.nodes, []);
});

test('rejects point data from a different generation when the source omits its generation', async () => {
  const base = createBrowserFixtureSource(7);
  const source = {
    ...base,
    sourceGeneration: undefined,
    loadNode: async (...args) => {
      const view = await base.loadNode(...args);
      return { ...view, context: { ...view.context, sourceGeneration: 8 } };
    },
  };
  const provider = await createCopcTileResourceProvider(source, { scanCompleteHierarchy: true });

  await assert.rejects(
    provider.getResource(getExplicitTileContentUri('root'), new AbortController().signal),
    (error) => error instanceof CopcTileResourceProviderError &&
      error.code === 'STALE_SOURCE' &&
      error.conservativeBoundsResult.sourceGeneration === 7,
  );
  assert.deepEqual(base.diagnostics.nodes, ['root']);
});

test('requires explicit opt-in before scanning or materializing the full hierarchy', async () => {
  const source = createBrowserFixtureSource(12);

  for (const options of [{}, { scanCompleteHierarchy: false }]) {
    await assert.rejects(
      createCopcTileResourceProvider(source, options),
      (error) => error instanceof CopcTileResourceProviderError && error.code === 'FULL_HIERARCHY_SCAN_NOT_ENABLED',
    );
  }
  assert.equal(source.diagnostics.hierarchyPages, 0);
  assert.equal(source.diagnostics.conservativeBounds, 0);
  assert.deepEqual(source.diagnostics.nodes, []);
});

test('computes Float32 reconstruction padding from bounds before content is decoded', () => {
  const bounds = {
    minimum: [6378130, -10, -10],
    maximum: [6378140, 10, 10],
  };
  const padding = getFloat32EcefReconstructionErrorBound(bounds);
  assert.ok(Number.isFinite(padding) && padding > 0);
  assert.ok(padding < 0.01);
  assert.throws(() => getFloat32EcefReconstructionErrorBound({
    minimum: [Infinity, 0, 0], maximum: [1, 1, 1],
  }), /finite ordered/);
});

function assertTileBoxContains(parent, child) {
  const parentCenter = [parent.transform[12], parent.transform[13], parent.transform[14]];
  const childCenter = [
    parentCenter[0] + child.transform[12],
    parentCenter[1] + child.transform[13],
    parentCenter[2] + child.transform[14],
  ];
  const parentHalf = [parent.boundingVolume.box[3], parent.boundingVolume.box[7], parent.boundingVolume.box[11]];
  const childHalf = [child.boundingVolume.box[3], child.boundingVolume.box[7], child.boundingVolume.box[11]];
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(childCenter[axis] - childHalf[axis] >= parentCenter[axis] - parentHalf[axis] - 1e-8);
    assert.ok(childCenter[axis] + childHalf[axis] <= parentCenter[axis] + parentHalf[axis] + 1e-8);
  }
}

function assertGlbPointsInside(bytes, tileTransform, parentTransform, bounds) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = data.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
  const binaryStart = 20 + jsonLength + 8;
  const accessor = json.accessors[0];
  const bufferView = json.bufferViews[accessor.bufferView];
  const positionOffset = binaryStart + bufferView.byteOffset + (accessor.byteOffset ?? 0);
  const worldOrigin = [0, 1, 2].map((axis) => (parentTransform?.[12 + axis] ?? 0) + tileTransform[12 + axis]);
  const minimum = bounds.minimum ?? [bounds.minX, bounds.minY, bounds.minZ];
  const maximum = bounds.maximum ?? [bounds.maxX, bounds.maxY, bounds.maxZ];
  for (let point = 0; point < accessor.count; point += 1) {
    const offset = positionOffset + point * 12;
    const local = [
      data.getFloat32(offset, true),
      -data.getFloat32(offset + 8, true),
      data.getFloat32(offset + 4, true),
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = worldOrigin[axis] + local[axis];
      assert.ok(coordinate >= minimum[axis] - 1e-8, `${coordinate} is below padded axis ${axis} minimum ${minimum[axis]}`);
      assert.ok(coordinate <= maximum[axis] + 1e-8, `${coordinate} is above padded axis ${axis} maximum ${maximum[axis]}`);
    }
  }
}
