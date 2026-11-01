import { createTileTranslationTransform } from '../geometry/tileLocalCoordinates.js';
import type { EcefAxisAlignedBounds } from './explicitTileset.js';
import type { TileHierarchyNode } from '../source/tileNodeSource.js';
import {
  align8,
  encodeAvailabilityBits,
  octreeAvailabilityIndex,
  octreeMortonIndex,
  octreeSubtreeBitLengths,
  packSubtreeBinary,
  type MutableSubtreeBinary,
} from '../implicit/octreeAvailability.js';

export type ImplicitOctreeNodeInput = Readonly<{
  node: TileHierarchyNode;
  /** Conservative WGS 84 ECEF bounds in metres, within this node's implicit octree cell. */
  bounds: EcefAxisAlignedBounds;
}>;

export type ImplicitOctreeOptions = Readonly<{
  subtreeLevels?: number;
  tilesetVersion?: string;
  maxNodes?: number;
  maxTotalPoints?: number;
  maxSubtrees?: number;
  maxTotalSubtreeBytes?: number;
}>;

export type ImplicitOctreeErrorCode =
  | 'INVALID_INPUT'
  | 'INCOMPLETE_HIERARCHY'
  | 'INVALID_COVERAGE'
  | 'INVALID_BOUNDS'
  | 'TILESET_LIMIT';

export class ImplicitOctreeError extends Error {
  readonly code: ImplicitOctreeErrorCode;
  readonly nodeKey: string | undefined;

  constructor(code: ImplicitOctreeErrorCode, message: string, nodeKey?: string) {
    super(message);
    this.name = 'ImplicitOctreeError';
    this.code = code;
    this.nodeKey = nodeKey;
  }
}

const DEFAULT_MAX_NODES = 100_000;
const HARD_MAX_NODES = 500_000;
const DEFAULT_MAX_TOTAL_POINTS = 20_000_000;
const HARD_MAX_TOTAL_POINTS = 100_000_000;
const DEFAULT_MAX_SUBTREES = 10_000;
const HARD_MAX_SUBTREES = 100_000;
const DEFAULT_MAX_TOTAL_SUBTREE_BYTES = 64 * 1024 * 1024;
const HARD_MAX_TOTAL_SUBTREE_BYTES = 512 * 1024 * 1024;
const MIN_HALF_EXTENT_M = 0.001;
const TEMPLATE_CONTENT_URI = 'content/{level}/{x}/{y}/{z}.glb';
const TEMPLATE_SUBTREE_URI = 'subtrees/{level}/{x}/{y}/{z}.subtree';

type ValidNode = Readonly<{
  node: TileHierarchyNode;
  bounds: EcefAxisAlignedBounds;
  coordinateKey: string;
}>;

type EcefCell = Readonly<{
  minimum: readonly [number, number, number];
  maximum: readonly [number, number, number];
}>;

type SubtreeRoot = Readonly<{ level: number; x: number; y: number; z: number }>;

/** Build a 3D Tiles 1.1 OCTREE tileset and its bounded binary subtree resources. */
export function createImplicitOctreeTileset(
  inputs: readonly ImplicitOctreeNodeInput[],
  options: ImplicitOctreeOptions = {},
): Readonly<{
  tileset: Readonly<Record<string, unknown>>;
  subtrees: ReadonlyMap<string, Uint8Array>;
  /** Use as the Float64 origin when encoding every GLB under this implicit root. */
  contentOriginEcef: readonly [number, number, number];
}> {
  if (!options || typeof options !== 'object') {
    throw new ImplicitOctreeError('INVALID_INPUT', 'Implicit octree options must be an object.');
  }
  const subtreeLevels = options.subtreeLevels ?? 4;
  let bitLengths: ReturnType<typeof octreeSubtreeBitLengths>;
  try {
    bitLengths = octreeSubtreeBitLengths(subtreeLevels);
  } catch {
    throw new ImplicitOctreeError('TILESET_LIMIT', 'subtreeLevels must be from 1 to 6.');
  }
  const maxNodes = boundedInteger(options.maxNodes, DEFAULT_MAX_NODES, HARD_MAX_NODES, 'maxNodes');
  const maxTotalPoints = boundedInteger(options.maxTotalPoints, DEFAULT_MAX_TOTAL_POINTS, HARD_MAX_TOTAL_POINTS, 'maxTotalPoints');
  const maxSubtrees = boundedInteger(options.maxSubtrees, DEFAULT_MAX_SUBTREES, HARD_MAX_SUBTREES, 'maxSubtrees');
  const maxTotalSubtreeBytes = boundedInteger(options.maxTotalSubtreeBytes, DEFAULT_MAX_TOTAL_SUBTREE_BYTES, HARD_MAX_TOTAL_SUBTREE_BYTES, 'maxTotalSubtreeBytes');
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > maxNodes) {
    throw new ImplicitOctreeError('TILESET_LIMIT', `Hierarchy must contain 1 to ${maxNodes} nodes.`);
  }
  if (options.tilesetVersion !== undefined && (typeof options.tilesetVersion !== 'string' || options.tilesetVersion.trim() === '')) {
    throw new ImplicitOctreeError('INVALID_INPUT', 'tilesetVersion must be a non-empty string when provided.');
  }

  const nodesByKey = new Map<string, ValidNode>();
  const nodesByCoordinates = new Map<string, ValidNode>();
  let totalPoints = 0;
  let maxLevel = 0;
  for (const input of inputs) {
    const node = validateNode(input?.node);
    const bounds = validateBounds(input?.bounds, node.key);
    const coordinateKey = coordinatesKey(node);
    if (nodesByKey.has(node.key) || nodesByCoordinates.has(coordinateKey)) {
      throw new ImplicitOctreeError('INVALID_COVERAGE', 'Node keys and octree coordinates must be unique.', node.key);
    }
    totalPoints += node.pointCount;
    if (!Number.isSafeInteger(totalPoints) || totalPoints > maxTotalPoints) {
      throw new ImplicitOctreeError('TILESET_LIMIT', `Hierarchy point counts exceed ${maxTotalPoints}.`, node.key);
    }
    maxLevel = Math.max(maxLevel, node.level);
    const valid = Object.freeze({ node, bounds, coordinateKey });
    nodesByKey.set(node.key, valid);
    nodesByCoordinates.set(coordinateKey, valid);
  }

  const rootRecord = nodesByCoordinates.get('0/0/0/0');
  if (!rootRecord) throw new ImplicitOctreeError('INVALID_COVERAGE', 'The hierarchy must contain the level-zero root voxel.');
  const rootCell = inflateDegenerateBounds(rootRecord.bounds);
  const expectedChildren = new Map<string, string[]>();
  for (const item of nodesByKey.values()) {
    const { node } = item;
    if (node.childrenComplete !== true) {
      throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', 'Implicit tiling requires complete direct-child discovery.', node.key);
    }
    const children = node.children ?? [];
    if (node.level > 0) {
      const parent = nodesByCoordinates.get(coordinatesKey({
        level: node.level - 1,
        x: Math.floor(node.x / 2),
        y: Math.floor(node.y / 2),
        z: Math.floor(node.z / 2),
      }));
      if (!parent) throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', 'An available node has no available parent.', node.key);
      if (!(parent.node.children ?? []).includes(node.key)) {
        throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', 'Parent child lists must include each available octree node.', parent.node.key);
      }
      const siblings = expectedChildren.get(parent.coordinateKey) ?? [];
      siblings.push(node.key);
      expectedChildren.set(parent.coordinateKey, siblings);
    }
    for (const childKey of children) {
      const child = nodesByKey.get(childKey);
      if (!child) throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', `Child node "${childKey}" was not supplied.`, node.key);
      if (
        child.node.level !== node.level + 1 ||
        Math.floor(child.node.x / 2) !== node.x ||
        Math.floor(child.node.y / 2) !== node.y ||
        Math.floor(child.node.z / 2) !== node.z
      ) {
        throw new ImplicitOctreeError('INVALID_COVERAGE', 'Child coordinates are not the next octree level.', child.node.key);
      }
    }
  }

  for (const item of nodesByKey.values()) {
    const children = item.node.children ?? [];
    const expected = expectedChildren.get(item.coordinateKey) ?? [];
    if (children.length !== expected.length || children.some((key) => !expected.includes(key))) {
      throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', 'Direct child discovery does not match the supplied node set.', item.node.key);
    }
    const cell = getCell(rootCell, item.node);
    if (!contains(cell, item.bounds)) {
      throw new ImplicitOctreeError('INVALID_BOUNDS', 'Node ECEF bounds fall outside their implicit octree cell.', item.node.key);
    }
  }

  const subtreeRoots = new Map<string, SubtreeRoot>();
  const nodesBySubtreeRoot = new Map<string, ValidNode[]>();
  for (const item of nodesByKey.values()) {
    const root = containingSubtreeRoot(item.node, subtreeLevels);
    const rootKey = coordinatesKey(root);
    subtreeRoots.set(rootKey, root);
    const members = nodesBySubtreeRoot.get(rootKey) ?? [];
    members.push(item);
    nodesBySubtreeRoot.set(rootKey, members);
  }
  if (subtreeRoots.size > maxSubtrees) {
    throw new ImplicitOctreeError('TILESET_LIMIT', `Hierarchy requires ${subtreeRoots.size} subtrees; the limit is ${maxSubtrees}.`);
  }

  const childSubtreeRoots = new Map<string, ValidNode[]>();
  for (const item of nodesByKey.values()) {
    if (item.node.level === 0 || item.node.level % subtreeLevels !== 0) continue;
    const parentRoot: SubtreeRoot = {
      level: item.node.level - subtreeLevels,
      x: Math.floor(item.node.x / (2 ** subtreeLevels)),
      y: Math.floor(item.node.y / (2 ** subtreeLevels)),
      z: Math.floor(item.node.z / (2 ** subtreeLevels)),
    };
    const parentKey = coordinatesKey(parentRoot);
    if (!subtreeRoots.has(parentKey)) {
      throw new ImplicitOctreeError('INCOMPLETE_HIERARCHY', 'A child subtree root has no available parent subtree.', item.node.key);
    }
    const children = childSubtreeRoots.get(parentKey) ?? [];
    children.push(item);
    childSubtreeRoots.set(parentKey, children);
  }

  const hasAnyContent = [...nodesByKey.values()].some((item) => item.node.pointCount > 0);
  const sortedRoots = [...subtreeRoots.values()].sort(compareCoordinates);
  const subtrees = new Map<string, Uint8Array>();
  let totalSubtreeBytes = 0;
  for (const root of sortedRoots) {
    const rootKey = coordinatesKey(root);
    const members = nodesBySubtreeRoot.get(rootKey) ?? [];
    const tileBits = new Array<boolean>(bitLengths.tileAvailability).fill(false);
    const contentBits = hasAnyContent ? new Array<boolean>(bitLengths.contentAvailability).fill(false) : undefined;
    const childBits = new Array<boolean>(bitLengths.childSubtreeAvailability).fill(false);

    for (const item of members) {
      const local = localCoordinates(item.node, root);
      const index = octreeAvailabilityIndex(local);
      if (index < 0 || index >= tileBits.length) {
        throw new ImplicitOctreeError('INVALID_COVERAGE', 'Node falls outside its fixed-size subtree.', item.node.key);
      }
      tileBits[index] = true;
      if (item.node.pointCount > 0 && contentBits) contentBits[index] = true;
    }

    for (const item of childSubtreeRoots.get(rootKey) ?? []) {
      const localLevel = subtreeLevels;
      const local = {
        level: localLevel,
        x: item.node.x - root.x * (2 ** localLevel),
        y: item.node.y - root.y * (2 ** localLevel),
        z: item.node.z - root.z * (2 ** localLevel),
      };
      const index = octreeMortonIndex(local);
      childBits[index] = true;
    }

    const binary: MutableSubtreeBinary = { bufferViews: [], payloads: [], byteLength: 0 };
    const subtreeJson: Record<string, unknown> = {
      tileAvailability: encodeAvailabilityBits(tileBits, binary),
      ...(contentBits ? { contentAvailability: [encodeAvailabilityBits(contentBits, binary)] } : {}),
      childSubtreeAvailability: encodeAvailabilityBits(childBits, binary),
      ...(binary.bufferViews.length > 0
        ? { buffers: [{ byteLength: align8(binary.byteLength) }], bufferViews: binary.bufferViews }
        : {}),
    };
    const bytes = packSubtreeBinary(subtreeJson, binary);
    totalSubtreeBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalSubtreeBytes) || totalSubtreeBytes > maxTotalSubtreeBytes) {
      throw new ImplicitOctreeError('TILESET_LIMIT', `Subtree bytes exceed ${maxTotalSubtreeBytes}.`, nodesByCoordinates.get(rootKey)?.node.key);
    }
    subtrees.set(subtreeUri(root), bytes);
  }

  const origin = new Float64Array(rootCell.minimum.map((minimum, axis) => minimum + (rootCell.maximum[axis] - minimum) / 2));
  const halfExtents = new Float64Array(rootCell.minimum.map((minimum, axis) => (rootCell.maximum[axis] - minimum) / 2));
  const rootBox = [0, 0, 0, halfExtents[0], 0, 0, 0, halfExtents[1], 0, 0, 0, halfExtents[2]];
  const geometricError = Math.hypot(...halfExtents);
  const tile: Record<string, unknown> = {
    boundingVolume: { box: rootBox },
    geometricError,
    refine: 'ADD',
    transform: [...createTileTranslationTransform(origin)],
    implicitTiling: {
      subdivisionScheme: 'OCTREE',
      availableLevels: maxLevel + 1,
      subtreeLevels,
      subtrees: { uri: TEMPLATE_SUBTREE_URI },
    },
    ...(hasAnyContent ? { content: { uri: TEMPLATE_CONTENT_URI } } : {}),
  };
  const tileset = Object.freeze({
    asset: { version: '1.1', ...(options.tilesetVersion === undefined ? {} : { tilesetVersion: options.tilesetVersion }) },
    geometricError,
    root: tile,
  });
  const contentOriginEcef = Object.freeze([origin[0], origin[1], origin[2]]) as readonly [number, number, number];
  return Object.freeze({ tileset, subtrees, contentOriginEcef });
}

function boundedInteger(value: number | undefined, defaultValue: number, hardMaximum: number, name: string): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result <= 0 || result > hardMaximum) {
    throw new ImplicitOctreeError('TILESET_LIMIT', `${name} must be a positive safe integer no greater than ${hardMaximum}.`);
  }
  return result;
}

function validateNode(value: unknown): TileHierarchyNode {
  if (!isRecord(value)) throw new ImplicitOctreeError('INVALID_INPUT', 'Each node must be a hierarchy record.');
  const { key, level, x, y, z, pointCount, pointDataOffset, pointDataLength, children, childrenComplete } = value;
  if (
    typeof key !== 'string' || key.trim() === '' || key.length > 1024 || new TextEncoder().encode(key).byteLength > 256 ||
    ![level, x, y, z, pointCount, pointDataOffset, pointDataLength].every((item) => Number.isSafeInteger(item) && (item as number) >= 0) ||
    (level as number) > 52 || [x, y, z].some((coordinate) => (coordinate as number) >= 2 ** (level as number)) ||
    !Number.isSafeInteger((pointDataOffset as number) + (pointDataLength as number)) ||
    (children !== undefined && (!Array.isArray(children) || children.some((child) => typeof child !== 'string' || child.trim() === '' || child.length > 1024) || new Set(children).size !== children.length)) ||
    (childrenComplete !== undefined && typeof childrenComplete !== 'boolean')
  ) {
    throw new ImplicitOctreeError('INVALID_INPUT', 'Node identity, octree coordinates, range, or child list is malformed.', typeof key === 'string' ? key : undefined);
  }
  if ((pointCount as number) > 0 && (pointDataLength as number) === 0) {
    throw new ImplicitOctreeError('INVALID_INPUT', 'A content node must have a non-empty point-data range.', key as string);
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
    ...(childrenComplete === undefined ? {} : { childrenComplete: childrenComplete as boolean }),
  });
}

function validateBounds(value: unknown, nodeKey: string): EcefAxisAlignedBounds {
  if (!isRecord(value) || !validVector(value.minimum) || !validVector(value.maximum)) {
    throw new ImplicitOctreeError('INVALID_BOUNDS', 'ECEF bounds need finite three-component minimum and maximum vectors.', nodeKey);
  }
  const minimum = value.minimum as readonly [number, number, number];
  const maximum = value.maximum as readonly [number, number, number];
  const extents = minimum.map((component, axis) => maximum[axis] - component);
  if (minimum.some((component, axis) => component > maximum[axis]) || extents.some((extent) => !Number.isFinite(extent))) {
    throw new ImplicitOctreeError('INVALID_BOUNDS', 'ECEF bound minima, maxima, and extents must be finite and ordered.', nodeKey);
  }
  return Object.freeze({
    minimum: Object.freeze([...minimum]) as unknown as typeof minimum,
    maximum: Object.freeze([...maximum]) as unknown as typeof maximum,
  });
}

function inflateDegenerateBounds(bounds: EcefAxisAlignedBounds): EcefCell {
  const minimum = [0, 1, 2].map((axis) => {
    const center = bounds.minimum[axis] + (bounds.maximum[axis] - bounds.minimum[axis]) / 2;
    return bounds.maximum[axis] === bounds.minimum[axis] ? center - MIN_HALF_EXTENT_M : bounds.minimum[axis];
  });
  const maximum = [0, 1, 2].map((axis) => {
    const center = bounds.minimum[axis] + (bounds.maximum[axis] - bounds.minimum[axis]) / 2;
    return bounds.maximum[axis] === bounds.minimum[axis] ? center + MIN_HALF_EXTENT_M : bounds.maximum[axis];
  });
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    throw new ImplicitOctreeError('INVALID_BOUNDS', 'Implicit root bounds must have finite centers and extents.');
  }
  return Object.freeze({
    minimum: Object.freeze(minimum) as unknown as EcefCell['minimum'],
    maximum: Object.freeze(maximum) as unknown as EcefCell['maximum'],
  });
}

function getCell(root: EcefCell, node: TileHierarchyNode): EcefCell {
  const scale = 2 ** node.level;
  const minimum = [node.x, node.y, node.z].map((coordinate, axis) => {
    const extent = root.maximum[axis] - root.minimum[axis];
    return root.minimum[axis] + extent * (coordinate / scale);
  });
  const maximum = [node.x, node.y, node.z].map((coordinate, axis) => {
    const extent = root.maximum[axis] - root.minimum[axis];
    return root.minimum[axis] + extent * ((coordinate + 1) / scale);
  });
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    throw new ImplicitOctreeError('INVALID_BOUNDS', 'Implicit octree subdivision produced non-finite bounds.', node.key);
  }
  return { minimum: minimum as unknown as EcefCell['minimum'], maximum: maximum as unknown as EcefCell['maximum'] };
}

function contains(cell: EcefCell, bounds: EcefAxisAlignedBounds): boolean {
  return [0, 1, 2].every((axis) => {
    const tolerance = Number.EPSILON * Math.max(Math.abs(cell.minimum[axis]), Math.abs(cell.maximum[axis]), 1) * 8;
    return bounds.minimum[axis] >= cell.minimum[axis] - tolerance && bounds.maximum[axis] <= cell.maximum[axis] + tolerance;
  });
}

function containingSubtreeRoot(node: TileHierarchyNode, subtreeLevels: number): SubtreeRoot {
  const level = Math.floor(node.level / subtreeLevels) * subtreeLevels;
  const localLevel = node.level - level;
  const divisor = 2 ** localLevel;
  return {
    level,
    x: Math.floor(node.x / divisor),
    y: Math.floor(node.y / divisor),
    z: Math.floor(node.z / divisor),
  };
}

function localCoordinates(node: TileHierarchyNode, root: SubtreeRoot): Readonly<{ level: number; x: number; y: number; z: number }> {
  const level = node.level - root.level;
  return {
    level,
    x: node.x - root.x * (2 ** level),
    y: node.y - root.y * (2 ** level),
    z: node.z - root.z * (2 ** level),
  };
}

function coordinatesKey(coordinates: Readonly<{ level: number; x: number; y: number; z: number }>): string {
  return `${coordinates.level}/${coordinates.x}/${coordinates.y}/${coordinates.z}`;
}

function subtreeUri(root: SubtreeRoot): string {
  return `subtrees/${root.level}/${root.x}/${root.y}/${root.z}.subtree`;
}

function compareCoordinates(a: SubtreeRoot, b: SubtreeRoot): number {
  return a.level - b.level || a.x - b.x || a.y - b.y || a.z - b.z;
}

function validVector(value: unknown): value is readonly [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
