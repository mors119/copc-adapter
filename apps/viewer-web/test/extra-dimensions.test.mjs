import test from 'node:test';
import assert from 'node:assert/strict';

import { getCopcPointFieldSelection } from '../src/index.ts';
import { toCopcPointView } from '../src/copc/backend/copcJsBackend.ts';
import { createExtraDimensionReaders } from '../src/copc/points/extraDimensions.ts';
import { inspectCopcPoint } from '../src/copc/points/pointInspection.ts';
import { validateCopcPointBuffer } from '../src/copc/points/loadPointData.ts';
import { createPreparedPointData } from '../src/point/preparedPoint.ts';
import { estimateDecodedCpuPointBufferBytes } from '../src/viewer/streaming/createNodePointCache.ts';
import { decodeCopcPointBuffer } from '../src/wasm/copcDecoder.ts';

// LAS point data record format 7: 36 base bytes, then 8 + 8 + 4 extra bytes.
const RECORD_LENGTH = 36 + 8 + 8 + 4;
const MISSION_OFFSET = 36;
const SIGNED_OFFSET = 44;
const FLOAT_OFFSET = 52;
const LARGE_ID = 10650350042228091829n; // above Number.MAX_SAFE_INTEGER

const EXTRA_BYTES = [
  { name: 'mission_id', type: 'unsigned', length: 8 },
  { name: 'signed_id', type: 'signed', length: 8 },
  { name: 'ce', type: 'float', length: 4 },
];

function createRawPoints() {
  const data = new Uint8Array(RECORD_LENGTH * 2);
  const view = new DataView(data.buffer);
  view.setBigUint64(MISSION_OFFSET, LARGE_ID, true);
  view.setBigInt64(SIGNED_OFFSET, -42n, true);
  view.setFloat32(FLOAT_OFFSET, 1.5, true);
  view.setBigUint64(RECORD_LENGTH + MISSION_OFFSET, 7n, true);
  view.setBigInt64(RECORD_LENGTH + SIGNED_OFFSET, 9n, true);
  view.setFloat32(RECORD_LENGTH + FLOAT_OFFSET, 2.5, true);

  return {
    data,
    header: { pointDataRecordFormat: 7, pointDataRecordLength: RECORD_LENGTH },
    extraBytes: EXTRA_BYTES,
  };
}

// Mirrors copc.js, whose 64-bit integer getters throw above Number.MAX_SAFE_INTEGER.
function createSourceView(raw = createRawPoints()) {
  const dataView = new DataView(raw.data.buffer);
  const numbers = {
    ce: (index) => dataView.getFloat32(index * RECORD_LENGTH + FLOAT_OFFSET, true),
    mission_id: (index) => {
      const value = dataView.getBigUint64(index * RECORD_LENGTH + MISSION_OFFSET, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`Cannot convert bigint to number: ${value}`);
      }
      return Number(value);
    },
    signed_id: (index) => Number(
      dataView.getBigInt64(index * RECORD_LENGTH + SIGNED_OFFSET, true),
    ),
    X: (index) => index,
    Y: (index) => index,
    Z: (index) => index,
  };

  return {
    pointCount: 2,
    dimensions: Object.fromEntries(Object.keys(numbers).map((name) => [name, {}])),
    getter(name) {
      return numbers[name];
    },
  };
}

test('64-bit integer extra dimensions are read exactly instead of through the throwing getter', () => {
  const readers = createExtraDimensionReaders(
    createSourceView(),
    ['mission_id', 'signed_id', 'ce'],
    createRawPoints(),
  );

  assert.deepEqual([...readers.keys()], ['mission_id', 'signed_id', 'ce']);
  assert.equal(readers.get('mission_id').valueType, 'uint64');
  assert.equal(readers.get('mission_id').read(0), LARGE_ID);
  assert.equal(readers.get('mission_id').read(1), 7n);
  assert.equal(readers.get('signed_id').valueType, 'int64');
  assert.equal(readers.get('signed_id').read(0), -42n);
  assert.equal(readers.get('ce').valueType, 'float64');
  assert.equal(readers.get('ce').read(1), 2.5);
});

test("'*' selects only dimensions outside the standard LAS point record", () => {
  const readers = createExtraDimensionReaders(createSourceView(), '*', createRawPoints());

  assert.deepEqual([...readers.keys()].sort(), ['ce', 'mission_id', 'signed_id']);
});

test('requested names missing from the schema are skipped and duplicates collapse', () => {
  const readers = createExtraDimensionReaders(
    createSourceView(),
    ['ce', 'not_in_schema', 'ce'],
    createRawPoints(),
  );

  assert.deepEqual([...readers.keys()], ['ce']);
});

test('64-bit integers that are scaled, or lack decoded records, use the numeric getter', () => {
  const scaled = {
    ...createRawPoints(),
    extraBytes: [{ name: 'signed_id', type: 'signed', length: 8, scale: 2 }],
  };
  assert.equal(
    createExtraDimensionReaders(createSourceView(), ['signed_id'], scaled)
      .get('signed_id').valueType,
    'float64',
  );

  const unsupportedFormat = { ...createRawPoints(), header: { pointDataRecordFormat: 5, pointDataRecordLength: RECORD_LENGTH } };
  assert.equal(
    createExtraDimensionReaders(createSourceView(), ['signed_id'], unsupportedFormat)
      .get('signed_id').valueType,
    'float64',
  );

  assert.equal(
    createExtraDimensionReaders(createSourceView(), ['signed_id']).get('signed_id').valueType,
    'float64',
  );
});

test('point views expose extra dimensions only when some were read', () => {
  const sourceView = createSourceView();
  const readers = createExtraDimensionReaders(sourceView, ['ce'], createRawPoints());

  const withExtra = toCopcPointView(sourceView, getCopcPointFieldSelection('fixed'), readers);
  assert.equal(withExtra.extraDimensions, readers);

  assert.equal(
    toCopcPointView(sourceView, getCopcPointFieldSelection('fixed')).extraDimensions,
    undefined,
  );
  assert.equal(
    toCopcPointView(sourceView, getCopcPointFieldSelection('fixed'), new Map()).extraDimensions,
    undefined,
  );
});

test('decodeCopcPointBuffer copies extra dimensions into typed arrays that match the reader type', async () => {
  const sourceView = createSourceView();
  const readers = createExtraDimensionReaders(
    sourceView,
    ['mission_id', 'signed_id', 'ce'],
    createRawPoints(),
  );
  const buffer = await decodeCopcPointBuffer(
    toCopcPointView(sourceView, getCopcPointFieldSelection('fixed'), readers),
  );

  const { extraDimensions } = buffer.attributes;
  assert.ok(extraDimensions.mission_id instanceof BigUint64Array);
  assert.deepEqual([...extraDimensions.mission_id], [LARGE_ID, 7n]);
  assert.ok(extraDimensions.signed_id instanceof BigInt64Array);
  assert.deepEqual([...extraDimensions.signed_id], [-42n, 9n]);
  assert.ok(extraDimensions.ce instanceof Float64Array);
  assert.deepEqual([...extraDimensions.ce], [1.5, 2.5]);
  assert.doesNotThrow(() => validateCopcPointBuffer(buffer));
});

test('dimension names that match object prototype properties remain own data fields', async () => {
  const sourceView = createSourceView();
  const readers = new Map([
    ['__proto__', { valueType: 'float64', read: () => 42 }],
  ]);
  const buffer = await decodeCopcPointBuffer(
    toCopcPointView(sourceView, getCopcPointFieldSelection('fixed'), readers),
  );
  const dimensions = buffer.attributes.extraDimensions;

  assert.equal(Object.getPrototypeOf(dimensions), Object.prototype);
  assert.equal(Object.hasOwn(dimensions, '__proto__'), true);
  assert.deepEqual([...dimensions['__proto__']], [42, 42]);
});

test('point inspection reports requested extra dimensions for the picked point', () => {
  const points = {
    pointCount: 2,
    coordinates: new Float64Array([10, 20, 30, 11, 21, 31]),
    attributes: {
      extraDimensions: {
        leg_id: new BigUint64Array([LARGE_ID, 7n]),
        ce: new Float64Array([1.5, 2.5]),
      },
    },
  };

  const inspection = inspectCopcPoint({ nodeKey: '0-0-0-0', pointIndex: 0 }, { level: 0 }, points, 'copc-js');
  assert.deepEqual(inspection.dimensions, { leg_id: LARGE_ID, ce: 1.5 });

  const withoutExtra = inspectCopcPoint(
    { nodeKey: '0-0-0-0', pointIndex: 1 },
    { level: 0 },
    { ...points, attributes: { intensity: new Uint16Array([1, 2]) } },
    'copc-js',
  );
  assert.equal(withoutExtra.dimensions, undefined);
});

test('point inspection preserves an extra dimension named __proto__', () => {
  const extraDimensions = Object.fromEntries([
    ['__proto__', new BigUint64Array([7n])],
  ]);
  const points = {
    pointCount: 1,
    coordinates: new Float64Array([10, 20, 30]),
    attributes: { extraDimensions },
  };

  const inspection = inspectCopcPoint(
    { nodeKey: '0-0-0-0', pointIndex: 0 },
    { level: 0 },
    points,
    'copc-js',
  );

  assert.equal(Object.getPrototypeOf(inspection.dimensions), Object.prototype);
  assert.equal(Object.hasOwn(inspection.dimensions, '__proto__'), true);
  assert.equal(inspection.dimensions['__proto__'], 7n);
});

test('point buffer validation rejects extra dimensions that do not match the point count', () => {
  assert.throws(
    () => validateCopcPointBuffer({
      pointCount: 2,
      coordinates: new Float64Array(6),
      attributes: { extraDimensions: { leg_id: new BigUint64Array(1) } },
    }),
    /extra dimension length mismatch: leg_id/,
  );
});

test('prepared point data keeps extra dimensions and rejects mismatched lengths', () => {
  const input = {
    pointCount: 2,
    sourceCoordinates: new Float64Array(6),
    geographicCoordinates: new Float64Array(6),
    worldCoordinates: new Float64Array(6),
  };
  const extraDimensions = { leg_id: new BigUint64Array([LARGE_ID, 7n]) };

  assert.equal(
    createPreparedPointData({ ...input, attributes: { extraDimensions } })
      .attributes.extraDimensions,
    extraDimensions,
  );
  assert.throws(
    () => createPreparedPointData({
      ...input,
      attributes: { extraDimensions: { leg_id: new BigUint64Array(3) } },
    }),
    /extra dimension leg_id attribute length must match point count/,
  );
});

test('cache byte estimates include extra dimension storage', () => {
  assert.equal(
    estimateDecodedCpuPointBufferBytes({
      attributes: {
        extraDimensions: {
          leg_id: new BigUint64Array(4),
          ce: new Float64Array(4),
        },
      },
    }),
    64,
  );
});
