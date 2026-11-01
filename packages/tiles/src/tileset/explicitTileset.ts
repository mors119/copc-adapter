import { createTileTranslationTransform } from '../geometry/tileLocalCoordinates.js';
import type { TileConservativeBoundsResult, TileHierarchyNode } from '../source/tileNodeSource.js';

export type EcefAxisAlignedBounds = Readonly<{
  minimum: readonly [number, number, number];
  maximum: readonly [number, number, number];
}>;

export type TilesetNodeInput = Readonly<{
  node: TileHierarchyNode;
  /** Conservative world-space WGS 84 ECEF bounds in metres. */
  bounds: EcefAxisAlignedBounds;
}>;

export type ExplicitTilesetOptions = Readonly<{
  tilesetVersion?: string;
  maxNodes?: number;
  maxTotalPoints?: number;
}>;

export type ExplicitTilesetErrorCode =
  | 'INVALID_INPUT'
  | 'INCOMPLETE_HIERARCHY'
  | 'INVALID_COVERAGE'
  | 'INVALID_BOUNDS'
  | 'TILESET_LIMIT'
  | 'UNSUPPORTED_BOUNDS';

export class ExplicitTilesetError extends Error {
  readonly code: ExplicitTilesetErrorCode;
  readonly nodeKey: string | undefined;
  readonly conservativeBoundsResult: TileConservativeBoundsResult | undefined;

  constructor(
    code: ExplicitTilesetErrorCode,
    message: string,
    nodeKey?: string,
    conservativeBoundsResult?: TileConservativeBoundsResult,
  ) {
    super(message);
    this.name = 'ExplicitTilesetError';
    this.code = code;
    this.nodeKey = nodeKey;
    this.conservativeBoundsResult = conservativeBoundsResult;
  }
}

const DEFAULT_MAX_NODES = 100_000;
const HARD_MAX_NODES = 500_000;
const DEFAULT_MAX_TOTAL_POINTS = 20_000_000;
const HARD_MAX_TOTAL_POINTS = 100_000_000;
const MIN_HALF_EXTENT_M = 0.001;

/**
 * Convert one supported Adapter cell result to a Tileset bound, expanding it
 * by the encoder's measured maximum ECEF reconstruction error. Pass the
 * maximum across a node's encoded descendants when preparing hierarchy bounds
 * so parent/child containment remains true. A zero padding is valid only when
 * the encoded representation had zero measured error.
 */
export function createPaddedEcefBoundsFromConservativeResult(
  result: TileConservativeBoundsResult,
  encoderErrorPaddingMeters: number,
): EcefAxisAlignedBounds {
  if (!Number.isFinite(encoderErrorPaddingMeters) || encoderErrorPaddingMeters < 0) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'Encoder reconstruction padding must be a finite non-negative number.', result?.nodeKey);
  }
  if (!result || result.status !== 'supported') {
    const unsupported = result as Extract<TileConservativeBoundsResult, { status: 'unsupported' }> | undefined;
    throw new ExplicitTilesetError(
      'UNSUPPORTED_BOUNDS',
      unsupported
        ? `No conservative ECEF bound is available (${unsupported.reasonCode}): ${unsupported.reason}`
        : 'A supported conservative ECEF bound is required.',
      unsupported?.nodeKey,
      unsupported,
    );
  }
  if (
    result.encoderErrorPaddingRequired !== true ||
    !result.boundsEcef || result.boundsEcef.coordinateSystem !== 'wgs84-ecef-meters'
  ) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'Conservative ECEF bounds are missing their required encoder-padding or coordinate-system certification.', result.nodeKey);
  }
  const bounds = result.boundsEcef;
  const rawCoordinates = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ];
  if (
    !rawCoordinates.every(Number.isFinite) ||
    bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ
  ) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'Conservative ECEF bounds must be finite and ordered.', result.nodeKey);
  }
  const minimum: [number, number, number] = [
    bounds.minX - encoderErrorPaddingMeters,
    bounds.minY - encoderErrorPaddingMeters,
    bounds.minZ - encoderErrorPaddingMeters,
  ];
  const maximum: [number, number, number] = [
    bounds.maxX + encoderErrorPaddingMeters,
    bounds.maxY + encoderErrorPaddingMeters,
    bounds.maxZ + encoderErrorPaddingMeters,
  ];
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'Padded conservative ECEF bounds exceed the finite numeric range.', result.nodeKey);
  }
  return Object.freeze({ minimum: Object.freeze(minimum), maximum: Object.freeze(maximum) });
}

type ValidNode = Readonly<{
  node: TileHierarchyNode;
  bounds: EcefAxisAlignedBounds;
  origin: Float64Array;
  halfExtents: Float64Array;
  children: readonly string[];
}>;

/**
 * Create an explicit 3D Tiles 1.1 hierarchy from metadata only. The caller
 * supplies conservative ECEF bounds; no point payload is requested or decoded.
 */
export function createExplicitTileset(
  inputs: readonly TilesetNodeInput[],
  options: ExplicitTilesetOptions = {},
): Readonly<Record<string, unknown>> {
  if (!options || typeof options !== 'object') {
    throw new ExplicitTilesetError('INVALID_INPUT', 'Tileset options must be an object.');
  }
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0 || maxNodes > HARD_MAX_NODES) {
    throw new ExplicitTilesetError('TILESET_LIMIT', `maxNodes must be a positive safe integer no greater than ${HARD_MAX_NODES}.`);
  }
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > maxNodes) {
    throw new ExplicitTilesetError('TILESET_LIMIT', `Tileset hierarchy must contain 1 to ${maxNodes} nodes.`);
  }
  if (options.tilesetVersion !== undefined && (typeof options.tilesetVersion !== 'string' || options.tilesetVersion.trim() === '')) {
    throw new ExplicitTilesetError('INVALID_INPUT', 'tilesetVersion must be a non-empty string when provided.');
  }
  const maxTotalPoints = options.maxTotalPoints ?? DEFAULT_MAX_TOTAL_POINTS;
  if (!Number.isSafeInteger(maxTotalPoints) || maxTotalPoints <= 0 || maxTotalPoints > HARD_MAX_TOTAL_POINTS) {
    throw new ExplicitTilesetError('TILESET_LIMIT', `maxTotalPoints must be a positive safe integer no greater than ${HARD_MAX_TOTAL_POINTS}.`);
  }

  const nodes = new Map<string, ValidNode>();
  let totalPoints = 0;
  for (const input of inputs) {
    const node = validateHierarchyNode(input?.node);
    const bounds = validateBounds(input?.bounds, node.key);
    if (node.childrenComplete !== true) {
      throw new ExplicitTilesetError('INCOMPLETE_HIERARCHY', 'Explicit tileset generation requires complete direct-child discovery.', node.key);
    }
    if (nodes.has(node.key)) {
      throw new ExplicitTilesetError('INVALID_INPUT', 'Hierarchy node keys must be unique.', node.key);
    }
    totalPoints += node.pointCount;
    if (!Number.isSafeInteger(totalPoints) || totalPoints > maxTotalPoints) {
      throw new ExplicitTilesetError('TILESET_LIMIT', `Hierarchy point counts exceed ${maxTotalPoints}.`, node.key);
    }
    const minimum = bounds.minimum;
    const maximum = bounds.maximum;
    const origin = new Float64Array(minimum.map((value, axis) => value + (maximum[axis] - value) / 2));
    const halfExtents = new Float64Array(minimum.map((value, axis) => Math.max((maximum[axis] - value) / 2, MIN_HALF_EXTENT_M)));
    nodes.set(node.key, Object.freeze({ node, bounds, origin, halfExtents, children: node.children ?? [] }));
  }

  const parentOf = new Map<string, string>();
  for (const item of nodes.values()) {
    for (const childKey of item.children) {
      const child = nodes.get(childKey);
      if (!child) {
        throw new ExplicitTilesetError('INCOMPLETE_HIERARCHY', `Child node "${childKey}" was not supplied.`, item.node.key);
      }
      if (parentOf.has(childKey)) {
        throw new ExplicitTilesetError('INVALID_COVERAGE', 'A hierarchy node has multiple parents.', childKey);
      }
      parentOf.set(childKey, item.node.key);
      validateOctreeRelationship(item.node, child.node);
      validateBoundsContain(item.bounds, child.bounds, item.node.key, childKey);
    }
  }

  const roots = [...nodes.values()].filter((item) => !parentOf.has(item.node.key));
  if (roots.length !== 1) {
    throw new ExplicitTilesetError('INVALID_COVERAGE', `Expected one hierarchy root; found ${roots.length}.`);
  }
  const root = roots[0];
  if (!root || root.node.level !== 0 || root.node.x !== 0 || root.node.y !== 0 || root.node.z !== 0) {
    throw new ExplicitTilesetError('INVALID_COVERAGE', 'The explicit tileset root must be the COPC level-zero voxel.', root?.node.key);
  }

  const traversal: string[] = [];
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (key: string): void => {
    if (state.get(key) === 'visiting') throw new ExplicitTilesetError('INVALID_COVERAGE', 'Hierarchy contains a cycle.', key);
    if (state.get(key) === 'visited') return;
    const item = nodes.get(key);
    if (!item) throw new ExplicitTilesetError('INCOMPLETE_HIERARCHY', 'A reachable node is missing.', key);
    state.set(key, 'visiting');
    for (const childKey of item.children) visit(childKey);
    state.set(key, 'visited');
    traversal.push(key);
  };
  visit(root.node.key);
  if (traversal.length !== nodes.size) {
    const unreachable = [...nodes.keys()].find((key) => state.get(key) !== 'visited');
    throw new ExplicitTilesetError('INVALID_COVERAGE', 'Every supplied node must be reachable from the single root.', unreachable);
  }

  const geometricErrors = new Map<string, number>();
  for (const key of traversal) {
    const item = nodes.get(key);
    if (!item) continue;
    const error = item.children.reduce((maximumError, childKey) => {
      const child = nodes.get(childKey);
      const childError = geometricErrors.get(childKey) ?? 0;
      return Math.max(maximumError, child ? halfDiagonal(child.halfExtents) : 0, childError);
    }, 0);
    geometricErrors.set(key, error);
  }

  const buildTile = (key: string, parentOrigin: Float64Array): Record<string, unknown> => {
    const item = nodes.get(key);
    if (!item) throw new ExplicitTilesetError('INCOMPLETE_HIERARCHY', 'A node disappeared during tileset construction.', key);
    const box = makeLocalBox(item.halfExtents);
    const tile: Record<string, unknown> = {
      boundingVolume: { box },
      geometricError: geometricErrors.get(key) ?? 0,
      refine: 'ADD',
      transform: [...createTileTranslationTransform(item.origin, parentOrigin)],
    };
    if (item.node.pointCount > 0) {
      const content = { uri: getExplicitTileContentUri(item.node.key), boundingVolume: { box: [...box] } };
      tile.content = content;
    }
    if (item.children.length > 0) {
      tile.children = item.children.map((childKey) => buildTile(childKey, item.origin));
    }
    return tile;
  };

  const rootTile = buildTile(root.node.key, new Float64Array(3));
  return Object.freeze({
    asset: { version: '1.1', ...(options.tilesetVersion === undefined ? {} : { tilesetVersion: options.tilesetVersion }) },
    geometricError: geometricErrors.get(root.node.key) ?? 0,
    root: rootTile,
  });
}

function validateHierarchyNode(value: unknown): TileHierarchyNode {
  if (!isRecord(value)) throw new ExplicitTilesetError('INVALID_INPUT', 'Each tileset node must include a hierarchy node record.');
  const { key, level, x, y, z, pointCount, pointDataOffset, pointDataLength, children, childrenComplete } = value;
  if (
    typeof key !== 'string' || key.trim() === '' || key.length > 1024 ||
    (typeof key === 'string' && new TextEncoder().encode(key).byteLength > 256) ||
    ![level, x, y, z, pointCount, pointDataOffset, pointDataLength].every((number) => Number.isSafeInteger(number) && (number as number) >= 0) ||
    (level as number) > 52 || [x, y, z].some((coordinate) => (coordinate as number) >= 2 ** (level as number)) ||
    (children !== undefined && (!Array.isArray(children) || children.some((child) => typeof child !== 'string' || child.trim() === '' || child.length > 1024) || new Set(children).size !== children.length)) ||
    (childrenComplete !== undefined && typeof childrenComplete !== 'boolean')
  ) {
    throw new ExplicitTilesetError('INVALID_INPUT', 'Hierarchy node identity, coordinates, range, or child completeness is invalid.', typeof key === 'string' ? key : undefined);
  }
  if ((pointCount as number) > 0 && (pointDataLength as number) === 0) {
    throw new ExplicitTilesetError('INVALID_INPUT', 'A node with points must have a non-empty point-data range.', key as string);
  }
  return Object.freeze({
    key: key as string,
    level: level as number,
    x: x as number,
    y: y as number,
    z: z as number,
    pointCount: pointCount as number,
    pointDataOffset: pointDataOffset as number,
    pointDataLength: pointDataLength as number,
    ...(children === undefined ? {} : { children: Object.freeze([...(children as string[])]) }),
    ...(childrenComplete === undefined ? {} : { childrenComplete }),
  });
}

function validateBounds(value: unknown, nodeKey: string): EcefAxisAlignedBounds {
  if (!isRecord(value) || !validVector(value.minimum) || !validVector(value.maximum)) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'ECEF bounds require finite three-component minimum and maximum vectors.', nodeKey);
  }
  const minimum = value.minimum as readonly [number, number, number];
  const maximum = value.maximum as readonly [number, number, number];
  if (minimum.some((component, axis) => component > maximum[axis])) {
    throw new ExplicitTilesetError('INVALID_BOUNDS', 'ECEF bound minimum must not exceed maximum.', nodeKey);
  }
  return Object.freeze({ minimum: Object.freeze([...minimum]) as unknown as typeof minimum, maximum: Object.freeze([...maximum]) as unknown as typeof maximum });
}

function validateBoundsContain(parent: EcefAxisAlignedBounds, child: EcefAxisAlignedBounds, parentKey: string, childKey: string): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if (child.minimum[axis] < parent.minimum[axis] || child.maximum[axis] > parent.maximum[axis]) {
      throw new ExplicitTilesetError('INVALID_COVERAGE', `Child ECEF bounds exceed parent axis ${axis}.`, childKey || parentKey);
    }
  }
}

function validateOctreeRelationship(parent: TileHierarchyNode, child: TileHierarchyNode): void {
  if (
    child.level !== parent.level + 1 ||
    Math.floor(child.x / 2) !== parent.x ||
    Math.floor(child.y / 2) !== parent.y ||
    Math.floor(child.z / 2) !== parent.z
  ) {
    throw new ExplicitTilesetError('INVALID_COVERAGE', 'Child key coordinates are not the next COPC octree level.', child.key);
  }
}

function makeLocalBox(halfExtents: Float64Array): number[] {
  return [
    0, 0, 0,
    halfExtents[0], 0, 0,
    0, halfExtents[1], 0,
    0, 0, halfExtents[2],
  ];
}

function halfDiagonal(halfExtents: Float64Array): number {
  return Math.hypot(halfExtents[0], halfExtents[1], halfExtents[2]);
}

/** Stable path used by explicit COPC content resources. */
export function getExplicitTileContentUri(nodeKey: string): string {
  if (typeof nodeKey !== 'string' || nodeKey.trim() === '' || new TextEncoder().encode(nodeKey).byteLength > 256) {
    throw new ExplicitTilesetError('INVALID_INPUT', 'Tile content node keys must be non-empty UTF-8 strings no larger than 256 bytes.');
  }
  const bytes = new TextEncoder().encode(nodeKey);
  const safeKey = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `content/${safeKey}.glb`;
}

function validVector(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
