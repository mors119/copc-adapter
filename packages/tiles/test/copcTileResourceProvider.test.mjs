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
