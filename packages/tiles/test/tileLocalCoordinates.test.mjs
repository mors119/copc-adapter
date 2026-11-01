import assert from 'node:assert/strict';
import test from 'node:test';
import { createExperimentalETilePointView } from '../src/input/tilePointView.ts';
import { createTileTranslationTransform, encodeTileLocalPositions, TilePrecisionError } from '../src/geometry/tileLocalCoordinates.ts';

const context = {
  sourceIdentity: 'precision-fixture',
  nodeKey: 'precision-node',
  transformGeneration: 2,
  sourceCrs: { status: 'unknown', reason: 'synthetic ECEF fixture' },
  verticalDatum: { status: 'unknown', corrections: [] },
  heightOffsetMeters: 0,
};

function view(ecef) {
  const pointCount = ecef.length / 3;
  return createExperimentalETilePointView({
    pointCount,
    ecef: new Float64Array(ecef),
    height: new Float64Array(pointCount),
  }, context, { sourceIdentity: context.sourceIdentity, transformGeneration: context.transformGeneration });
}

function decodeToEcef(result, point) {
  const index = point * 3;
  const gltf = result.positions;
  const ecefLocal = [gltf[index], -gltf[index + 2], gltf[index + 1]];
  return ecefLocal.map((value, axis) => value + result.originEcef[axis]);
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function geodeticToEcef(longitudeDegrees, latitudeDegrees, heightMeters) {
  const a = 6378137;
  const eccentricitySquared = 6.69437999014e-3;
  const longitude = longitudeDegrees * Math.PI / 180;
  const latitude = latitudeDegrees * Math.PI / 180;
  const sinLatitude = Math.sin(latitude);
  const primeVertical = a / Math.sqrt(1 - eccentricitySquared * sinLatitude ** 2);
  return [
    (primeVertical + heightMeters) * Math.cos(latitude) * Math.cos(longitude),
    (primeVertical + heightMeters) * Math.cos(latitude) * Math.sin(longitude),
    (primeVertical * (1 - eccentricitySquared) + heightMeters) * sinLatitude,
  ];
}

function maxWorldError(result, original) {
  let maximum = 0;
  for (let point = 0; point < original.length / 3; point += 1) {
    const actual = decodeToEcef(result, point);
    const index = point * 3;
    maximum = Math.max(maximum, Math.hypot(
      actual[0] - original[index],
      actual[1] - original[index + 1],
      actual[2] - original[index + 2],
    ));
  }
  return maximum;
}

function assertPrecisionError(code, action) {
  assert.throws(action, (error) => error instanceof TilePrecisionError && error.code === code);
}

test('encodes large ECEF values around a Float64 local origin without mutating source buffers', () => {
  const values = [
    6378137.0001, -1212345.1234, 4321000.9876,
    6378137.0251, -1212345.1034, 4321001.0076,
    6378136.9901, -1212345.1434, 4321000.9676,
  ];
  const input = view(values);
  const before = [...input.ecef];
  const result = encodeTileLocalPositions(input);
  assert.ok(result.originEcef instanceof Float64Array);
  assert.ok(result.positions instanceof Float32Array);
  assert.ok(result.maxAbsoluteErrorMeters <= 0.01);
  assert.ok(result.maxRelativeError <= 1e-7);
  assert.ok(maxWorldError(result, values) <= 0.01);
  assert.deepEqual([...input.ecef], before);
});

test('stores glTF Y-up components and restores ECEF axes through the standard 3D Tiles rotation', () => {
  const values = [6378137, -40, 90, 6378137.25, -39.75, 90.5];
  const result = encodeTileLocalPositions(view(values));
  for (let point = 0; point < 2; point += 1) {
    const reconstructed = decodeToEcef(result, point);
    assert.ok(Math.hypot(
      reconstructed[0] - values[point * 3],
      reconstructed[1] - values[point * 3 + 1],
      reconstructed[2] - values[point * 3 + 2],
    ) <= 0.01);
  }
  assert.deepEqual([...result.tileTransform.slice(12, 15)], [...result.originEcef]);
  assert.deepEqual([...result.tileTransform.slice(0, 12)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
});

test('keeps a child tile transform relative to its parent origin', () => {
  const localOrigin = new Float64Array([6378137, 200, 300]);
  const parentOrigin = new Float64Array([6378100, 150, 250]);
  const result = encodeTileLocalPositions(view([6378137, 200, 300]), {
    originEcef: localOrigin,
    parentOriginEcef: parentOrigin,
  });
  assert.deepEqual([...result.tileTransform.slice(12, 15)], [37, 50, 50]);
  assert.deepEqual([...localOrigin], [6378137, 200, 300]);
  assert.deepEqual([...parentOrigin], [6378100, 150, 250]);
});

test('composes parent, child, and glTF Y-up transforms into the original ECEF position', () => {
  const parentOrigin = new Float64Array([6378000, -1200000, 4300000]);
  const childOrigin = new Float64Array([6378137.125, -1199980.25, 4300012.5]);
  const reference = [6378137.3, -1199980.1, 4300012.8];
  const child = encodeTileLocalPositions(view(reference), {
    originEcef: childOrigin,
    parentOriginEcef: parentOrigin,
  });
  const parentTransform = createTileTranslationTransform(parentOrigin);
  const gltf = [child.positions[0], child.positions[1], child.positions[2]];
  const ecefLocalAfterYUpRotation = [gltf[0], -gltf[2], gltf[1]];
  const childWorld = transformPoint(child.tileTransform, ecefLocalAfterYUpRotation);
  const world = transformPoint(parentTransform, childWorld);
  const errorMeters = Math.hypot(...world.map((value, axis) => value - reference[axis]));
  assert.ok(errorMeters <= 0.01, `composed world-coordinate error was ${errorMeters} m`);
});

test('reconstructs a shared boundary point consistently from adjacent tile origins', () => {
  const shared = [6378137.125, -900, 400];
  const leftValues = [6378137.0, -900.2, 399.8, ...shared];
  const rightValues = [...shared, 6378137.4, -899.8, 400.2];
  const left = encodeTileLocalPositions(view(leftValues));
  const right = encodeTileLocalPositions(view(rightValues));
  const leftShared = decodeToEcef(left, 1);
  const rightShared = decodeToEcef(right, 0);
  assert.ok(Math.hypot(...leftShared.map((value, axis) => value - rightShared[axis])) <= 0.01);
  assert.ok(Math.hypot(...leftShared.map((value, axis) => value - shared[axis])) <= 0.01);
});

test('keeps near-pole, date-line, and high-altitude ECEF fixtures within the error budget', () => {
  const cases = [
    [geodeticToEcef(0, 90, 0), geodeticToEcef(180, 89.999999, 0.25)],
    [geodeticToEcef(179.999, 0, 50), geodeticToEcef(-179.999, 0.00001, 50.1)],
    [geodeticToEcef(12, 45, 100_000), geodeticToEcef(12.000001, 45.000001, 100_000.5)],
  ];
  for (const points of cases) {
    const values = points.flat();
    const result = encodeTileLocalPositions(view(values));
    assert.ok(result.maxAbsoluteErrorMeters <= 0.01);
    assert.ok(result.maxRelativeError <= 1e-7);
    assert.ok(maxWorldError(result, values) <= 0.01);
  }
});

test('fails closed when local Float32 precision exceeds either configured threshold', () => {
  assertPrecisionError('PRECISION_BUDGET_EXCEEDED', () => encodeTileLocalPositions(view([
    0, 0, 0,
    5_000_003.14159, 0.123456789, 0.7654321,
  ])));
  assertPrecisionError('PRECISION_BUDGET_EXCEEDED', () => encodeTileLocalPositions(view([
    6378137.123456789, 0, 0,
  ]), { originEcef: new Float64Array([6378137, 0, 0]), maxAbsoluteErrorMeters: 0 }));
});

test('rejects non-finite ECEF, malformed origins, and invalid error budgets', () => {
  assertPrecisionError('INVALID_ECEF', () => encodeTileLocalPositions(view([1, 2, Number.NaN])));
  assertPrecisionError('INVALID_ORIGIN', () => encodeTileLocalPositions(view([1, 2, 3]), { originEcef: new Float32Array(3) }));
  assertPrecisionError('INVALID_ERROR_BUDGET', () => encodeTileLocalPositions(view([1, 2, 3]), { maxRelativeError: -1 }));
});

test('returns valid empty coordinates without inventing positions', () => {
  const result = encodeTileLocalPositions(view([]));
  assert.equal(result.pointCount, 0);
  assert.equal(result.positions.length, 0);
  assert.deepEqual([...result.originEcef], [0, 0, 0]);
  assert.deepEqual([...result.positionMin], [0, 0, 0]);
  assert.deepEqual([...result.positionMax], [0, 0, 0]);
});
