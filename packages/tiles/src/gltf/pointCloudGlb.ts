import {
  validateTilePointView,
  type TilePointView,
} from '../input/tilePointView.js';
import {
  encodeTileLocalPositions,
  type TileLocalCoordinateOptions,
} from '../geometry/tileLocalCoordinates.js';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const ARRAY_BUFFER_TARGET = 34962;
const FLOAT_COMPONENT_TYPE = 5126;
const UNSIGNED_SHORT_COMPONENT_TYPE = 5123;
const EXT_MESH_FEATURES = 'EXT_mesh_features';
const EXT_STRUCTURAL_METADATA = 'EXT_structural_metadata';
const POINTS_MODE = 0;

type GlbAccessorDescriptor = {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: 'VEC3';
  normalized?: boolean;
  min?: number[];
  max?: number[];
};

type GlbBufferViewDescriptor = {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
  byteStride?: number;
};

const DEFAULT_LIMITS = Object.freeze({ maxPoints: 2_000_000, maxOutputBytes: 256 * 1024 * 1024 });
const HARD_LIMITS = Object.freeze({ maxPoints: 10_000_000, maxOutputBytes: 512 * 1024 * 1024 });

export type PointCloudGlbOptions = Readonly<{
  maxPoints?: number;
  maxOutputBytes?: number;
  maxMetadataProperties?: number;
  precision?: TileLocalCoordinateOptions;
}>;

export type EncodedPointCloudGlb = Readonly<{
  bytes: Uint8Array;
  mimeType: 'model/gltf-binary';
  pointCount: number;
  hasColor: boolean;
  originEcef: Float64Array;
  tileTransform: Float64Array;
  maxAbsoluteErrorMeters: number;
  maxRelativeError: number;
  /** Original LAS/extra-dimension property names stored through standard glTF metadata. */
  metadataProperties: readonly string[];
}>;

export type GlbEncodingErrorCode =
  | 'INVALID_INPUT'
  | 'POINT_LIMIT'
  | 'ATTRIBUTE_LIMIT'
  | 'OUTPUT_LIMIT'
  | 'UNSUPPORTED_METADATA'
  | 'INVALID_BINARY_LENGTH';

export class GlbEncodingError extends Error {
  readonly code: GlbEncodingErrorCode;

  constructor(code: GlbEncodingErrorCode, message: string) {
    super(message);
    this.name = 'GlbEncodingError';
    this.code = code;
  }
}

/**
 * Encode one point view as a glTF 2.0 POINTS GLB. Empty nodes return null and
 * therefore produce no content resource or zero-count accessor.
 */
export function encodePointCloudGlb(
  input: TilePointView,
  options: PointCloudGlbOptions = {},
): EncodedPointCloudGlb | null {
  const limits = resolveLimits(options);
  const selection = selectionForAvailableAttributes(input);
  let view: TilePointView;
  try {
    view = validateTilePointView(input, {
      sourceIdentity: input.context.sourceIdentity,
      transformGeneration: input.context.transformGeneration,
    }, selection);
  } catch (error) {
    throw new GlbEncodingError('INVALID_INPUT', `Point view failed validation: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (view.pointCount === 0) return null;
  if (view.pointCount > limits.maxPoints) {
    throw new GlbEncodingError('POINT_LIMIT', `Point count ${view.pointCount} exceeds the configured limit ${limits.maxPoints}.`);
  }

  const attributes = view.attributes;
  const hasColor = attributes?.red !== undefined;
  if (hasColor && (!attributes?.green || !attributes.blue)) {
    throw new GlbEncodingError('INVALID_INPUT', 'COLOR_0 requires all three RGB channels.');
  }

  const local = encodeTileLocalPositions(view, options.precision);
  const positionBytes = checkedProduct(view.pointCount, 12, 'POSITION');
  // 8-byte stride keeps each tightly packed VEC3 of 16-bit channels on
  // 4-byte vertex boundaries required by the glTF validator.
  const colorBytes = hasColor ? checkedProduct(view.pointCount, 8, 'COLOR_0') : 0;
  const baseBinaryLength = safeAdd(positionBytes, colorBytes, 'binary buffer');
  const metadata = createPointMetadata(attributes, view.pointCount, baseBinaryLength, limits.maxMetadataProperties);
  const unpaddedBinaryLength = metadata.byteLength;
  const paddedBinaryLength = align4(unpaddedBinaryLength);
  const bufferViews: GlbBufferViewDescriptor[] = [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes, target: ARRAY_BUFFER_TARGET },
  ];
  const accessors: GlbAccessorDescriptor[] = [
    {
      bufferView: 0,
      byteOffset: 0,
      componentType: FLOAT_COMPONENT_TYPE,
      count: view.pointCount,
      type: 'VEC3',
      min: [...local.positionMin],
      max: [...local.positionMax],
    },
  ];
  const primitiveAttributes: Record<string, number> = { POSITION: 0 };

  if (hasColor) {
    bufferViews.push({
      buffer: 0,
      byteOffset: positionBytes,
      byteLength: colorBytes,
      byteStride: 8,
      target: ARRAY_BUFFER_TARGET,
    });
    accessors.push({
      bufferView: 1,
      byteOffset: 0,
      componentType: UNSIGNED_SHORT_COMPONENT_TYPE,
      normalized: true,
      count: view.pointCount,
      type: 'VEC3',
    });
    primitiveAttributes.COLOR_0 = 1;
  }

  for (const property of metadata.properties) {
    bufferViews.push({
      buffer: 0,
      byteOffset: property.byteOffset,
      byteLength: property.byteLength,
    });
  }

  const primitive: Record<string, unknown> = {
    attributes: primitiveAttributes,
    mode: POINTS_MODE,
    ...(metadata.extension === undefined ? {} : {
      extensions: {
        [EXT_MESH_FEATURES]: {
          featureIds: [{
            featureCount: view.pointCount,
            propertyTable: 0,
          }],
        },
      },
    }),
  };

  const gltf = {
    asset: { version: '2.0', generator: '@frillab/copc-tiles' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: unpaddedBinaryLength }],
    ...(metadata.extension === undefined ? {} : {
      extensionsUsed: [EXT_MESH_FEATURES, EXT_STRUCTURAL_METADATA],
      extensions: { [EXT_STRUCTURAL_METADATA]: metadata.extension },
    }),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const paddedJsonLength = align4(jsonBytes.length);
  const totalLength = safeAdd(28, safeAdd(paddedJsonLength, paddedBinaryLength, 'GLB chunks'), 'GLB');
  if (totalLength > limits.maxOutputBytes || totalLength > 0xffffffff) {
    throw new GlbEncodingError('OUTPUT_LIMIT', `GLB output length ${totalLength} exceeds the configured or GLB container limit.`);
  }
  if (paddedBinaryLength > 0xffffffff || paddedJsonLength > 0xffffffff) {
    throw new GlbEncodingError('OUTPUT_LIMIT', 'A GLB chunk exceeds the unsigned 32-bit container limit.');
  }

  const bytes = new Uint8Array(totalLength);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  data.setUint32(0, GLB_MAGIC, true);
  data.setUint32(4, GLB_VERSION, true);
  data.setUint32(8, totalLength, true);
  data.setUint32(12, paddedJsonLength, true);
  data.setUint32(16, JSON_CHUNK_TYPE, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + paddedJsonLength);

  const binaryHeaderOffset = 20 + paddedJsonLength;
  data.setUint32(binaryHeaderOffset, paddedBinaryLength, true);
  data.setUint32(binaryHeaderOffset + 4, BIN_CHUNK_TYPE, true);
  const binaryOffset = binaryHeaderOffset + 8;
  for (let index = 0; index < local.positions.length; index += 1) {
    data.setFloat32(binaryOffset + index * 4, local.positions[index], true);
  }
  if (hasColor && attributes?.red && attributes.green && attributes.blue) {
    let colorOffset = binaryOffset + positionBytes;
    for (let point = 0; point < view.pointCount; point += 1) {
      data.setUint16(colorOffset, attributes.red[point], true);
      data.setUint16(colorOffset + 2, attributes.green[point], true);
      data.setUint16(colorOffset + 4, attributes.blue[point], true);
      colorOffset += 8;
    }
  }
  for (const property of metadata.properties) {
    writeMetadataValues(data, binaryOffset + property.byteOffset, property);
  }

  return Object.freeze({
    bytes,
    mimeType: 'model/gltf-binary',
    pointCount: view.pointCount,
    hasColor,
    originEcef: local.originEcef,
    tileTransform: local.tileTransform,
    maxAbsoluteErrorMeters: local.maxAbsoluteErrorMeters,
    maxRelativeError: local.maxRelativeError,
    metadataProperties: Object.freeze(metadata.properties.map((property) => property.name)),
  });
}

function selectionForAvailableAttributes(input: TilePointView) {
  const attributes = input?.attributes;
  if (!attributes) return {};
  return {
    attributes: {
      ...(attributes.red !== undefined || attributes.green !== undefined || attributes.blue !== undefined ? { rgb: true } : {}),
      ...(attributes.intensity === undefined ? {} : { intensity: true }),
      ...(attributes.classification === undefined ? {} : { classification: true }),
      ...(attributes.extraDimensions === undefined ? {} : { extraDimensions: Object.keys(attributes.extraDimensions) }),
    },
  };
}

type MetadataValues = Uint8Array | Uint16Array | Float64Array | BigInt64Array | BigUint64Array;

type MetadataProperty = Readonly<{
  name: string;
  id: string;
  componentType: 'UINT8' | 'UINT16' | 'FLOAT64' | 'INT64' | 'UINT64';
  componentBytes: number;
  values: MetadataValues;
  byteOffset: number;
  byteLength: number;
  bufferView: number;
}>;

type PointMetadata = Readonly<{
  extension: Readonly<Record<string, unknown>> | undefined;
  properties: readonly MetadataProperty[];
  byteLength: number;
}>;

function createPointMetadata(
  attributes: TilePointView['attributes'],
  pointCount: number,
  initialByteLength: number,
  maxMetadataProperties: number,
): PointMetadata {
  const candidates: Array<Omit<MetadataProperty, 'byteOffset' | 'byteLength' | 'bufferView'>> = [];
  if (attributes?.intensity) {
    candidates.push({ name: 'intensity', id: 'intensity', componentType: 'UINT16', componentBytes: 2, values: attributes.intensity });
  }
  if (attributes?.classification) {
    candidates.push({ name: 'classification', id: 'classification', componentType: 'UINT8', componentBytes: 1, values: attributes.classification });
  }
  for (const [name, values] of Object.entries(attributes?.extraDimensions ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) as Array<[string, MetadataValues]>) {
    const encodedName = new TextEncoder().encode(name);
    if (encodedName.byteLength === 0 || encodedName.byteLength > 128 || new TextDecoder('utf-8', { fatal: true }).decode(encodedName) !== name) {
      throw new GlbEncodingError('UNSUPPORTED_METADATA', `Extra-dimension name "${name}" is not valid UTF-8 or exceeds 128 bytes.`);
    }
    if (values.length !== pointCount) {
      throw new GlbEncodingError('INVALID_INPUT', `Extra dimension "${name}" has ${values.length} values; expected ${pointCount}.`);
    }
    if (values instanceof Float64Array && [...values].some((value) => !Number.isFinite(value))) {
      throw new GlbEncodingError('UNSUPPORTED_METADATA', `Extra dimension "${name}" contains a non-finite FLOAT64 value.`);
    }
    const hex = [...encodedName].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (values instanceof Float64Array) {
      candidates.push({ name, id: `extra_${hex}`, componentType: 'FLOAT64', componentBytes: 8, values });
    } else if (values instanceof BigInt64Array) {
      candidates.push({ name, id: `extra_${hex}`, componentType: 'INT64', componentBytes: 8, values });
    } else if (values instanceof BigUint64Array) {
      candidates.push({ name, id: `extra_${hex}`, componentType: 'UINT64', componentBytes: 8, values });
    } else {
      throw new GlbEncodingError('UNSUPPORTED_METADATA', `Extra dimension "${name}" uses an unsupported typed-array representation.`);
    }
  }
  if (candidates.length === 0) return Object.freeze({ extension: undefined, properties: Object.freeze([]), byteLength: initialByteLength });
  if (candidates.length > maxMetadataProperties) {
    throw new GlbEncodingError('ATTRIBUTE_LIMIT', `Metadata property count ${candidates.length} exceeds the configured limit ${maxMetadataProperties}.`);
  }

  let byteLength = initialByteLength;
  const firstPropertyView = 1 + (attributes?.red === undefined ? 0 : 1);
  const properties = candidates.map((candidate, index) => {
    const byteOffset = alignTo(byteLength, candidate.componentBytes);
    const propertyByteLength = checkedProduct(pointCount, candidate.componentBytes, candidate.id);
    byteLength = safeAdd(byteOffset, propertyByteLength, 'metadata buffer');
    return Object.freeze({
      ...candidate,
      byteOffset,
      byteLength: propertyByteLength,
      bufferView: firstPropertyView + index,
    });
  });

  const schemaProperties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const tableProperties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const property of properties) {
    schemaProperties[property.id] = {
      name: property.name,
      type: 'SCALAR',
      componentType: property.componentType,
      required: true,
    };
    tableProperties[property.id] = { values: property.bufferView };
  }
  const extension = Object.freeze({
    schema: {
      id: 'copc_tiles_point_attributes',
      version: '1.0.0',
      classes: {
        point: {
          name: 'COPC point attributes',
          properties: schemaProperties,
        },
      },
    },
    propertyTables: [{
      class: 'point',
      count: pointCount,
      properties: tableProperties,
    }],
  });
  return Object.freeze({ extension, properties: Object.freeze(properties), byteLength });
}

function writeMetadataValues(data: DataView, offset: number, property: MetadataProperty): void {
  for (let index = 0; index < property.values.length; index += 1) {
    const byteOffset = offset + index * property.componentBytes;
    switch (property.componentType) {
      case 'UINT8':
        data.setUint8(byteOffset, (property.values as Uint8Array)[index] as number);
        break;
      case 'UINT16':
        data.setUint16(byteOffset, (property.values as Uint16Array)[index] as number, true);
        break;
      case 'FLOAT64':
        data.setFloat64(byteOffset, (property.values as Float64Array)[index] as number, true);
        break;
      case 'INT64':
        data.setBigInt64(byteOffset, (property.values as BigInt64Array)[index] as bigint, true);
        break;
      case 'UINT64':
        data.setBigUint64(byteOffset, (property.values as BigUint64Array)[index] as bigint, true);
        break;
    }
  }
}

function alignTo(value: number, alignment: number): number {
  const result = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(result)) throw new GlbEncodingError('INVALID_BINARY_LENGTH', 'An aligned metadata offset is unsafe.');
  return result;
}

function resolveLimits(options: PointCloudGlbOptions): Readonly<{ maxPoints: number; maxOutputBytes: number; maxMetadataProperties: number }> {
  if (!options || typeof options !== 'object') {
    throw new GlbEncodingError('INVALID_INPUT', 'GLB options must be an object.');
  }
  const maxPoints = options.maxPoints ?? DEFAULT_LIMITS.maxPoints;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_LIMITS.maxOutputBytes;
  const maxMetadataProperties = options.maxMetadataProperties ?? 64;
  if (!Number.isSafeInteger(maxPoints) || maxPoints <= 0 || maxPoints > HARD_LIMITS.maxPoints) {
    throw new GlbEncodingError('POINT_LIMIT', `maxPoints must be a positive safe integer no greater than ${HARD_LIMITS.maxPoints}.`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > HARD_LIMITS.maxOutputBytes) {
    throw new GlbEncodingError('OUTPUT_LIMIT', `maxOutputBytes must be a positive safe integer no greater than ${HARD_LIMITS.maxOutputBytes}.`);
  }
  if (!Number.isSafeInteger(maxMetadataProperties) || maxMetadataProperties <= 0 || maxMetadataProperties > 256) {
    throw new GlbEncodingError('ATTRIBUTE_LIMIT', 'maxMetadataProperties must be a positive safe integer no greater than 256.');
  }
  return { maxPoints, maxOutputBytes, maxMetadataProperties };
}

function checkedProduct(count: number, itemSize: number, name: string): number {
  const result = count * itemSize;
  if (!Number.isSafeInteger(result) || result < 0 || result > 0xffffffff) {
    throw new GlbEncodingError('INVALID_BINARY_LENGTH', `${name} byte length is not a safe GLB buffer length.`);
  }
  return result;
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new GlbEncodingError('INVALID_BINARY_LENGTH', `${name} length is unsafe.`);
  }
  return result;
}

function align4(value: number): number {
  const result = Math.ceil(value / 4) * 4;
  if (!Number.isSafeInteger(result)) throw new GlbEncodingError('INVALID_BINARY_LENGTH', 'A padded chunk length is unsafe.');
  return result;
}
