import type {
  CopcPointAttributes,
  GeographicPointBuffer,
  PreparedPointData,
  PreparedPointStatistics,
} from '../copc/types/copc';
import type { CoordinateBuffer } from '../coordinates/types';

type PreparedPointDataInput = {
  pointCount: number;
  sourceCoordinates: Float64Array;
  geographicCoordinates: Float64Array;
  worldCoordinates: Float64Array;
  attributes?: CopcPointAttributes;
  statistics?: PreparedPointStatistics;
};

function assertPointCount(pointCount: number): void {
  if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
    throw new RangeError('Prepared point data requires a non-negative safe point count');
  }
}

function assertCoordinateBufferShape(
  coordinates: Float64Array,
  pointCount: number,
  label: string,
): void {
  if (!(coordinates instanceof Float64Array)) {
    throw new TypeError(`Prepared ${label} coordinates must be a Float64Array`);
  }
  if (coordinates.length !== pointCount * 3) {
    throw new RangeError(`Prepared ${label} coordinates must contain three values per point`);
  }
}

function assertCoordinateBuffer(
  coordinates: Float64Array,
  pointCount: number,
  label: string,
): void {
  assertCoordinateBufferShape(coordinates, pointCount, label);
  for (const value of coordinates) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Prepared ${label} coordinates must be finite`);
    }
  }
}

function coordinateBuffer<System extends CoordinateBuffer['coordinateSystem']>(
  coordinateSystem: System,
  pointCount: number,
  coordinates: Float64Array,
): CoordinateBuffer<System> {
  return { coordinateSystem, pointCount, coordinates };
}

function range(
  values: ArrayLike<number> | undefined,
  pointCount: number,
  stride = 1,
  start = 0,
): { min: number; max: number } | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const available = values.length > start
    ? Math.floor((values.length - 1 - start) / stride) + 1
    : 0;
  const length = Math.min(pointCount, available);
  for (let index = 0; index < length; index += 1) {
    const value = values[start + (index * stride)];
    if (Number.isFinite(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}

function rgbMax(attributes: CopcPointAttributes | undefined, pointCount: number): 255 | 65535 | undefined {
  const red = attributes?.red;
  const green = attributes?.green;
  const blue = attributes?.blue;
  if (!red || !green || !blue) {
    return undefined;
  }

  const length = Math.min(pointCount, red.length, green.length, blue.length);
  let max = 0;
  for (let index = 0; index < length; index += 1) {
    max = Math.max(max, red[index], green[index], blue[index]);
  }
  return max <= 255 ? 255 : 65535;
}

function prepareStatistics(
  geographicCoordinates: Float64Array,
  attributes: CopcPointAttributes | undefined,
  pointCount: number,
): PreparedPointStatistics {
  return {
    elevation: range(geographicCoordinates, pointCount, 3, 2),
    intensity: range(attributes?.intensity, pointCount),
    rgbMax: rgbMax(attributes, pointCount),
  };
}

function assertAttributeLength(
  values: ArrayLike<number> | undefined,
  pointCount: number,
  label: string,
): void {
  if (values !== undefined && values.length !== pointCount) {
    throw new RangeError(`Prepared ${label} attribute length must match point count`);
  }
}

/**
 * Create the shared prepared result from buffers owned by TypeScript.
 *
 * The function deliberately does not retain a view into WASM memory. Rust
 * decoders must copy out of linear memory before calling this boundary, and
 * Worker results must arrive as transferred ArrayBuffers. The returned object
 * owns the typed arrays for the lifetime of the cache entry; renderers only
 * read them and may create their own derived GPU buffers.
 */
export function createPreparedPointData(input: PreparedPointDataInput): PreparedPointData {
  assertPointCount(input.pointCount);
  assertCoordinateBuffer(input.sourceCoordinates, input.pointCount, 'source');
  assertCoordinateBuffer(input.geographicCoordinates, input.pointCount, 'geographic');
  assertCoordinateBuffer(input.worldCoordinates, input.pointCount, 'world');

  const attributes = input.attributes;
  assertAttributeLength(attributes?.intensity, input.pointCount, 'intensity');
  assertAttributeLength(attributes?.classification, input.pointCount, 'classification');
  assertAttributeLength(attributes?.red, input.pointCount, 'red');
  assertAttributeLength(attributes?.green, input.pointCount, 'green');
  assertAttributeLength(attributes?.blue, input.pointCount, 'blue');

  const source = coordinateBuffer('copc-source', input.pointCount, input.sourceCoordinates);
  const geographic = coordinateBuffer(
    'wgs84-geographic',
    input.pointCount,
    input.geographicCoordinates,
  );
  const world = coordinateBuffer(
    'wgs84-ecef-meters',
    input.pointCount,
    input.worldCoordinates,
  );

  return {
    pointCount: input.pointCount,
    source,
    geographic,
    world,
    attributes,
    statistics: input.statistics
      ?? prepareStatistics(input.geographicCoordinates, attributes, input.pointCount),
    // Compatibility aliases intentionally share storage with the named buffers.
    coordinates: geographic.coordinates,
    coordinateSystem: geographic.coordinateSystem,
    sourceCoordinates: source.coordinates,
    sourceCoordinateSystem: source.coordinateSystem,
    worldCoordinates: world.coordinates,
    worldCoordinateSystem: world.coordinateSystem,
  };
}

/** Validate the stable contract at an internal cache/worker boundary. */
export function assertPreparedPointData(value: PreparedPointData): void {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Prepared point data must be an object');
  }
  if (!value.source || !value.geographic || !value.world) {
    throw new TypeError('Prepared point data must contain all coordinate buffers');
  }
  if (value.source.coordinateSystem !== 'copc-source'
    || value.geographic.coordinateSystem !== 'wgs84-geographic'
    || value.world.coordinateSystem !== 'wgs84-ecef-meters') {
    throw new TypeError('Prepared point data has an invalid coordinate-system tag');
  }
  if (value.source.pointCount !== value.pointCount
    || value.geographic.pointCount !== value.pointCount
    || value.world.pointCount !== value.pointCount
    || value.coordinateSystem !== 'wgs84-geographic'
    || value.sourceCoordinateSystem !== 'copc-source'
    || value.worldCoordinateSystem !== 'wgs84-ecef-meters') {
    throw new TypeError('Prepared point data has inconsistent coordinate metadata');
  }
  if (value.coordinates !== value.geographic.coordinates
    || value.sourceCoordinates !== value.source.coordinates
    || value.worldCoordinates !== value.world.coordinates) {
    throw new TypeError('Prepared compatibility aliases must share typed-array storage');
  }
  assertPointCount(value.pointCount);
  assertCoordinateBufferShape(value.source.coordinates, value.pointCount, 'source');
  assertCoordinateBufferShape(value.geographic.coordinates, value.pointCount, 'geographic');
  assertCoordinateBufferShape(value.world.coordinates, value.pointCount, 'world');
  assertAttributeLength(value.attributes?.intensity, value.pointCount, 'intensity');
  assertAttributeLength(value.attributes?.classification, value.pointCount, 'classification');
  assertAttributeLength(value.attributes?.red, value.pointCount, 'red');
  assertAttributeLength(value.attributes?.green, value.pointCount, 'green');
  assertAttributeLength(value.attributes?.blue, value.pointCount, 'blue');
}

/** Return the legacy flat buffer without copying any prepared typed array. */
export function preparedPointDataToGeographicBuffer(
  value: PreparedPointData,
): GeographicPointBuffer {
  assertPreparedPointData(value);
  return {
    pointCount: value.pointCount,
    coordinates: value.geographic.coordinates,
    coordinateSystem: value.geographic.coordinateSystem,
    sourceCoordinates: value.source.coordinates,
    sourceCoordinateSystem: value.source.coordinateSystem,
    worldCoordinates: value.world.coordinates,
    worldCoordinateSystem: value.world.coordinateSystem,
    attributes: value.attributes,
    statistics: value.statistics,
  };
}
