import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import validator from '3d-tiles-validator';
import { createExperimentalETilePointView } from '../src/input/tilePointView.ts';
import { encodePointCloudGlb } from '../src/gltf/pointCloudGlb.ts';
import { createExplicitTileset, ExplicitTilesetError } from '../src/tileset/explicitTileset.ts';

const rootNode = {
  key: 'root', level: 0, x: 0, y: 0, z: 0,
  pointCount: 1, pointDataOffset: 100, pointDataLength: 24,
  children: ['left', 'empty'], childrenComplete: true,
};
const leftNode = {
  key: 'left', level: 1, x: 0, y: 0, z: 0,
  pointCount: 1, pointDataOffset: 124, pointDataLength: 24,
  children: [], childrenComplete: true,
};
const emptyNode = {
  key: 'empty', level: 1, x: 1, y: 0, z: 0,
  pointCount: 0, pointDataOffset: 0, pointDataLength: 0,
  children: [], childrenComplete: true,
};
const rootBounds = { minimum: [6378130, -10, -10], maximum: [6378140, 10, 10] };
const leftBounds = { minimum: [6378130, -10, -10], maximum: [6378135, 0, 0] };
const emptyBounds = { minimum: [6378135, -10, -10], maximum: [6378140, 0, 0] };

const inputs = [
  { node: rootNode, bounds: rootBounds },
  { node: leftNode, bounds: leftBounds },
  { node: emptyNode, bounds: emptyBounds },
];

const context = (nodeKey) => ({
  sourceIdentity: 'tileset-fixture',
  nodeKey,
  transformGeneration: 1,
  sourceCrs: { status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' },
  verticalDatum: { status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [] },
  heightOffsetMeters: 0,
});

function contentFilesFor(tileset) {
  const content = [];
  const visit = (tile) => {
    if (tile.content) content.push(tile.content.uri);
    for (const child of tile.children ?? []) visit(child);
  };
  visit(tileset.root);
  return content;
}

function glbFor(nodeKey, point) {
  const ecef = new Float64Array(point);
  const view = createExperimentalETilePointView({
    pointCount: 1,
    ecef,
    height: new Float64Array([0]),
  }, context(nodeKey), { sourceIdentity: 'tileset-fixture', transformGeneration: 1 });
  const encoded = encodePointCloudGlb(view, { precision: { originEcef: new Float64Array(point) } });
  assert.ok(encoded);
  return encoded.bytes;
}

function assertTilesetError(code, action) {
  assert.throws(action, (error) => error instanceof ExplicitTilesetError && error.code === code);
}

test('builds conservative explicit tileset geometry from hierarchy metadata only', () => {
  const tileset = createExplicitTileset(inputs);
  assert.equal(tileset.asset.version, '1.1');
  assert.equal(tileset.root.refine, 'ADD');
  assert.equal(tileset.root.geometricError, tileset.geometricError);
  assert.deepEqual(tileset.root.transform.slice(12, 15), [6378135, 0, 0]);
  assert.deepEqual(tileset.root.boundingVolume.box.slice(0, 3), [0, 0, 0]);
  assert.ok(tileset.root.geometricError >= tileset.root.children[0].geometricError);
  assert.equal(tileset.root.children.length, 2);
  assert.deepEqual(tileset.root.children[0].transform.slice(12, 15), [-2.5, -5, -5]);
  assert.equal(tileset.root.children[0].content.uri, 'content/6c656674.glb');
  assert.equal(Object.hasOwn(tileset.root.children[1], 'content'), false);
  assert.equal(tileset.root.children[1].geometricError, 0);
  assert.ok(contentFilesFor(tileset).every((uri) => !uri.includes('..')));
});

test('requires complete child discovery and a unique connected octree', () => {
  assertTilesetError('INCOMPLETE_HIERARCHY', () => createExplicitTileset([
    { node: { ...rootNode, childrenComplete: false }, bounds: rootBounds },
    ...inputs.slice(1),
  ]));
  const rootWithoutCompleteness = { ...rootNode };
  delete rootWithoutCompleteness.childrenComplete;
  assertTilesetError('INCOMPLETE_HIERARCHY', () => createExplicitTileset([
    { node: rootWithoutCompleteness, bounds: rootBounds },
    ...inputs.slice(1),
  ]));
  assertTilesetError('INCOMPLETE_HIERARCHY', () => createExplicitTileset([
    { node: { ...rootNode, children: ['missing'] }, bounds: rootBounds },
  ]));
  assertTilesetError('INVALID_COVERAGE', () => createExplicitTileset([
    ...inputs,
    { node: { ...leftNode, key: 'orphan' }, bounds: leftBounds },
  ]));
});

test('rejects invalid bounds, unsafe counts, child voxels and non-conservative coverage', () => {
  assertTilesetError('INVALID_BOUNDS', () => createExplicitTileset([
    { node: rootNode, bounds: { minimum: [1, Number.NaN, 0], maximum: [2, 3, 4] } },
  ]));
  assertTilesetError('INVALID_COVERAGE', () => createExplicitTileset([
    { node: rootNode, bounds: rootBounds },
    { node: { ...leftNode, level: 2 }, bounds: leftBounds },
    { node: emptyNode, bounds: emptyBounds },
  ]));
  assertTilesetError('INVALID_COVERAGE', () => createExplicitTileset([
    { node: rootNode, bounds: rootBounds },
    { node: leftNode, bounds: { minimum: [6378129, -10, -10], maximum: [6378135, 0, 0] } },
    { node: emptyNode, bounds: emptyBounds },
  ]));
  assertTilesetError('TILESET_LIMIT', () => createExplicitTileset(inputs, { maxTotalPoints: 1 }));
});

test('safe node-key encoding cannot introduce path traversal', () => {
  const malicious = { ...leftNode, key: '../left' };
  const tileset = createExplicitTileset([
    { node: { ...rootNode, children: ['../left', 'empty'] }, bounds: rootBounds },
    { node: malicious, bounds: leftBounds },
    { node: emptyNode, bounds: emptyBounds },
  ]);
  const uri = tileset.root.children[0].content.uri;
  assert.match(uri, /^content\/[0-9a-f]+\.glb$/);
  assert.equal(uri.includes('..'), false);
});

test('the official Cesium 3D Tiles Validator accepts generated 1.1 tileset, bounds, transforms and GLB content', async () => {
  const tileset = createExplicitTileset(inputs, { tilesetVersion: 'fixture-v1' });
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-t5-'));
  try {
    await mkdir(join(directory, 'content'));
    await writeFile(join(directory, 'tileset.json'), JSON.stringify(tileset));
    await writeFile(join(directory, 'content', '726f6f74.glb'), glbFor('root', [6378135, 0, 0]));
    await writeFile(join(directory, 'content', '6c656674.glb'), glbFor('left', [6378132.5, -5, -5]));
    const report = await validator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    const errors = report.issues.filter((issue) => issue.severity === 'ERROR');
    const warnings = report.issues.filter((issue) => issue.severity === 'WARNING');
    assert.deepEqual(errors, [], report.serialize());
    assert.deepEqual(warnings, [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
