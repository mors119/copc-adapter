import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import validator from '3d-tiles-validator';
import { createExperimentalETilePointView } from '../src/input/tilePointView.ts';
import { encodePointCloudGlb } from '../src/gltf/pointCloudGlb.ts';
import { octreeAvailabilityIndex, octreeMortonIndex, octreeSubtreeBitLengths } from '../src/implicit/octreeAvailability.ts';
import { createImplicitOctreeTileset, ImplicitOctreeError } from '../src/tileset/implicitOctreeTileset.ts';

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
  children: ['deep'], childrenComplete: true,
};
const deepNode = {
  key: 'deep', level: 2, x: 2, y: 0, z: 0,
  pointCount: 1, pointDataOffset: 148, pointDataLength: 24,
  children: [], childrenComplete: true,
};
const rootBounds = { minimum: [6378130, -10, -10], maximum: [6378140, 10, 10] };
const inputs = [
  { node: rootNode, bounds: rootBounds },
  { node: leftNode, bounds: { minimum: [6378130, -10, -10], maximum: [6378135, 0, 0] } },
  { node: emptyNode, bounds: { minimum: [6378135, -10, -10], maximum: [6378140, 0, 0] } },
  { node: deepNode, bounds: { minimum: [6378135, -10, -10], maximum: [6378137.5, -5, -5] } },
];
const context = (nodeKey) => ({
  sourceIdentity: 'implicit-octree-fixture',
  nodeKey,
  transformGeneration: 1,
  sourceCrs: { status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' },
  verticalDatum: { status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [] },
  heightOffsetMeters: 0,
});
const rootOrigin = new Float64Array([6378135, 0, 0]);

function subtreeFrom(bytes) {
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString('ascii'), 'subt');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(4, true), 1);
  const jsonLength = Number(view.getBigUint64(8, true));
  const binaryLength = Number(view.getBigUint64(16, true));
  assert.equal(jsonLength % 8, 0);
  assert.equal(binaryLength % 8, 0);
  assert.equal(24 + jsonLength + binaryLength, bytes.byteLength);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(24, 24 + jsonLength)).trim());
  const binary = bytes.subarray(24 + jsonLength, 24 + jsonLength + binaryLength);
  return { json, binary };
}

function readAvailability(subtree, descriptor, bitCount, bitIndex) {
  if (descriptor.constant !== undefined) return descriptor.constant === 1;
  const bufferView = subtree.json.bufferViews[descriptor.bitstream];
  assert.ok(bufferView);
  assert.equal(bufferView.byteOffset % 8, 0);
  const byte = subtree.binary[bufferView.byteOffset + Math.floor(bitIndex / 8)] ?? 0;
  assert.equal(bufferView.byteLength, Math.ceil(bitCount / 8));
  return ((byte >> (bitIndex % 8)) & 1) === 1;
}

function pointContent(nodeKey, ecef) {
  const view = createExperimentalETilePointView({
    pointCount: 1,
    ecef: new Float64Array(ecef),
    height: new Float64Array([0]),
  }, context(nodeKey), { sourceIdentity: 'implicit-octree-fixture', transformGeneration: 1 });
  const glb = encodePointCloudGlb(view, { precision: { originEcef: rootOrigin } });
  assert.ok(glb);
  return glb.bytes;
}

function assertImplicitError(code, action) {
  assert.throws(action, (error) => error instanceof ImplicitOctreeError && error.code === code);
}

test('uses standard Morton ordering, level offsets, bit lengths and little-endian availability bits', () => {
  assert.equal(octreeMortonIndex({ level: 3, x: 1, y: 2, z: 4 }), 0b100010001);
  assert.equal(octreeAvailabilityIndex({ level: 1, x: 1, y: 0, z: 0 }), 2);
  assert.deepEqual(octreeSubtreeBitLengths(2), {
    tileAvailability: 9,
    contentAvailability: 9,
    childSubtreeAvailability: 64,
  });
});

test('builds bounded binary subtree availability for a sparse octree with an empty tile', () => {
  const result = createImplicitOctreeTileset(inputs, { subtreeLevels: 2 });
  const tileset = result.tileset;
  assert.equal(tileset.asset.version, '1.1');
  assert.equal(tileset.root.refine, 'ADD');
  assert.equal(tileset.root.implicitTiling.subdivisionScheme, 'OCTREE');
  assert.equal(tileset.root.implicitTiling.availableLevels, 3);
  assert.equal(tileset.root.implicitTiling.subtreeLevels, 2);
  assert.equal(tileset.root.content.uri, 'content/{level}/{x}/{y}/{z}.glb');
  assert.deepEqual(tileset.root.transform.slice(12, 15), [6378135, 0, 0]);
  assert.deepEqual(result.contentOriginEcef, [6378135, 0, 0]);
  assert.deepEqual(tileset.root.boundingVolume.box.slice(0, 3), [0, 0, 0]);
  assert.deepEqual([...result.subtrees.keys()], [
    'subtrees/0/0/0/0.subtree',
    'subtrees/2/2/0/0.subtree',
  ]);

  const rootSubtree = subtreeFrom(result.subtrees.get('subtrees/0/0/0/0.subtree'));
  const lengths = octreeSubtreeBitLengths(2);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.tileAvailability, lengths.tileAvailability, 0), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.tileAvailability, lengths.tileAvailability, 1), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.tileAvailability, lengths.tileAvailability, 2), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.tileAvailability, lengths.tileAvailability, 3), false);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.contentAvailability[0], lengths.contentAvailability, 0), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.contentAvailability[0], lengths.contentAvailability, 1), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.contentAvailability[0], lengths.contentAvailability, 2), false);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.childSubtreeAvailability, lengths.childSubtreeAvailability, 8), true);
  assert.equal(readAvailability(rootSubtree, rootSubtree.json.childSubtreeAvailability, lengths.childSubtreeAvailability, 0), false);
  for (const bufferView of rootSubtree.json.bufferViews) {
    for (let byte = bufferView.byteOffset + bufferView.byteLength; byte < bufferView.byteOffset + 8; byte += 1) {
      assert.equal(rootSubtree.binary[byte], 0);
    }
  }

  const deepSubtree = subtreeFrom(result.subtrees.get('subtrees/2/2/0/0.subtree'));
  assert.equal(deepSubtree.json.tileAvailability.constant, undefined);
  assert.equal(readAvailability(deepSubtree, deepSubtree.json.tileAvailability, lengths.tileAvailability, 0), true);
  assert.equal(readAvailability(deepSubtree, deepSubtree.json.contentAvailability[0], lengths.contentAvailability, 0), true);
  assert.equal(deepSubtree.json.childSubtreeAvailability.constant, 0);
});

test('rejects incomplete, disconnected, duplicate-coordinate and geometrically inconsistent hierarchies', () => {
  assertImplicitError('INCOMPLETE_HIERARCHY', () => createImplicitOctreeTileset([
    { ...inputs[0], node: { ...rootNode, childrenComplete: false } },
  ]));
  assertImplicitError('INCOMPLETE_HIERARCHY', () => createImplicitOctreeTileset([
    inputs[0], inputs[1], inputs[3],
  ]));
  assertImplicitError('INVALID_COVERAGE', () => createImplicitOctreeTileset([
    ...inputs,
    { node: { ...deepNode, key: 'same-coordinate' }, bounds: inputs[3].bounds },
  ]));
  assertImplicitError('INVALID_BOUNDS', () => createImplicitOctreeTileset([
    ...inputs.slice(0, 3),
    { node: deepNode, bounds: { minimum: [6378130, -10, -10], maximum: [6378132, -8, -8] } },
  ], { subtreeLevels: 2 }));
  assertImplicitError('INCOMPLETE_HIERARCHY', () => createImplicitOctreeTileset([
    { node: { ...rootNode, children: ['absent'] }, bounds: rootBounds }, inputs[1], inputs[2], inputs[3],
  ]));
});

test('rejects unsafe ranges, unsupported subtree sizes, and configured work limits', () => {
  assertImplicitError('INVALID_INPUT', () => createImplicitOctreeTileset([
    { node: { ...rootNode, pointDataOffset: Number.MAX_SAFE_INTEGER, pointDataLength: 1 }, bounds: rootBounds },
    ...inputs.slice(1),
  ]));
  assertImplicitError('TILESET_LIMIT', () => createImplicitOctreeTileset(inputs, { subtreeLevels: 7 }));
  assertImplicitError('TILESET_LIMIT', () => createImplicitOctreeTileset(inputs, { maxNodes: 2 }));
  assertImplicitError('TILESET_LIMIT', () => createImplicitOctreeTileset(inputs, { maxTotalPoints: 2 }));
  assertImplicitError('TILESET_LIMIT', () => createImplicitOctreeTileset(inputs, { maxTotalSubtreeBytes: 1 }));
});

test('CesiumGS validator accepts the generated 3D Tiles 1.1 implicit octree and binary subtrees', async () => {
  const result = createImplicitOctreeTileset(inputs, { subtreeLevels: 2, tilesetVersion: 'sparse-fixture-v1' });
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-t6-'));
  try {
    await writeFile(join(directory, 'tileset.json'), JSON.stringify(result.tileset));
    for (const [uri, bytes] of result.subtrees) {
      const path = join(directory, uri);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const content = [
      ['content/0/0/0/0.glb', 'root', [6378135, 0, 0]],
      ['content/1/0/0/0.glb', 'left', [6378132.5, -5, -5]],
      ['content/2/2/0/0.glb', 'deep', [6378136.25, -7.5, -7.5]],
    ];
    for (const [uri, key, ecef] of content) {
      const path = join(directory, uri);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, pointContent(key, ecef));
    }
    const report = await validator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    const errors = report.issues.filter((issue) => issue.severity === 'ERROR');
    const warnings = report.issues.filter((issue) => issue.severity === 'WARNING');
    assert.deepEqual(errors, [], report.serialize());
    assert.deepEqual(warnings, [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
