export type TileExtraDimensionValues = Float64Array | BigInt64Array | BigUint64Array;

export type TilePointAttributes = Readonly<{
  red?: Uint16Array;
  green?: Uint16Array;
  blue?: Uint16Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  extraDimensions?: Readonly<Record<string, TileExtraDimensionValues>>;
}>;

type CoordinateBufferInput = Readonly<{
  coordinateSystem: string;
  pointCount: number;
  coordinates: Float64Array;
}>;

/** Structural view of the public A layout; it has no Adapter type dependency. */
export type PreparedPointDataAInput = Readonly<{
  pointCount: number;
  source: CoordinateBufferInput;
  geographic: CoordinateBufferInput;
  world: CoordinateBufferInput;
  coordinates: Float64Array;
  sourceCoordinates: Float64Array;
  worldCoordinates: Float64Array;
  attributes?: TilePointAttributes;
}>;

export type TileViewErrorCode =
  | 'INVALID_POINT_COUNT'
  | 'INVALID_BUFFER_TYPE'
  | 'INVALID_BUFFER_LENGTH'
  | 'INVALID_COORDINATE_SYSTEM'
  | 'INVALID_ATTRIBUTE_DATA'
  | 'INVALID_FIELD_SELECTION'
  | 'INVALID_PROVENANCE'
  | 'STALE_SOURCE'
  | 'STALE_GENERATION'
  | 'MISSING_REQUESTED_FIELD';

export class TilePointViewError extends Error {
  readonly code: TileViewErrorCode;
  readonly field: string | undefined;

  constructor(code: TileViewErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'TilePointViewError';
    this.code = code;
    this.field = field;
  }
}

export type TileSourceCrsEvidence = Readonly<{
  status: 'identified' | 'unverified' | 'unknown';
  identifier?: string;
  definition?: string;
  horizontalUnit?: string;
  verticalUnit?: string;
  reason?: string;
}>;

export type TileVerticalCorrection =
  | Readonly<{
      kind: 'manual-offset';
      offsetMeters: number;
      identifier?: string;
    }>
  | Readonly<{
      kind: 'validated-grid';
      identifier: string;
      version?: string;
    }>;

export type TileVerticalDatumEvidence = Readonly<{
  status: 'verified' | 'unverified' | 'unknown';
  identifier?: string;
  corrections: readonly TileVerticalCorrection[];
}>;

export type TileDecodedPointEcefBounds = Readonly<{
  coordinateSystem: 'wgs84-ecef-meters';
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}>;

export type TileTransformPlanProvenance = Readonly<{
  schema: 'copc-coordinate-transform-plan';
  version: 1;
  identity: Readonly<{ key: string }>;
  manualHeightOffsetMeters: number;
  [key: string]: unknown;
}>;

/** Node/source provenance is kept out of the point buffers. */
export type TileNodeContext = Readonly<{
  /** Opaque, stable identity for the source instance; do not use a signed URL. */
  sourceIdentity: string;
  /** Stable node key supplied by the node reader. */
  nodeKey: string;
  /** Adapter-assigned source lifetime generation when the source provides one. */
  sourceGeneration?: number;
  /** Generation of the source/coordinate preparation used for these buffers. */
  transformGeneration: number;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  /** Manual additive correction actually applied to prepared height, in metres. */
  heightOffsetMeters: number;
  /** Adapter's immutable transform plan, retained as provenance without interpretation. */
  transformPlan?: TileTransformPlanProvenance;
  /** Standard LAS fields actually available on the loaded node. */
  availableFields?: readonly string[];
  /** Named Extra Dimensions actually returned on the loaded node. */
  availableExtraDimensions?: readonly string[];
  /** Tight bound over this decoded node's transformed points only. */
  decodedPointEcefBounds?: TileDecodedPointEcefBounds;
  decodedPointEcefBoundsKind?: 'decoded-point-content';
}>;

export type TileViewExpectation = Readonly<{
  sourceIdentity: string;
  sourceGeneration?: number;
  transformGeneration: number;
}>;

export type TilePointFieldSelection = Readonly<{
  coordinates?: Readonly<{
    source?: boolean;
    geographic?: boolean;
    preparedHeight?: boolean;
  }>;
  attributes?: Readonly<{
    rgb?: boolean;
    intensity?: boolean;
    classification?: boolean;
    /** Extra-dimension names are matched exactly and are never normalized. */
    extraDimensions?: readonly string[];
  }>;
}>;

export type TileSelectedAttributes = Readonly<{
  red?: Uint16Array;
  green?: Uint16Array;
  blue?: Uint16Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  extraDimensions?: Readonly<Record<string, TileExtraDimensionValues>>;
}>;

/**
 * Internal renderer-neutral point view. Array properties are read-only by
 * ownership contract; consumers must not mutate the shared typed arrays.
 * Point identity is `(context.nodeKey, pointIndex)`.
 */
export type TilePointView = Readonly<{
  pointCount: number;
  /** Interleaved WGS84 ECEF XYZ in metres. Required by every producer. */
  ecef: Float64Array;
  /** Prepared Float64 display/ellipsoidal height when separately available. */
  preparedHeight?: Float64Array;
  /** Interleaved source-CRS XYZ, only when explicitly requested and retained. */
  source?: Float64Array;
  /** Interleaved WGS84 longitude/latitude/height, only when requested. */
  geographic?: Float64Array;
  /** Only requested fields are exposed. */
  attributes?: TileSelectedAttributes;
  context: TileNodeContext;
}>;

export type ExperimentalETileNodeInput = Readonly<{
  pointCount: number;
  /** Interleaved WGS84 ECEF XYZ in metres. */
  ecef: Float64Array;
  /** Prepared Float64 display/ellipsoidal height in metres. */
  height: Float64Array;
  /** Optional retained source-CRS XYZ; never reconstructed from ECEF. */
  source?: Float64Array;
  /** Optional retained WGS84 longitude/latitude/height; never reconstructed. */
  geographic?: Float64Array;
  attributes?: TilePointAttributes;
}>;

type NormalizedSelection = {
  source: boolean;
  geographic: boolean;
  preparedHeight: boolean;
  rgb: boolean;
  intensity: boolean;
  classification: boolean;
  extraDimensions: string[];
};

const EMPTY_SELECTION: TilePointFieldSelection = Object.freeze({});

/** Validate and snapshot a caller's selection before any asynchronous reads. */
export function snapshotTilePointFieldSelection(
  selection: TilePointFieldSelection = EMPTY_SELECTION,
): TilePointFieldSelection {
  const normalized = normalizeSelection(selection);
  const coordinates = Object.freeze({
    ...(normalized.source ? { source: true } : {}),
    ...(normalized.geographic ? { geographic: true } : {}),
    ...(normalized.preparedHeight ? { preparedHeight: true } : {}),
  });
  const attributes = Object.freeze({
    ...(normalized.rgb ? { rgb: true } : {}),
    ...(normalized.intensity ? { intensity: true } : {}),
    ...(normalized.classification ? { classification: true } : {}),
    ...(normalized.extraDimensions.length > 0
      ? { extraDimensions: Object.freeze([...normalized.extraDimensions]) }
      : {}),
  });
  return Object.freeze({ coordinates, attributes });
}

/** Create a zero-copy view over A-shaped prepared point data. */
export function createTilePointViewFromA(
  data: PreparedPointDataAInput,
  context: TileNodeContext,
  expected: TileViewExpectation,
  selection: TilePointFieldSelection = EMPTY_SELECTION,
): TilePointView {
  assertRecord(data, 'PreparedPointData');
  const pointCount = validatePointCount(data.pointCount);
  const ecef = requireCoordinateBuffer(data.world, pointCount, 'wgs84-ecef-meters', 'world.coordinates');
  const source = requireCoordinateBuffer(data.source, pointCount, 'copc-source', 'source.coordinates');
  const geographic = requireCoordinateBuffer(data.geographic, pointCount, 'wgs84-geographic', 'geographic.coordinates');

  if (
    data.worldCoordinates !== ecef ||
    data.sourceCoordinates !== source ||
    data.coordinates !== geographic
  ) {
    fail('INVALID_ATTRIBUTE_DATA', 'PreparedPointData coordinate aliases do not reference their named buffers.');
  }

  const normalized = normalizeSelection(selection);
  const attributes = validateAttributes(data.attributes, pointCount);
  return assembleView(
    pointCount,
    ecef,
    undefined,
    normalized.source ? source : undefined,
    normalized.geographic ? geographic : undefined,
    attributes,
    context,
    expected,
    normalized,
  );
}

/**
 * Create a zero-copy view over the Tiles E protocol. This structural input is
 * intentionally independent of Adapter's unexported experimental cache type.
 */
export function createExperimentalETilePointView(
  node: ExperimentalETileNodeInput,
  context: TileNodeContext,
  expected: TileViewExpectation,
  selection: TilePointFieldSelection = EMPTY_SELECTION,
): TilePointView {
  assertRecord(node, 'experimental E node');
  const pointCount = validatePointCount(node.pointCount);
  const ecef = requireFloat64(node.ecef, pointCount * 3, 'ecef');
  const height = requireFloat64(node.height, pointCount, 'height');
  const source = node.source === undefined ? undefined : requireFloat64(node.source, pointCount * 3, 'source');
  const geographic = node.geographic === undefined ? undefined : requireFloat64(node.geographic, pointCount * 3, 'geographic');
  const normalized = normalizeSelection(selection);
  const attributes = validateAttributes(node.attributes, pointCount);

  return assembleView(
    pointCount,
    ecef,
    normalized.preparedHeight ? height : undefined,
    normalized.source ? source : undefined,
    normalized.geographic ? geographic : undefined,
    attributes,
    context,
    expected,
    normalized,
  );
}

/** Validate and select a view returned by an external source implementation. */
export function validateTilePointView(
  input: TilePointView,
  expected: TileViewExpectation,
  selection: TilePointFieldSelection = EMPTY_SELECTION,
): TilePointView {
  assertRecord(input, 'TilePointView');
  assertAllowedKeys(
    input,
    ['pointCount', 'ecef', 'preparedHeight', 'source', 'geographic', 'attributes', 'context'],
    'TilePointView',
    'INVALID_ATTRIBUTE_DATA',
  );
  const pointCount = validatePointCount(input.pointCount);
  const ecef = requireFloat64(input.ecef, pointCount * 3, 'ecef');
  const preparedHeight = input.preparedHeight === undefined
    ? undefined
    : requireFloat64(input.preparedHeight, pointCount, 'preparedHeight');
  const source = input.source === undefined ? undefined : requireFloat64(input.source, pointCount * 3, 'source');
  const geographic = input.geographic === undefined
    ? undefined
    : requireFloat64(input.geographic, pointCount * 3, 'geographic');
  const attributes = validateAttributes(input.attributes, pointCount);
  return assembleView(
    pointCount,
    ecef,
    preparedHeight,
    source,
    geographic,
    attributes,
    input.context,
    expected,
    normalizeSelection(selection),
  );
}

function assembleView(
  pointCount: number,
  ecef: Float64Array,
  preparedHeight: Float64Array | undefined,
  source: Float64Array | undefined,
  geographic: Float64Array | undefined,
  attributes: TilePointAttributes | undefined,
  contextInput: TileNodeContext,
  expected: TileViewExpectation,
  selection: NormalizedSelection,
): TilePointView {
  const context = snapshotAndValidateContext(contextInput, expected);

  const selectedAttributes = selectAttributes(attributes, selection, pointCount);
  const selectedHeight = selection.preparedHeight ? preparedHeight : undefined;
  const selectedSource = selection.source ? source : undefined;
  const selectedGeographic = selection.geographic ? geographic : undefined;
  if (selection.preparedHeight && selectedHeight === undefined) {
    fail('MISSING_REQUESTED_FIELD', 'A separate prepared-height buffer is not available.', 'preparedHeight');
  }
  if (selection.source && selectedSource === undefined) {
    fail('MISSING_REQUESTED_FIELD', 'Requested Source coordinates are not retained.', 'source');
  }
  if (selection.geographic && selectedGeographic === undefined) {
    fail('MISSING_REQUESTED_FIELD', 'Requested Geographic coordinates are not retained.', 'geographic');
  }
  return Object.freeze({
    pointCount,
    ecef,
    ...(selectedHeight === undefined ? {} : { preparedHeight: selectedHeight }),
    ...(selectedSource === undefined ? {} : { source: selectedSource }),
    ...(selectedGeographic === undefined ? {} : { geographic: selectedGeographic }),
    ...(selectedAttributes ? { attributes: selectedAttributes } : {}),
    context,
  });
}

function normalizeSelection(selection: TilePointFieldSelection): NormalizedSelection {
  assertRecord(selection, 'field selection');
  assertAllowedKeys(selection, ['coordinates', 'attributes'], 'field selection');
  const coordinates = selection.coordinates === undefined ? {} : selection.coordinates;
  const attributes = selection.attributes === undefined ? {} : selection.attributes;
  assertRecord(coordinates, 'coordinate selection');
  assertRecord(attributes, 'attribute selection');
  assertAllowedKeys(coordinates, ['source', 'geographic', 'preparedHeight'], 'coordinate selection');
  assertAllowedKeys(attributes, ['rgb', 'intensity', 'classification', 'extraDimensions'], 'attribute selection');

  const extraDimensions = attributes.extraDimensions === undefined ? [] : attributes.extraDimensions;
  if (!Array.isArray(extraDimensions) || extraDimensions.some((name) => typeof name !== 'string' || name.trim() === '')) {
    fail('INVALID_FIELD_SELECTION', 'extraDimensions must be an array of non-empty exact names.', 'extraDimensions');
  }
  if (new Set(extraDimensions).size !== extraDimensions.length) {
    fail('INVALID_FIELD_SELECTION', 'extraDimensions must not contain duplicate names.', 'extraDimensions');
  }

  return {
    source: booleanSelection(coordinates.source, 'coordinates.source'),
    geographic: booleanSelection(coordinates.geographic, 'coordinates.geographic'),
    preparedHeight: booleanSelection(coordinates.preparedHeight, 'coordinates.preparedHeight'),
    rgb: booleanSelection(attributes.rgb, 'attributes.rgb'),
    intensity: booleanSelection(attributes.intensity, 'attributes.intensity'),
    classification: booleanSelection(attributes.classification, 'attributes.classification'),
    extraDimensions: [...extraDimensions],
  };
}

function validateAttributes(
  attributes: TilePointAttributes | undefined,
  pointCount: number,
): TilePointAttributes | undefined {
  if (attributes === undefined) return undefined;
  assertRecord(attributes, 'attributes', 'INVALID_ATTRIBUTE_DATA');
  assertAllowedKeys(
    attributes,
    ['red', 'green', 'blue', 'intensity', 'classification', 'extraDimensions'],
    'attributes',
    'INVALID_ATTRIBUTE_DATA',
  );

  const channelPresence = [attributes.red !== undefined, attributes.green !== undefined, attributes.blue !== undefined];
  if (channelPresence.some(Boolean) && !channelPresence.every(Boolean)) {
    fail('INVALID_ATTRIBUTE_DATA', 'RGB data must contain all three channels.', 'rgb');
  }
  if (attributes.red !== undefined) requireUint16(attributes.red, pointCount, 'red');
  if (attributes.green !== undefined) requireUint16(attributes.green, pointCount, 'green');
  if (attributes.blue !== undefined) requireUint16(attributes.blue, pointCount, 'blue');
  if (attributes.intensity !== undefined) requireUint16(attributes.intensity, pointCount, 'intensity');
  if (attributes.classification !== undefined) requireUint8(attributes.classification, pointCount, 'classification');

  if (attributes.extraDimensions !== undefined) {
    assertRecord(attributes.extraDimensions, 'extraDimensions', 'INVALID_ATTRIBUTE_DATA');
    for (const [name, values] of Object.entries(attributes.extraDimensions)) {
      if (name.trim() === '') fail('INVALID_ATTRIBUTE_DATA', 'Extra-dimension names must not be empty.', name);
      if (!(values instanceof Float64Array || values instanceof BigInt64Array || values instanceof BigUint64Array)) {
        fail('INVALID_ATTRIBUTE_DATA', `Extra dimension "${name}" has an unsupported typed-array representation.`, name);
      }
      if (values.length !== pointCount) {
        fail('INVALID_BUFFER_LENGTH', `Extra dimension "${name}" must contain ${pointCount} values.`, name);
      }
    }
  }
  return attributes;
}

function selectAttributes(
  available: TilePointAttributes | undefined,
  selection: NormalizedSelection,
  pointCount: number,
): TileSelectedAttributes | undefined {
  const selected: {
    red?: Uint16Array;
    green?: Uint16Array;
    blue?: Uint16Array;
    intensity?: Uint16Array;
    classification?: Uint8Array;
    extraDimensions?: Record<string, TileExtraDimensionValues>;
  } = {};

  if (selection.rgb) {
    if (!available?.red || !available.green || !available.blue) {
      fail('MISSING_REQUESTED_FIELD', 'Requested RGB attributes are not available.', 'rgb');
    }
    selected.red = available.red;
    selected.green = available.green;
    selected.blue = available.blue;
  }
  if (selection.intensity) {
    if (!available?.intensity) fail('MISSING_REQUESTED_FIELD', 'Requested intensity is not available.', 'intensity');
    selected.intensity = available.intensity;
  }
  if (selection.classification) {
    if (!available?.classification) fail('MISSING_REQUESTED_FIELD', 'Requested classification is not available.', 'classification');
    selected.classification = available.classification;
  }
  if (selection.extraDimensions.length > 0) {
    const availableExtras = available?.extraDimensions;
    const requestedExtras: Record<string, TileExtraDimensionValues> = Object.create(null);
    for (const name of selection.extraDimensions) {
      if (!availableExtras || !Object.hasOwn(availableExtras, name)) {
        fail('MISSING_REQUESTED_FIELD', `Requested extra dimension "${name}" is not available.`, name);
      }
      const values = availableExtras[name];
      if (!values || values.length !== pointCount) {
        fail('INVALID_BUFFER_LENGTH', `Extra dimension "${name}" must contain ${pointCount} values.`, name);
      }
      requestedExtras[name] = values;
    }
    selected.extraDimensions = Object.freeze(requestedExtras);
  }

  if (Object.keys(selected).length === 0) return undefined;
  return Object.freeze(selected);
}

function requireCoordinateBuffer(
  buffer: unknown,
  pointCount: number,
  expectedSystem: string,
  field: string,
): Float64Array {
  assertRecord(buffer, field);
  if (buffer.coordinateSystem !== expectedSystem) {
    fail('INVALID_COORDINATE_SYSTEM', `${field} must be tagged as ${expectedSystem}.`, field);
  }
  if (buffer.pointCount !== pointCount) {
    fail('INVALID_POINT_COUNT', `${field}.pointCount does not match the point view.`, `${field}.pointCount`);
  }
  return requireFloat64(buffer.coordinates, pointCount * 3, field);
}

function requireFloat64(value: unknown, expectedLength: number, field: string): Float64Array {
  if (!(value instanceof Float64Array)) {
    fail('INVALID_BUFFER_TYPE', `${field} must be a Float64Array.`, field);
  }
  if (value.length !== expectedLength) {
    fail('INVALID_BUFFER_LENGTH', `${field} must contain ${expectedLength} values.`, field);
  }
  return value;
}

function requireUint16(value: unknown, pointCount: number, field: string): Uint16Array {
  if (!(value instanceof Uint16Array)) fail('INVALID_ATTRIBUTE_DATA', `${field} must be a Uint16Array.`, field);
  if (value.length !== pointCount) fail('INVALID_BUFFER_LENGTH', `${field} must contain ${pointCount} values.`, field);
  return value;
}

function requireUint8(value: unknown, pointCount: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) fail('INVALID_ATTRIBUTE_DATA', `${field} must be a Uint8Array.`, field);
  if (value.length !== pointCount) fail('INVALID_BUFFER_LENGTH', `${field} must contain ${pointCount} values.`, field);
  return value;
}

function validatePointCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || !Number.isSafeInteger((value as number) * 3)) {
    fail('INVALID_POINT_COUNT', 'pointCount must be a non-negative safe integer with a safe XYZ length.', 'pointCount');
  }
  return value as number;
}

function snapshotAndValidateContext(
  value: TileNodeContext,
  expected: TileViewExpectation,
): TileNodeContext {
  assertRecord(value, 'node context', 'INVALID_PROVENANCE');
  assertRecord(expected, 'view expectation', 'INVALID_PROVENANCE');
  if (typeof value.sourceIdentity !== 'string' || value.sourceIdentity.trim() === '') {
    fail('INVALID_PROVENANCE', 'sourceIdentity must be a non-empty opaque identifier.', 'sourceIdentity');
  }
  if (typeof value.nodeKey !== 'string' || value.nodeKey.trim() === '') {
    fail('INVALID_PROVENANCE', 'nodeKey must be a non-empty stable key.', 'nodeKey');
  }
  if (!Number.isSafeInteger(value.transformGeneration) || value.transformGeneration < 0) {
    fail('INVALID_PROVENANCE', 'transformGeneration must be a non-negative safe integer.', 'transformGeneration');
  }
  if (value.sourceGeneration !== undefined && (!Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration < 0)) {
    fail('INVALID_PROVENANCE', 'sourceGeneration must be a non-negative safe integer.', 'sourceGeneration');
  }
  if (!Number.isFinite(value.heightOffsetMeters)) {
    fail('INVALID_PROVENANCE', 'heightOffsetMeters must be finite.', 'heightOffsetMeters');
  }
  if (typeof expected.sourceIdentity !== 'string' || expected.sourceIdentity.trim() === '') {
    fail('INVALID_PROVENANCE', 'Expected sourceIdentity must be a non-empty opaque identifier.', 'sourceIdentity');
  }
  if (!Number.isSafeInteger(expected.transformGeneration) || expected.transformGeneration < 0) {
    fail('INVALID_PROVENANCE', 'Expected transformGeneration must be a non-negative safe integer.', 'transformGeneration');
  }
  if (expected.sourceGeneration !== undefined && (!Number.isSafeInteger(expected.sourceGeneration) || expected.sourceGeneration < 0)) {
    fail('INVALID_PROVENANCE', 'Expected sourceGeneration must be a non-negative safe integer.', 'sourceGeneration');
  }
  if (value.sourceIdentity !== expected.sourceIdentity) {
    fail('STALE_SOURCE', 'Point data belongs to a different source identity.', 'sourceIdentity');
  }
  if (value.transformGeneration !== expected.transformGeneration) {
    fail('STALE_GENERATION', 'Point data belongs to a stale transform generation.', 'transformGeneration');
  }
  if (expected.sourceGeneration !== undefined && value.sourceGeneration !== expected.sourceGeneration) {
    fail('STALE_GENERATION', 'Point data belongs to a stale source generation.', 'sourceGeneration');
  }

  const sourceCrs = snapshotCrsEvidence(value.sourceCrs);
  const verticalDatum = snapshotVerticalEvidence(value.verticalDatum);
  const transformPlan = value.transformPlan === undefined ? undefined : snapshotTransformPlan(value.transformPlan);
  const availableFields = value.availableFields === undefined
    ? undefined
    : snapshotNameList(value.availableFields, 'availableFields');
  const availableExtraDimensions = value.availableExtraDimensions === undefined
    ? undefined
    : snapshotNameList(value.availableExtraDimensions, 'availableExtraDimensions');
  const decodedPointEcefBounds = value.decodedPointEcefBounds === undefined
    ? undefined
    : snapshotDecodedPointEcefBounds(value.decodedPointEcefBounds);
  if (value.decodedPointEcefBoundsKind !== undefined && value.decodedPointEcefBoundsKind !== 'decoded-point-content') {
    fail('INVALID_PROVENANCE', 'ECEF bounds must be labeled decoded-point-content.', 'decodedPointEcefBoundsKind');
  }
  if ((decodedPointEcefBounds === undefined) !== (value.decodedPointEcefBoundsKind === undefined)) {
    fail('INVALID_PROVENANCE', 'Decoded-point ECEF bounds require their documented bounds kind.', 'decodedPointEcefBounds');
  }
  return Object.freeze({
    sourceIdentity: value.sourceIdentity,
    nodeKey: value.nodeKey,
    ...(value.sourceGeneration === undefined ? {} : { sourceGeneration: value.sourceGeneration }),
    transformGeneration: value.transformGeneration,
    sourceCrs,
    verticalDatum,
    heightOffsetMeters: value.heightOffsetMeters,
    ...(transformPlan === undefined ? {} : { transformPlan }),
    ...(availableFields === undefined ? {} : { availableFields }),
    ...(availableExtraDimensions === undefined ? {} : { availableExtraDimensions }),
    ...(decodedPointEcefBounds === undefined ? {} : {
      decodedPointEcefBounds,
      decodedPointEcefBoundsKind: 'decoded-point-content' as const,
    }),
  });
}

function snapshotTransformPlan(value: TileTransformPlanProvenance): TileTransformPlanProvenance {
  assertRecord(value, 'transformPlan', 'INVALID_PROVENANCE');
  if (value.schema !== 'copc-coordinate-transform-plan' || value.version !== 1) {
    fail('INVALID_PROVENANCE', 'Unsupported coordinate transform plan schema.', 'transformPlan');
  }
  assertRecord(value.identity, 'transformPlan.identity', 'INVALID_PROVENANCE');
  if (typeof value.identity.key !== 'string' || value.identity.key.trim() === '') {
    fail('INVALID_PROVENANCE', 'Transform plan identity must be non-empty.', 'transformPlan.identity.key');
  }
  if (!Number.isFinite(value.manualHeightOffsetMeters)) {
    fail('INVALID_PROVENANCE', 'Transform plan height offset must be finite.', 'transformPlan.manualHeightOffsetMeters');
  }
  // Adapter documents the plan as immutable; preserve that exact object and
  // avoid copying or interpreting its operation internals in Tiles.
  return value;
}

function snapshotNameList(value: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || name.trim() === '')) {
    fail('INVALID_PROVENANCE', `${field} must contain non-empty strings.`, field);
  }
  if (new Set(value).size !== value.length) {
    fail('INVALID_PROVENANCE', `${field} must not contain duplicates.`, field);
  }
  return Object.freeze([...value]);
}

function snapshotDecodedPointEcefBounds(value: TileDecodedPointEcefBounds): TileDecodedPointEcefBounds {
  assertRecord(value, 'decodedPointEcefBounds', 'INVALID_PROVENANCE');
  const coordinates = [value.minX, value.minY, value.minZ, value.maxX, value.maxY, value.maxZ];
  if (value.coordinateSystem !== 'wgs84-ecef-meters' || coordinates.some((coordinate) => !Number.isFinite(coordinate))) {
    fail('INVALID_PROVENANCE', 'Decoded-point ECEF bounds must contain finite WGS84 ECEF coordinates.', 'decodedPointEcefBounds');
  }
  if (value.minX > value.maxX || value.minY > value.maxY || value.minZ > value.maxZ) {
    fail('INVALID_PROVENANCE', 'Decoded-point ECEF bounds have reversed limits.', 'decodedPointEcefBounds');
  }
  return Object.freeze({ ...value });
}

function snapshotCrsEvidence(value: TileSourceCrsEvidence): TileSourceCrsEvidence {
  assertRecord(value, 'sourceCrs', 'INVALID_PROVENANCE');
  if (!['identified', 'unverified', 'unknown'].includes(value.status)) {
    fail('INVALID_PROVENANCE', 'sourceCrs.status is invalid.', 'sourceCrs.status');
  }
  assertOptionalString(value.identifier, 'sourceCrs.identifier');
  assertOptionalString(value.definition, 'sourceCrs.definition');
  assertOptionalString(value.horizontalUnit, 'sourceCrs.horizontalUnit');
  assertOptionalString(value.verticalUnit, 'sourceCrs.verticalUnit');
  assertOptionalString(value.reason, 'sourceCrs.reason');
  if (value.status === 'identified' && !nonEmpty(value.identifier) && !nonEmpty(value.definition)) {
    fail('INVALID_PROVENANCE', 'Identified source CRS needs an identifier or definition.', 'sourceCrs');
  }
  return Object.freeze({ ...value });
}

function snapshotVerticalEvidence(value: TileVerticalDatumEvidence): TileVerticalDatumEvidence {
  assertRecord(value, 'verticalDatum', 'INVALID_PROVENANCE');
  if (!['verified', 'unverified', 'unknown'].includes(value.status)) {
    fail('INVALID_PROVENANCE', 'verticalDatum.status is invalid.', 'verticalDatum.status');
  }
  assertOptionalString(value.identifier, 'verticalDatum.identifier');
  if (value.status === 'verified' && !nonEmpty(value.identifier)) {
    fail('INVALID_PROVENANCE', 'Verified vertical datum needs an identifier.', 'verticalDatum.identifier');
  }
  if (!Array.isArray(value.corrections)) {
    fail('INVALID_PROVENANCE', 'verticalDatum.corrections must be an array.', 'verticalDatum.corrections');
  }
  const corrections: TileVerticalCorrection[] = value.corrections.map((correction, index): TileVerticalCorrection => {
    assertRecord(correction, `verticalDatum.corrections[${index}]`, 'INVALID_PROVENANCE');
    if (correction.kind === 'manual-offset') {
      if (!Number.isFinite(correction.offsetMeters)) {
        fail('INVALID_PROVENANCE', 'Manual correction offset must be finite.', `verticalDatum.corrections[${index}]`);
      }
      assertOptionalString(correction.identifier, `verticalDatum.corrections[${index}].identifier`);
      return Object.freeze({ ...correction }) as TileVerticalCorrection;
    }
    if (correction.kind === 'validated-grid') {
      if (typeof correction.identifier !== 'string' || correction.identifier.trim() === '') {
        fail('INVALID_PROVENANCE', 'Validated-grid correction needs an identifier.', `verticalDatum.corrections[${index}]`);
      }
      assertOptionalString(correction.version, `verticalDatum.corrections[${index}].version`);
      return Object.freeze({ ...correction }) as TileVerticalCorrection;
    }
    fail('INVALID_PROVENANCE', 'Vertical correction kind is unsupported.', `verticalDatum.corrections[${index}]`);
  });
  return Object.freeze({ ...value, corrections });
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    fail('INVALID_PROVENANCE', `${field} must be a string when present.`, field);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function booleanSelection(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('INVALID_FIELD_SELECTION', `${field} must be a boolean.`, field);
  return value;
}

function assertRecord(
  value: unknown,
  name: string,
  code: TileViewErrorCode = 'INVALID_ATTRIBUTE_DATA',
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${name} must be an object.`, name);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  code: TileViewErrorCode = 'INVALID_FIELD_SELECTION',
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code, `${name} contains unsupported field "${key}".`, key);
  }
}

function fail(code: TileViewErrorCode, message: string, field?: string): never {
  throw new TilePointViewError(code, message, field);
}
