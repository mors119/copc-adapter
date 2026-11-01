import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createExperimentalETilePointView,
  createTilePointViewFromA,
  TilePointViewError,
} from '../src/input/tilePointView.ts';

const context = (overrides = {}) => ({
  sourceIdentity: 'source-instance-1',
  nodeKey: 'node-key-1',
  transformGeneration: 7,
  sourceCrs: { status: 'unverified', identifier: 'EPSG:26910', horizontalUnit: 'metre', verticalUnit: 'metre' },
  verticalDatum: {
    status: 'unknown',
    corrections: [{ kind: 'manual-offset', offsetMeters: 0 }],
  },
  heightOffsetMeters: 0,
  ...overrides,
});

const expected = { sourceIdentity: 'source-instance-1', transformGeneration: 7 };

function preparedA() {
  const source = new Float64Array([1, 2, 3, 4, 5, 6]);
  const geographic = new Float64Array([10, 20, 30, 40, 50, 60]);
  const ecef = new Float64Array([100, 200, 300, 400, 500, 600]);
  const red = new Uint16Array([11, 22]);
  const green = new Uint16Array([33, 44]);
  const blue = new Uint16Array([55, 66]);
  const intensity = new Uint16Array([77, 88]);
  const classification = new Uint8Array([2, 6]);
  const extra = new BigInt64Array([9007199254740993n, -7n]);
  return {
    pointCount: 2,
    source: { coordinateSystem: 'copc-source', pointCount: 2, coordinates: source },
    geographic: { coordinateSystem: 'wgs84-geographic', pointCount: 2, coordinates: geographic },
    world: { coordinateSystem: 'wgs84-ecef-meters', pointCount: 2, coordinates: ecef },
    coordinates: geographic,
    sourceCoordinates: source,
    worldCoordinates: ecef,
    attributes: {
      red,
      green,
      blue,
      intensity,
      classification,
      extraDimensions: { returnNumber64: extra },
    },
  };
}

function experimentalE(overrides = {}) {
  return {
    pointCount: 2,
    ecef: new Float64Array([100, 200, 300, 400, 500, 600]),
    height: new Float64Array([12.25, -4.5]),
    source: new Float64Array([1, 2, 3, 4, 5, 6]),
    geographic: new Float64Array([10, 20, 30, 40, 50, 60]),
    attributes: { intensity: new Uint16Array([7, 8]) },
    ...overrides,
  };
}

function assertViewError(code, action) {
  assert.throws(action, (error) => error instanceof TilePointViewError && error.code === code);
}

test('A aliases the public ECEF and explicitly selected buffers without copying', () => {
  const input = preparedA();
  const view = createTilePointViewFromA(input, context(), expected, {
    coordinates: { source: true, geographic: true },
    attributes: {
      rgb: true,
      intensity: true,
      classification: true,
      extraDimensions: ['returnNumber64'],
    },
  });

  assert.equal(view.ecef, input.world.coordinates);
  assert.equal(view.source, input.source.coordinates);
  assert.equal(view.geographic, input.geographic.coordinates);
  assert.equal(view.attributes.red, input.attributes.red);
  assert.equal(view.attributes.green, input.attributes.green);
  assert.equal(view.attributes.blue, input.attributes.blue);
  assert.equal(view.attributes.intensity, input.attributes.intensity);
  assert.equal(view.attributes.classification, input.attributes.classification);
  assert.equal(view.attributes.extraDimensions.returnNumber64, input.attributes.extraDimensions.returnNumber64);
  assert.equal(view.preparedHeight, undefined);
  assert.equal(view.context.verticalDatum.status, 'unknown');
  assert.equal(Object.isFrozen(view), true);
});

test('A defaults to ECEF only and does not expose available but unrequested data', () => {
  const input = preparedA();
  const view = createTilePointViewFromA(input, context(), expected);
  assert.equal(view.ecef, input.world.coordinates);
  assert.equal(view.source, undefined);
  assert.equal(view.geographic, undefined);
  assert.equal(view.attributes, undefined);
});

test('A does not manufacture a contiguous height buffer', () => {
  assertViewError('MISSING_REQUESTED_FIELD', () => createTilePointViewFromA(
    preparedA(), context(), expected, { coordinates: { preparedHeight: true } },
  ));
});

test('experimental E aliases ECEF and height directly without reconstructing A data', () => {
  const input = experimentalE();
  const view = createExperimentalETilePointView(input, context(), expected, {
    coordinates: { preparedHeight: true, source: true, geographic: true },
    attributes: { intensity: true },
  });
  assert.equal(view.ecef, input.ecef);
  assert.equal(view.preparedHeight, input.height);
  assert.equal(view.source, input.source);
  assert.equal(view.geographic, input.geographic);
  assert.equal(view.attributes.intensity, input.attributes.intensity);
});

test('BigInt extra dimensions remain exact and keep their original typed array', () => {
  const input = preparedA();
  const values = input.attributes.extraDimensions.returnNumber64;
  const view = createTilePointViewFromA(input, context(), expected, {
    attributes: { extraDimensions: ['returnNumber64'] },
  });
  assert.equal(view.attributes.extraDimensions.returnNumber64, values);
  assert.equal(view.attributes.extraDimensions.returnNumber64[0], 9007199254740993n);
});

test('requested optional coordinates and attributes fail when unavailable', () => {
  assertViewError('MISSING_REQUESTED_FIELD', () => createExperimentalETilePointView(
    experimentalE({ source: undefined }), context(), expected, { coordinates: { source: true } },
  ));
  assertViewError('MISSING_REQUESTED_FIELD', () => createExperimentalETilePointView(
    experimentalE({ attributes: undefined }), context(), expected, { attributes: { intensity: true } },
  ));
  assertViewError('MISSING_REQUESTED_FIELD', () => createTilePointViewFromA(
    preparedA(), context(), expected, { attributes: { extraDimensions: ['missing'] } },
  ));
});

test('partial RGB, wrong lengths, and wrong typed-array classes fail closed', () => {
  const partialRgb = preparedA();
  delete partialRgb.attributes.blue;
  assertViewError('INVALID_ATTRIBUTE_DATA', () => createTilePointViewFromA(partialRgb, context(), expected));

  assertViewError('INVALID_BUFFER_LENGTH', () => createExperimentalETilePointView(
    experimentalE({ ecef: new Float64Array(5) }), context(), expected,
  ));
  const shortIntensity = preparedA();
  shortIntensity.attributes.intensity = new Uint16Array([1]);
  assertViewError('INVALID_BUFFER_LENGTH', () => createTilePointViewFromA(
    shortIntensity, context(), expected, { attributes: { intensity: true } },
  ));
  assertViewError('INVALID_ATTRIBUTE_DATA', () => createExperimentalETilePointView(
    experimentalE({ attributes: { intensity: new Float32Array([1, 2]) } }), context(), expected,
  ));
});

test('source changes and stale transform generations are rejected', () => {
  assertViewError('STALE_SOURCE', () => createExperimentalETilePointView(
    experimentalE(), context({ sourceIdentity: 'old-source' }), expected,
  ));
  assertViewError('STALE_GENERATION', () => createExperimentalETilePointView(
    experimentalE(), context({ transformGeneration: 6 }), expected,
  ));
});

test('rejects point views from a stale adapter source generation', () => {
  assertViewError('STALE_GENERATION', () => createExperimentalETilePointView(
    experimentalE(),
    context({ sourceGeneration: 3 }),
    { ...expected, sourceGeneration: 4 },
  ));
});

test('unsafe point counts and malformed field selections are rejected', () => {
  assertViewError('INVALID_POINT_COUNT', () => createExperimentalETilePointView(
    experimentalE({ pointCount: Number.MAX_SAFE_INTEGER }), context(), expected,
  ));
  assertViewError('INVALID_FIELD_SELECTION', () => createExperimentalETilePointView(
    experimentalE(), context(), expected, { attributes: { extraDimensions: ['intensity', 'intensity'] } },
  ));
});
