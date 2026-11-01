import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import validator from 'gltf-validator';
import tilesValidator from '3d-tiles-validator';
import { createExperimentalETilePointView } from '../src/input/tilePointView.ts';
import { encodePointCloudGlb, GlbEncodingError } from '../src/gltf/pointCloudGlb.ts';
import { createPaddedEcefBoundsFromConservativeResult } from '../src/tileset/explicitTileset.ts';

const context = {
  sourceIdentity: 'glb-fixture',
  nodeKey: 'node-1',
  transformGeneration: 1,
  sourceCrs: { status: 'identified', identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' },
  verticalDatum: { status: 'verified', identifier: 'WGS 84 ellipsoidal height', corrections: [] },
  heightOffsetMeters: 0,
};

function pointView({ points = [[6378137, 0, 0], [6378137.25, 0.5, 0.75]], attributes } = {}) {
  const ecef = new Float64Array(points.flat());
  const pointCount = points.length;
  return createExperimentalETilePointView({
    pointCount,
    ecef,
    height: new Float64Array(pointCount),
    ...(attributes === undefined ? {} : { attributes }),
  }, context, { sourceIdentity: context.sourceIdentity, transformGeneration: context.transformGeneration },
  attributes === undefined ? {} : { attributes: {
    ...(attributes.red === undefined ? {} : { rgb: true }),
    ...(attributes.intensity === undefined ? {} : { intensity: true }),
    ...(attributes.classification === undefined ? {} : { classification: true }),
    ...(attributes.extraDimensions === undefined ? {} : { extraDimensions: Object.keys(attributes.extraDimensions) }),
  } });
}

function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  const jsonStart = 20;
  const jsonBytes = bytes.subarray(jsonStart, jsonStart + jsonLength);
  const json = JSON.parse(new TextDecoder().decode(jsonBytes).trimEnd());
  const binaryHeader = jsonStart + jsonLength;
  const binaryLength = view.getUint32(binaryHeader, true);
  assert.equal(view.getUint32(binaryHeader + 4, true), 0x004e4942);
  const binaryStart = binaryHeader + 8;
  assert.equal(binaryStart + binaryLength, bytes.byteLength);
  return { json, view, binaryStart, binaryLength };
}

function assertEncodingError(code, action) {
  assert.throws(action, (error) => error instanceof GlbEncodingError && error.code === code);
}

test('writes a deterministic glTF 2.0 POINTS GLB with aligned chunks and correct accessors', async () => {
  const points = [[6378137, -10, 20], [6378137.25, -9.5, 21]];
  const input = pointView({ points });
  const encoded = encodePointCloudGlb(input);
  assert.ok(encoded);
  assert.equal(encoded.mimeType, 'model/gltf-binary');
  assert.equal(encoded.pointCount, 2);
  assert.equal(encoded.hasColor, false);

  const { json, binaryStart } = parseGlb(encoded.bytes);
  assert.deepEqual(json.asset, { version: '2.0', generator: '@frillab/copc-tiles' });
  assert.equal(json.meshes[0].primitives[0].mode, 0);
  assert.deepEqual(json.meshes[0].primitives[0].attributes, { POSITION: 0 });
  assert.equal(json.accessors[0].componentType, 5126);
  assert.equal(json.accessors[0].count, 2);
  assert.equal(json.accessors[0].type, 'VEC3');
  assert.deepEqual(json.nodes, [{ mesh: 0 }]);
  assert.equal(Object.hasOwn(json.nodes[0], 'matrix'), false);
  assert.equal(json.bufferViews[0].byteOffset % 4, 0);
  assert.equal(json.buffers[0].byteLength, 24);
  assert.equal(binaryStart % 4, 0);
  assert.equal(encoded.bytes.byteLength % 4, 0);

  const firstPosition = Array.from({ length: 3 }, (_, axis) => new DataView(encoded.bytes.buffer).getFloat32(binaryStart + axis * 4, true));
  assert.ok(firstPosition.every(Number.isFinite));
  assert.deepEqual(encoded.bytes, encodePointCloudGlb(pointView({ points })).bytes);
});

test('pads a supported source-cell bound by the GLB encoder measured Float32 reconstruction error', () => {
  const points = [
    [6_378_137.123456789, -40.123456789, 20.7654321],
    [6_378_137.987654321, 40.987654321, 21.2345679],
  ];
  const encoded = encodePointCloudGlb(pointView({ points }));
  assert.ok(encoded);
  const conservative = {
    nodeKey: 'geographic-fixture',
    sourceCellBounds: { minX: -0.001, minY: -0.001, minZ: 0, maxX: 0.001, maxY: 0.001, maxZ: 30 },
    sourceCoordinateSystem: 'copc-source',
    sourceIdentity: 'fixture-source',
    sourceGeneration: 1,
    transformGeneration: 1,
    transformPlanIdentity: 'fixture-plan',
    heightOffsetMeters: 0,
    status: 'supported',
    boundsEcef: {
      coordinateSystem: 'wgs84-ecef-meters',
      minX: 6_378_130, minY: -50, minZ: 0,
      maxX: 6_378_150, maxY: 50, maxZ: 30,
    },
    coverage: 'full-source-cell-and-descendant-cells',
    method: 'wgs84-geodetic-interval-v1',
    verification: 'analytic-interval',
    verticalReference: 'ellipsoidal',
    sourceVerticalUnitToMeters: 1,
    encoderErrorPaddingRequired: true,
    assumptions: ['fixture'],
  };
  const padded = createPaddedEcefBoundsFromConservativeResult(conservative, encoded.maxAbsoluteErrorMeters);
  assert.ok(encoded.maxAbsoluteErrorMeters > 0);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.equal(padded.minimum[axis], conservative.boundsEcef[['minX', 'minY', 'minZ'][axis]] - encoded.maxAbsoluteErrorMeters);
    assert.equal(padded.maximum[axis], conservative.boundsEcef[['maxX', 'maxY', 'maxZ'][axis]] + encoded.maxAbsoluteErrorMeters);
  }

  const { json, view, binaryStart } = parseGlb(encoded.bytes);
  const positions = json.accessors[0];
  const byteOffset = json.bufferViews[positions.bufferView].byteOffset + positions.byteOffset;
  for (let point = 0; point < points.length; point += 1) {
    const offset = binaryStart + byteOffset + point * 12;
    const local = [
      view.getFloat32(offset, true),
      -view.getFloat32(offset + 8, true),
      view.getFloat32(offset + 4, true),
    ];
    const reconstructed = local.map((component, axis) => encoded.originEcef[axis] + component);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(reconstructed[axis] >= padded.minimum[axis]);
      assert.ok(reconstructed[axis] <= padded.maximum[axis]);
      assert.ok(Math.abs(reconstructed[axis] - points[point][axis]) <= encoded.maxAbsoluteErrorMeters);
    }
  }
});

test('rejects malformed conservative ECEF bounds before they become Tileset volumes', () => {
  const malformed = {
    nodeKey: 'invalid-bound',
    status: 'supported',
    encoderErrorPaddingRequired: true,
    boundsEcef: {
      coordinateSystem: 'wgs84-ecef-meters',
      minX: 10, minY: 0, minZ: 0,
      maxX: 1, maxY: 1, maxZ: 1,
    },
  };
  assert.throws(
    () => createPaddedEcefBoundsFromConservativeResult(malformed, 0.01),
    (error) => error.code === 'INVALID_BOUNDS',
  );
});

test('preserves full Uint16 LAS RGB as normalized COLOR_0 without narrowing', async () => {
  const rgb = {
    red: new Uint16Array([0, 65535]),
    green: new Uint16Array([257, 32768]),
    blue: new Uint16Array([65535, 1]),
  };
  const encoded = encodePointCloudGlb(pointView({ attributes: rgb }));
  assert.ok(encoded?.hasColor);
  const { json, view, binaryStart } = parseGlb(encoded.bytes);
  assert.deepEqual(json.meshes[0].primitives[0].attributes, { POSITION: 0, COLOR_0: 1 });
  assert.equal(json.accessors[1].componentType, 5123);
  assert.equal(json.accessors[1].normalized, true);
  assert.equal(json.accessors[1].count, 2);
  assert.equal(json.bufferViews[1].byteOffset, 24);
  assert.equal(json.bufferViews[1].byteLength, 16);
  assert.equal(json.bufferViews[1].byteStride, 8);
  const colorOffset = binaryStart + json.bufferViews[1].byteOffset;
  assert.deepEqual([
    view.getUint16(colorOffset, true),
    view.getUint16(colorOffset + 2, true),
    view.getUint16(colorOffset + 4, true),
    view.getUint16(colorOffset + 8, true),
    view.getUint16(colorOffset + 10, true),
    view.getUint16(colorOffset + 12, true),
  ], [0, 257, 65535, 65535, 32768, 1]);
  assert.equal(json.buffers[0].byteLength, 40);
  assert.equal(json.accessors[1].min, undefined);
  assert.equal(json.accessors[1].max, undefined);
});

test('omits empty-node content and does not write a zero-count accessor', () => {
  assert.equal(encodePointCloudGlb(pointView({ points: [] })), null);
});

test('stores LAS inspection fields and wide extra dimensions in indexed structural metadata', () => {
  const attributes = {
    red: new Uint16Array([0, 65535]),
    green: new Uint16Array([3, 32768]),
    blue: new Uint16Array([65535, 1]),
    intensity: new Uint16Array([1, 65535]),
    classification: new Uint8Array([2, 255]),
    extraDimensions: {
      scan_angle: new Float64Array([1.25, -12.5]),
      signed64: new BigInt64Array([-1n, 9_007_199_254_740_993n]),
      unsigned64: new BigUint64Array([0n, (1n << 64n) - 1n]),
      '온도 ℃': new Float64Array([18.5, -4.25]),
    },
  };
  const encoded = encodePointCloudGlb(pointView({ attributes }));
  assert.ok(encoded);
  assert.deepEqual(encoded.metadataProperties, ['intensity', 'classification', 'scan_angle', 'signed64', 'unsigned64', '온도 ℃']);
  const { json, view, binaryStart } = parseGlb(encoded.bytes);
  assert.deepEqual(json.extensionsUsed, ['EXT_mesh_features', 'EXT_structural_metadata']);
  const primitive = json.meshes[0].primitives[0];
  assert.deepEqual(primitive.extensions.EXT_mesh_features.featureIds, [{ featureCount: 2, propertyTable: 0 }]);
  assert.equal(primitive.attributes._FEATURE_ID_0, undefined);
  const structural = json.extensions.EXT_structural_metadata;
  const pointClass = structural.schema.classes.point;
  const table = structural.propertyTables[0];
  assert.equal(table.count, 2);
  assert.equal(table.class, 'point');

  const propertyId = (name) => Object.keys(pointClass.properties).find((id) => pointClass.properties[id].name === name);
  const readProperty = (name, type) => {
    const id = propertyId(name);
    assert.ok(id);
    const schema = pointClass.properties[id];
    const storage = table.properties[id];
    assert.equal(schema.componentType, type);
    const bufferView = json.bufferViews[storage.values];
    const offset = binaryStart + bufferView.byteOffset;
    return [0, 1].map((index) => {
      const byteOffset = offset + index * ({ UINT8: 1, UINT16: 2, FLOAT64: 8, INT64: 8, UINT64: 8 }[type]);
      if (type === 'UINT8') return view.getUint8(byteOffset);
      if (type === 'UINT16') return view.getUint16(byteOffset, true);
      if (type === 'FLOAT64') return view.getFloat64(byteOffset, true);
      if (type === 'INT64') return view.getBigInt64(byteOffset, true);
      return view.getBigUint64(byteOffset, true);
    });
  };
  assert.deepEqual(readProperty('intensity', 'UINT16'), [1, 65535]);
  assert.deepEqual(readProperty('classification', 'UINT8'), [2, 255]);
  assert.deepEqual(readProperty('scan_angle', 'FLOAT64'), [1.25, -12.5]);
  assert.deepEqual(readProperty('signed64', 'INT64'), [-1n, 9_007_199_254_740_993n]);
  assert.deepEqual(readProperty('unsigned64', 'UINT64'), [0n, (1n << 64n) - 1n]);
  assert.deepEqual(readProperty('온도 ℃', 'FLOAT64'), [18.5, -4.25]);
  assert.ok(json.bufferViews.slice(2).every((bufferView) => bufferView.byteOffset % 4 === 0));
  assert.equal(encoded.bytes.byteLength % 4, 0);
});

test('reports unsupported metadata values and enforces the metadata property budget', () => {
  const invalidFloat = pointView({ attributes: { extraDimensions: { invalid: new Float64Array([Number.NaN, 1]) } } });
  assertEncodingError('UNSUPPORTED_METADATA', () => encodePointCloudGlb(invalidFloat));
  const longName = 'x'.repeat(129);
  const invalidName = pointView({ attributes: { extraDimensions: { [longName]: new Float64Array([1, 2]) } } });
  assertEncodingError('UNSUPPORTED_METADATA', () => encodePointCloudGlb(invalidName));
  const tooMany = pointView({ attributes: {
    intensity: new Uint16Array([1, 2]),
    classification: new Uint8Array([2, 3]),
  } });
  assertEncodingError('ATTRIBUTE_LIMIT', () => encodePointCloudGlb(tooMany, { maxMetadataProperties: 1 }));
});

test('fails on malformed RGB, excessive point counts, and output sizes', () => {
  const partialRgb = pointView();
  const malformed = { ...partialRgb, attributes: { red: new Uint16Array([1, 2]) } };
  assertEncodingError('INVALID_INPUT', () => encodePointCloudGlb(malformed));
  assertEncodingError('POINT_LIMIT', () => encodePointCloudGlb(pointView(), { maxPoints: 1 }));
  assertEncodingError('OUTPUT_LIMIT', () => encodePointCloudGlb(pointView(), { maxOutputBytes: 32 }));
});

test('generated GLBs pass the official Khronos glTF Validator', async () => {
  const fixtures = [
    encodePointCloudGlb(pointView()),
    encodePointCloudGlb(pointView({ attributes: {
      red: new Uint16Array([0, 65535]),
      green: new Uint16Array([1, 32768]),
      blue: new Uint16Array([65535, 0]),
    } })),
    encodePointCloudGlb(pointView({ attributes: {
      intensity: new Uint16Array([25, 65535]),
      classification: new Uint8Array([2, 17]),
      extraDimensions: { precise: new Float64Array([1.25, 9_007_199_254_740_992]) },
    } })),
  ];
  for (const fixture of fixtures) {
    assert.ok(fixture);
    const report = await validator.validateBytes(new Uint8Array(fixture.bytes), { uri: 'point-cloud.glb' });
    assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
    assert.equal(report.issues.numWarnings, 0, JSON.stringify(report.issues.messages));
  }
});

test('CesiumGS 3D Tiles Validator validates structural metadata and per-point feature lookup', async () => {
  const fixture = encodePointCloudGlb(pointView({ attributes: {
    intensity: new Uint16Array([12, 65535]),
    classification: new Uint8Array([2, 18]),
    extraDimensions: {
      elevationOffset: new Float64Array([0.125, -0.25]),
      exactSigned: new BigInt64Array([-5n, 9_007_199_254_740_993n]),
      exactUnsigned: new BigUint64Array([3n, (1n << 64n) - 1n]),
    },
  } }));
  assert.ok(fixture);
  const directory = await mkdtemp(join(tmpdir(), 'copc-tiles-t7-'));
  try {
    await writeFile(join(directory, 'tileset.json'), JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 0,
      root: {
        boundingVolume: { box: [0, 0, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri: 'points.glb' },
      },
    }));
    await writeFile(join(directory, 'points.glb'), fixture.bytes);
    const report = await tilesValidator.Validators.validateTilesetFile(join(directory, 'tileset.json'));
    const errors = report.issues.filter((issue) => issue.severity === 'ERROR');
    const warnings = report.issues.filter((issue) => issue.severity === 'WARNING');
    assert.deepEqual(errors, [], report.serialize());
    assert.deepEqual(warnings, [], report.serialize());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
