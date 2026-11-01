import assert from 'node:assert/strict';
import test from 'node:test';
import * as adapterCore from '@frillab/copc-adapter/core';
import { CopcCoreAdapterError, CopcCoreNodeSource, wrapCopcCoreNodeSource } from '../src/adapter/copcCoreAdapter.ts';
import { TileNodeReader } from '../src/source/tileNodeReader.ts';
import { createPaddedEcefBoundsFromConservativeResult } from '../src/tileset/explicitTileset.ts';

const node = {
  key: '0-0-0-0', level: 0, x: 0, y: 0, z: 0,
  pointCount: 2, pointDataOffset: 128, pointDataLength: 40,
  children: [], childrenComplete: true,
};

function preparedData({ available = ['position', 'rgb', 'intensity', 'classification'], extras = [], count = 2 } = {}) {
  const sourceCoordinates = new Float64Array(count * 3).fill(1);
  const geographic = new Float64Array(count * 3).fill(2);
  const ecef = new Float64Array(count * 3).fill(3);
  const attributes = {};
  if (available.includes('rgb')) {
    attributes.red = new Uint16Array(count).fill(10);
    attributes.green = new Uint16Array(count).fill(20);
    attributes.blue = new Uint16Array(count).fill(30);
  }
  if (available.includes('intensity')) attributes.intensity = new Uint16Array(count).fill(100);
  if (available.includes('classification')) attributes.classification = new Uint8Array(count).fill(2);
  if (extras.length > 0) {
    attributes.extraDimensions = Object.fromEntries(extras.map((name) => [name, new BigUint64Array(count).fill(9007199254740993n)]));
  }
  return {
    node,
    pointData: {
      pointCount: count,
      source: { coordinateSystem: 'copc-source', pointCount: count, coordinates: sourceCoordinates },
      geographic: { coordinateSystem: 'wgs84-geographic', pointCount: count, coordinates: geographic },
      world: { coordinateSystem: 'wgs84-ecef-meters', pointCount: count, coordinates: ecef },
      coordinates: geographic,
      sourceCoordinates,
      worldCoordinates: ecef,
      attributes,
    },
    availableFields: new Set(available),
    availableExtraDimensions: extras,
    ecefBounds: count > 0 ? {
      coordinateSystem: 'wgs84-ecef-meters', minX: 3, minY: 3, minZ: 3, maxX: 3, maxY: 3, maxZ: 3,
    } : undefined,
    ecefBoundsKind: 'decoded-point-content',
    sourceIdentity: 'https://example.invalid/private-source.copc.laz?token=not-exported',
    sourceGeneration: 17,
    transformGeneration: 17,
    transformPlan: {
      schema: 'copc-coordinate-transform-plan', version: 1, identity: { key: 'plan-17' },
      source: {
        horizontalCrs: { authority: 'EPSG', code: '26910', name: 'NAD83 / UTM zone 10N', certainty: 'explicit' },
        verticalCrs: undefined,
        horizontalUnits: { kind: 'linear', name: 'metre', certainty: 'explicit' },
        verticalUnits: { kind: 'linear', name: 'metre', certainty: 'explicit' },
      },
      target: { worldCoordinateSystem: 'wgs84-ecef-meters' },
      manualHeightOffsetMeters: 0,
      operations: [],
      provenance: { sourceWkt: 'source WKT fixture' },
    },
  };
}

function makeSource(overrides = {}) {
  let current = true;
  let closed = 0;
  const source = {
    source: 'https://example.invalid/private-source.copc.laz?token=not-exported',
    sourceGeneration: 17,
    transformGeneration: 17,
    transformPlan: preparedData().transformPlan,
    getMetadata: () => ({ pointCount: 2, cube: {} }),
    isCurrent: (generation = 17) => current && generation === 17,
    getNodeCellBounds: () => ({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }),
    getConservativeNodeEcefBounds: (nodeKey) => unsupportedBoundsResult(source, nodeKey),
    getRootHierarchyPage: () => ({ key: 'root', pageOffset: 0, pageLength: 32 }),
    loadHierarchyPage: async () => ({ nodes: [node], pages: [] }),
    loadPreparedNodeData: async () => preparedData(),
    close: () => { closed += 1; current = false; },
    setCurrent: (value) => { current = value; },
    get closedCount() { return closed; },
    ...overrides,
  };
  return source;
}

function supportedBoundsResult(source, nodeKey, options = {}) {
  const sourceCellBounds = source.getNodeCellBounds(nodeKey);
  return {
    nodeKey,
    sourceCellBounds,
    sourceCoordinateSystem: 'copc-source',
    sourceIdentity: source.source,
    sourceGeneration: source.sourceGeneration,
    transformGeneration: source.transformGeneration,
    transformPlanIdentity: source.transformPlan.identity.key,
    heightOffsetMeters: source.transformPlan.manualHeightOffsetMeters,
    ...(options.verticalGrid === undefined ? {} : { verticalGrid: options.verticalGrid }),
    status: 'supported',
    boundsEcef: options.boundsEcef ?? {
      coordinateSystem: 'wgs84-ecef-meters',
      minX: 6_378_130,
      minY: -1,
      minZ: -1,
      maxX: 6_378_150,
      maxY: 112,
      maxZ: 112,
    },
    coverage: 'full-source-cell-and-descendant-cells',
    method: 'wgs84-geodetic-interval-v1',
    verification: 'analytic-interval',
    verticalReference: options.verticalReference ?? 'ellipsoidal',
    sourceVerticalUnitToMeters: options.sourceVerticalUnitToMeters ?? 1,
    encoderErrorPaddingRequired: true,
    assumptions: ['validated WGS84 geographic source cell', 'ellipsoidal height interval'],
  };
}

function unsupportedBoundsResult(source, nodeKey, reasonCode = 'unsupported-horizontal-crs') {
  return {
    nodeKey,
    sourceCellBounds: source.getNodeCellBounds(nodeKey),
    sourceCoordinateSystem: 'copc-source',
    sourceIdentity: source.source,
    sourceGeneration: source.sourceGeneration,
    transformGeneration: source.transformGeneration,
    transformPlanIdentity: source.transformPlan.identity.key,
    heightOffsetMeters: source.transformPlan.manualHeightOffsetMeters,
    status: 'unsupported',
    reasonCode,
    reason: `Fixture: ${reasonCode}`,
  };
}

function geographicPlan(code, options = {}) {
  const base = preparedData().transformPlan;
  return {
    ...base,
    identity: { key: `geographic-plan-${code}` },
    source: {
      ...base.source,
      horizontalCrs: {
        authority: 'EPSG', code: String(code), name: code === 4326 ? 'WGS 84' : 'WGS 84 (3D)', certainty: 'explicit',
      },
      verticalCrs: options.verticalGrid === undefined
        ? { authority: 'EPSG', code: '4979', name: 'WGS 84 3D' }
        : { authority: 'EPSG', code: '5703', name: 'NAVD88 height' },
      verticalUnits: { kind: 'linear', name: options.verticalUnit ?? 'metre', certainty: 'explicit' },
      verticalUnitConversion: {
        scaleToMeters: options.verticalUnit === 'US survey foot' ? 1200 / 3937 : 1,
        source: 'wkt',
      },
    },
    manualHeightOffsetMeters: options.heightOffsetMeters ?? 0,
    ...(options.verticalGrid === undefined ? {} : { verticalGrid: options.verticalGrid }),
  };
}

function validatedGridProvenance() {
  return {
    id: 'fixture-geoid-grid',
    sha256: 'a'.repeat(64),
    sourceVerticalCrs: 'EPSG:5703',
    targetVerticalCrs: 'EPSG:4979',
    samplingHorizontalCrs: 'EPSG:4326',
    referenceEllipsoid: 'WGS84',
    interpolation: 'bilinear',
    valueUnit: 'metre',
    valueConvention: 'ellipsoidal-minus-orthometric',
    noDataValue: null,
    width: 2,
    height: 2,
    longitude: { min: -1, max: 1, coverage: 'none' },
    latitude: { min: -1, max: 1 },
    minimumUndulationMeters: -10,
    maximumUndulationMeters: 12,
    compatibility: 'validated',
  };
}

function wrap(source, overrides = {}) {
  return wrapCopcCoreNodeSource({
    source,
    sourceIdentity: 'opaque-source-identity',
    ...overrides,
  });
}

test('the installed Registry Adapter 0.7.1 package publishes the renderer-neutral Core and conservative-bounds runtime API', () => {
  assert.equal(typeof adapterCore.createCopcContext, 'function');
  assert.equal(typeof adapterCore.CopcContext, 'function');
  assert.equal(typeof adapterCore.CopcContext.prototype.getConservativeNodeEcefBounds, 'function');
  assert.equal(typeof adapterCore.getCopcHierarchyCellBounds, 'function');
  assert.equal(typeof adapterCore.createCoordinateTransformPlan, 'function');
});

test('for WGS84 EPSG:4326 and EPSG:4979 fixtures, preserves analytic full-cell bounds and never reads points', () => {
  for (const code of [4326, 4979]) {
    let pointReads = 0;
    let hierarchyReads = 0;
    let conservativeCalls = 0;
    const plan = geographicPlan(code);
    let source;
    source = makeSource({
      transformPlan: plan,
      getConservativeNodeEcefBounds: (nodeKey) => {
        conservativeCalls += 1;
        return supportedBoundsResult(source, nodeKey);
      },
      loadHierarchyPage: async () => { hierarchyReads += 1; return { nodes: [], pages: [] }; },
      loadPreparedNodeData: async () => { pointReads += 1; return preparedData(); },
    });
    const bridge = wrap(source);
    const bounds = bridge.getConservativeNodeEcefBounds(node.key);

    assert.equal(bounds.status, 'supported');
    assert.equal(bounds.coverage, 'full-source-cell-and-descendant-cells');
    assert.equal(bounds.verification, 'analytic-interval');
    assert.equal(bounds.boundsEcef.coordinateSystem, 'wgs84-ecef-meters');
    assert.equal(bounds.sourceCellBounds.minX, 0);
    assert.equal(bounds.transformPlanIdentity, plan.identity.key);
    assert.equal(bounds.sourceGeneration, 17);
    assert.equal(bounds.transformGeneration, 17);
    assert.equal(bounds.encoderErrorPaddingRequired, true);
    assert.equal(Object.isFrozen(bounds), true);
    assert.equal(Object.isFrozen(bounds.boundsEcef), true);
    assert.equal(pointReads, 0);
    assert.equal(hierarchyReads, 0);
    assert.equal(conservativeCalls, 1);
    bridge.close();
    assert.equal(code === 4326 || code === 4979, true);
  }
});

test('preserves manual height offset and validated vertical-grid dependencies in supported results', () => {
  const grid = validatedGridProvenance();
  const plan = geographicPlan(4979, { verticalGrid: grid, heightOffsetMeters: 2.5, verticalUnit: 'US survey foot' });
  let source;
  source = makeSource({
    transformPlan: plan,
    getConservativeNodeEcefBounds: (nodeKey) => supportedBoundsResult(source, nodeKey, {
      verticalGrid: grid,
      verticalReference: 'validated-grid',
      sourceVerticalUnitToMeters: 1200 / 3937,
    }),
  });
  const result = wrap(source).getConservativeNodeEcefBounds(node.key);
  assert.equal(result.status, 'supported');
  assert.equal(result.verticalReference, 'validated-grid');
  assert.equal(result.heightOffsetMeters, 2.5);
  assert.equal(result.sourceVerticalUnitToMeters, 1200 / 3937);
  assert.deepEqual(result.verticalGrid, grid);
  assert.equal(result.verticalGrid.compatibility, 'validated');
});

test('rejects conservative bounds whose vertical unit or validated grid differs from the active transform plan', () => {
  const grid = validatedGridProvenance();
  const plan = geographicPlan(4979, { verticalGrid: grid, verticalUnit: 'US survey foot' });
  for (const mismatch of [
    { verticalGrid: { ...grid, sha256: 'b'.repeat(64) }, sourceVerticalUnitToMeters: 1200 / 3937 },
    { verticalGrid: grid, sourceVerticalUnitToMeters: 1 },
    { verticalGrid: undefined, sourceVerticalUnitToMeters: 1200 / 3937 },
  ]) {
    let source;
    source = makeSource({
      transformPlan: plan,
      getConservativeNodeEcefBounds: (nodeKey) => supportedBoundsResult(source, nodeKey, {
        verticalGrid: mismatch.verticalGrid,
        verticalReference: 'validated-grid',
        sourceVerticalUnitToMeters: mismatch.sourceVerticalUnitToMeters,
      }),
    });
    assert.throws(
      () => wrap(source).getConservativeNodeEcefBounds(node.key),
      (error) => error instanceof CopcCoreAdapterError && error.code === 'INVALID_CONSERVATIVE_BOUNDS',
    );
    source.close();
  }
});

test('keeps parent conservative bounds around descendant cells and keeps source-cell, ECEF-cell, and decoded-point bounds distinct', async () => {
  const child = {
    key: '1-0-0-0', level: 1, x: 0, y: 0, z: 0,
    pointCount: 1, pointDataOffset: 168, pointDataLength: 20,
    children: [], childrenComplete: true,
  };
  const sourceCells = {
    [node.key]: { minX: -0.001, minY: -0.001, minZ: 0, maxX: 0.001, maxY: 0.001, maxZ: 10 },
    [child.key]: { minX: 0, minY: 0, minZ: 1, maxX: 0.001, maxY: 0.001, maxZ: 5 },
  };
  const ecefBounds = {
    [node.key]: { coordinateSystem: 'wgs84-ecef-meters', minX: 6_378_130, minY: -1, minZ: -1, maxX: 6_378_150, maxY: 112, maxZ: 112 },
    [child.key]: { coordinateSystem: 'wgs84-ecef-meters', minX: 6_378_132, minY: 10, minZ: 20, maxX: 6_378_146, maxY: 90, maxZ: 100 },
  };
  let source;
  source = makeSource({
    getNodeCellBounds: (key) => sourceCells[key],
    getConservativeNodeEcefBounds: (key) => supportedBoundsResult(source, key, { boundsEcef: ecefBounds[key] }),
  });
  const bridge = wrap(source);
  const parentBounds = bridge.getConservativeNodeEcefBounds(node.key);
  const childBounds = bridge.getConservativeNodeEcefBounds(child.key);
  assert.equal(parentBounds.status, 'supported');
  assert.equal(childBounds.status, 'supported');
  assert.ok(childBounds.boundsEcef.minX >= parentBounds.boundsEcef.minX);
  assert.ok(childBounds.boundsEcef.maxX <= parentBounds.boundsEcef.maxX);
  assert.ok(childBounds.boundsEcef.minY >= parentBounds.boundsEcef.minY);
  assert.ok(childBounds.boundsEcef.maxY <= parentBounds.boundsEcef.maxY);
  assert.ok(childBounds.boundsEcef.minZ >= parentBounds.boundsEcef.minZ);
  assert.ok(childBounds.boundsEcef.maxZ <= parentBounds.boundsEcef.maxZ);
  assert.deepEqual(bridge.getNodeCellBounds(node.key), sourceCells[node.key]);
  const pointView = await bridge.loadNode(node, {});
  assert.equal(pointView.context.decodedPointEcefBoundsKind, 'decoded-point-content');
  assert.notDeepEqual(pointView.context.decodedPointEcefBounds, parentBounds.boundsEcef);
  bridge.close();
});

test('preserves explicit unsupported results for Autzen and SoFi projected CRS without inventing bounds', () => {
  for (const [code, sourceName] of [[2992, 'Autzen'], [32611, 'SoFi']]) {
    let pointReads = 0;
    const plan = geographicPlan(code);
    let source;
    source = makeSource({
      transformPlan: plan,
      getConservativeNodeEcefBounds: (nodeKey) => unsupportedBoundsResult(source, nodeKey),
      loadPreparedNodeData: async () => { pointReads += 1; return preparedData(); },
    });
    const bridge = wrap(source);
    const result = bridge.getConservativeNodeEcefBounds(node.key);
    assert.equal(result.status, 'unsupported', sourceName);
    assert.equal(result.reasonCode, 'unsupported-horizontal-crs', sourceName);
    assert.match(result.reason, /unsupported-horizontal-crs/);
    assert.equal(result.sourceIdentity, source.source);
    assert.equal(result.sourceGeneration, source.sourceGeneration);
    assert.equal(result.transformPlanIdentity, plan.identity.key);
    assert.equal('boundsEcef' in result, false);
    assert.equal(pointReads, 0);
    assert.throws(
      () => createPaddedEcefBoundsFromConservativeResult(result, 0),
      (error) => error.code === 'UNSUPPORTED_BOUNDS' && error.conservativeBoundsResult === result,
    );
    bridge.close();
  }
});

test('fails closed for a missing or mismatched conservative bounds API and a stale source', () => {
  const oldSource = makeSource({ getConservativeNodeEcefBounds: undefined });
  assert.throws(
    () => wrap(oldSource),
    (error) => error instanceof CopcCoreAdapterError && error.code === 'MISSING_CONSERVATIVE_BOUNDS_API',
  );
  let source;
  source = makeSource({
    getConservativeNodeEcefBounds: (nodeKey) => ({
      ...supportedBoundsResult(source, nodeKey),
      transformPlanIdentity: 'stale-plan',
    }),
  });
  assert.throws(
    () => wrap(source).getConservativeNodeEcefBounds(node.key),
    (error) => error instanceof CopcCoreAdapterError && error.code === 'INVALID_CONSERVATIVE_BOUNDS',
  );
  source.setCurrent(false);
  assert.throws(
    () => wrap(source).getConservativeNodeEcefBounds(node.key),
    (error) => error instanceof CopcCoreAdapterError && error.code === 'STALE_SOURCE',
  );
});

test('exposes immutable source metadata, source-space cell bounds, and the Adapter transform plan', () => {
  const metadata = {
    pointCount: 2,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
    extraDimensions: [{ name: 'track_id', type: 'unsigned', length: 8 }],
  };
  const cellBounds = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  const source = makeSource({ getMetadata: () => metadata, getNodeCellBounds: () => cellBounds });
  const bridge = wrap(source);

  const exposedMetadata = bridge.getMetadata();
  assert.notEqual(exposedMetadata, metadata);
  assert.notEqual(exposedMetadata.extraDimensions, metadata.extraDimensions);
  assert.equal(Object.isFrozen(exposedMetadata.extraDimensions[0]), true);
  assert.equal(bridge.transformPlan, source.transformPlan);
  assert.deepEqual(bridge.getNodeCellBounds(node.key), cellBounds);
  assert.notEqual(bridge.getNodeCellBounds(node.key), cellBounds);
  bridge.close();
});

test('loads A-shaped prepared point data through public Core methods without copying ECEF or attributes', async () => {
  let receivedFields;
  let receivedOptions;
  const prepared = preparedData();
  const source = makeSource({
    loadPreparedNodeData: async (_node, fields, options) => {
      receivedFields = fields;
      receivedOptions = options;
      return prepared;
    },
  });
  const bridge = wrap(source);
  const view = await bridge.loadNode(node, { attributes: { rgb: true, intensity: true } });

  assert.deepEqual([...receivedFields].sort(), ['intensity', 'position', 'rgb']);
  assert.equal(receivedOptions.signal instanceof AbortSignal, true);
  assert.equal(view.context.nodeKey, node.key);
  assert.equal(view.context.sourceGeneration, 17);
  assert.equal(view.context.transformGeneration, 17);
  assert.equal(view.context.transformPlan, prepared.transformPlan);
  assert.equal(view.context.availableFields.includes('rgb'), true);
  assert.equal(view.context.decodedPointEcefBoundsKind, 'decoded-point-content');
  assert.equal(view.ecef, prepared.pointData.world.coordinates);
  assert.equal(view.attributes.red, prepared.pointData.attributes.red);
  bridge.close();
  assert.equal(source.closedCount, 0, 'wrapping a caller-owned context does not close it');
});

test('rejects explicitly requested standard fields that are unavailable', async () => {
  const prepared = preparedData({ available: ['position', 'intensity'] });
  const source = makeSource({ loadPreparedNodeData: async () => prepared });
  const bridge = wrap(source);
  await assert.rejects(
    bridge.loadNode(node, { attributes: { rgb: true } }),
    (error) => error.code === 'MISSING_REQUESTED_FIELD' && error.field === 'rgb',
  );
  const view = await bridge.loadNode(node, { attributes: { intensity: true } });
  assert.deepEqual(view.context.availableFields, ['position', 'intensity']);
  assert.equal(view.attributes?.rgb, undefined);
  assert.equal(view.attributes?.red, undefined);
  assert.equal(view.attributes?.intensity, prepared.pointData.attributes.intensity);
});

test('requests exact Extra Dimension names and preserves returned BigUint64 data by reference', async () => {
  const prepared = preparedData({ extras: ['track_id'] });
  let requestedOptions;
  const source = makeSource({
    loadPreparedNodeData: async (_requested, _fields, options) => {
      requestedOptions = options;
      return prepared;
    },
  });
  const view = await wrap(source).loadNode(node, { attributes: { extraDimensions: ['track_id'] } });

  assert.deepEqual(requestedOptions.extraDimensions, ['track_id']);
  assert.deepEqual(view.context.availableExtraDimensions, ['track_id']);
  assert.equal(view.attributes.extraDimensions.track_id, prepared.pointData.attributes.extraDimensions.track_id);
  assert.deepEqual([...view.attributes.extraDimensions.track_id], [9007199254740993n, 9007199254740993n]);
});

test('rejects an explicitly requested Extra Dimension when Core did not return it', async () => {
  const source = makeSource({
    loadPreparedNodeData: async () => preparedData({ available: ['position'], extras: [] }),
  });
  await assert.rejects(
    wrap(source).loadNode(node, { attributes: { extraDimensions: ['track_id'] } }),
    (error) => error.code === 'MISSING_REQUESTED_FIELD' && error.field === 'track_id',
  );
});

test('TileNodeReader follows Core hierarchy pages and deduplicates requested node keys', async () => {
  const pages = [];
  const pointKeys = [];
  const source = makeSource({
    loadHierarchyPage: async (page, options) => {
      pages.push({ key: page.key, signal: options.signal });
      return page.key === 'root'
        ? { nodes: [], pages: [{ key: 'child', pageOffset: 32, pageLength: 32 }] }
        : { nodes: [node], pages: [] };
    },
    loadPreparedNodeData: async (requested) => { pointKeys.push(requested.key); return preparedData(); },
  });
  const reader = new TileNodeReader(wrap(source));
  const views = await reader.readNodes([node.key, node.key], { attributes: { rgb: true } });
  assert.deepEqual(pages.map((page) => page.key), ['root', 'child']);
  assert.ok(pages.every((page) => page.signal instanceof AbortSignal));
  assert.deepEqual(pointKeys, [node.key]);
  assert.deepEqual([...views.keys()], [node.key]);
});

test('passes cancellation to hierarchy and prepared-node reads', async () => {
  let pageSignal;
  let pointSignal;
  const source = makeSource({
    loadHierarchyPage: async (_page, options) => { pageSignal = options.signal; return { nodes: [node], pages: [] }; },
    loadPreparedNodeData: (_node, _fields, options) => new Promise((_resolve, reject) => {
      pointSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }),
  });
  const bridge = wrap(source);
  const controller = new AbortController();
  const pending = bridge.loadNode(node, {}, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(pointSignal.aborted, true);

  let hierarchySignal;
  const hierarchySource = makeSource({
    loadHierarchyPage: (_page, options) => new Promise((_resolve, reject) => {
      hierarchySignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }),
  });
  const hierarchyBridge = wrap(hierarchySource);
  const hierarchyController = new AbortController();
  const hierarchyPending = hierarchyBridge.loadHierarchyPage({ key: 'root', pageOffset: 0, pageLength: 32 }, hierarchyController.signal);
  await new Promise((resolve) => setImmediate(resolve));
  hierarchyController.abort();
  await assert.rejects(hierarchyPending, { name: 'AbortError' });
  assert.equal(hierarchySignal.aborted, true);
});

test('close aborts local work and closes only an explicitly owned Core context', async () => {
  let signal;
  const shared = makeSource({
    loadPreparedNodeData: (_node, _fields, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      options.signal.addEventListener('abort', () => reject(new DOMException('closed', 'AbortError')), { once: true });
    }),
  });
  const local = wrap(shared);
  const pending = local.loadNode(node, {});
  await new Promise((resolve) => setImmediate(resolve));
  local.close();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(shared.closedCount, 0);

  const owned = wrap(shared, { ownsSource: true });
  owned.close();
  owned.close();
  assert.equal(shared.closedCount, 1);
  assert.equal(owned.isCurrent(), false);
});

test('rejects a result made stale by a source generation change', async () => {
  let resolvePrepared;
  const source = makeSource({
    loadPreparedNodeData: () => new Promise((resolve) => { resolvePrepared = resolve; }),
  });
  const bridge = wrap(source);
  const pending = bridge.loadNode(node, {});
  await new Promise((resolve) => setImmediate(resolve));
  source.setCurrent(false);
  resolvePrepared(preparedData());
  await assert.rejects(pending, (error) => error instanceof CopcCoreAdapterError && error.code === 'STALE_SOURCE');
});

test('rejects mismatched node or source generations and malformed decoded-point bounds', async () => {
  const mismatched = makeSource({ loadPreparedNodeData: async () => ({ ...preparedData(), sourceGeneration: 18 }) });
  await assert.rejects(wrap(mismatched).loadNode(node, {}), (error) => error.code === 'NODE_MISMATCH');

  const malformedBounds = makeSource({ loadPreparedNodeData: async () => ({
    ...preparedData(), ecefBounds: { coordinateSystem: 'copc-source', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
  }) });
  await assert.rejects(wrap(malformedBounds).loadNode(node, {}), (error) => error.code === 'INVALID_PREPARED_BOUNDS');
});

test('factory options require an opaque source identity and valid Core generations', () => {
  assert.throws(() => wrap(makeSource(), { sourceIdentity: '  ' }), (error) => error.code === 'INVALID_SOURCE');
  assert.throws(() => wrap(makeSource({ sourceGeneration: Number.MAX_SAFE_INTEGER + 1 })), (error) => error.code === 'INVALID_SOURCE');
});
