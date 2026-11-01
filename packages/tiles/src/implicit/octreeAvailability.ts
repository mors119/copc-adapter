import type { TileHierarchyNode } from '../source/tileNodeSource.js';

export type OctreeCoordinates = Readonly<{
  level: number;
  x: number;
  y: number;
  z: number;
}>;

const MAX_SUBTREE_LEVELS = 6;

/** Interleave local octree coordinate bits in x, y, z order (least significant bit first). */
export function octreeMortonIndex(coordinates: OctreeCoordinates): number {
  const { level, x, y, z } = coordinates;
  if (
    !Number.isSafeInteger(level) || level < 0 || level > MAX_SUBTREE_LEVELS ||
    ![x, y, z].every((coordinate) => Number.isSafeInteger(coordinate) && coordinate >= 0 && coordinate < 2 ** level)
  ) {
    throw new RangeError(`Octree Morton coordinates must be integers within a local level from 0 to ${MAX_SUBTREE_LEVELS}.`);
  }
  let morton = 0;
  for (let bit = 0; bit < level; bit += 1) {
    const factor = 2 ** (3 * bit);
    morton += (Math.floor(x / (2 ** bit)) % 2) * factor;
    morton += (Math.floor(y / (2 ** bit)) % 2) * factor * 2;
    morton += (Math.floor(z / (2 ** bit)) % 2) * factor * 4;
  }
  return morton;
}

export function octreeAvailabilityIndex(coordinates: OctreeCoordinates): number {
  const nodeCountBeforeLevel = (8 ** coordinates.level - 1) / 7;
  return nodeCountBeforeLevel + octreeMortonIndex(coordinates);
}

export function octreeSubtreeBitLengths(subtreeLevels: number): Readonly<{
  tileAvailability: number;
  contentAvailability: number;
  childSubtreeAvailability: number;
}> {
  if (!Number.isSafeInteger(subtreeLevels) || subtreeLevels < 1 || subtreeLevels > MAX_SUBTREE_LEVELS) {
    throw new RangeError(`subtreeLevels must be a safe integer from 1 to ${MAX_SUBTREE_LEVELS}.`);
  }
  const childCount = 8 ** subtreeLevels;
  const nodesInSubtree = (childCount - 1) / 7;
  return Object.freeze({
    tileAvailability: nodesInSubtree,
    contentAvailability: nodesInSubtree,
    childSubtreeAvailability: childCount,
  });
}

export type AvailabilityDescriptor = Readonly<{
  constant?: 0 | 1;
  bitstream?: number;
  availableCount?: number;
}>;

export type MutableSubtreeBinary = {
  readonly bufferViews: Array<Readonly<{ buffer: number; byteOffset: number; byteLength: number }>>;
  readonly payloads: Array<Readonly<{ byteOffset: number; bytes: Uint8Array }>>;
  byteLength: number;
};

/** Encode one availability array using the 3D Metadata least-significant-bit-first bit order. */
export function encodeAvailabilityBits(bits: readonly boolean[], binary: MutableSubtreeBinary): AvailabilityDescriptor {
  if (bits.length === 0) throw new RangeError('Availability arrays must contain at least one bit.');
  const first = bits[0];
  if (first !== undefined && bits.every((bit) => bit === first)) {
    return Object.freeze({ constant: first ? 1 : 0 });
  }

  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  let availableCount = 0;
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === true) {
      const byteIndex = Math.floor(index / 8);
      const bitOffset = index % 8;
      const previous = bytes[byteIndex] ?? 0;
      bytes[byteIndex] = previous | (1 << bitOffset);
      availableCount += 1;
    }
  }
  const byteOffset = align8(binary.byteLength);
  const bufferViewIndex = binary.bufferViews.length;
  binary.bufferViews.push(Object.freeze({ buffer: 0, byteOffset, byteLength: bytes.byteLength }));
  binary.payloads.push(Object.freeze({ byteOffset, bytes }));
  binary.byteLength = byteOffset + bytes.byteLength;
  return Object.freeze({ bitstream: bufferViewIndex, availableCount });
}

export function packSubtreeBinary(json: unknown, binary: MutableSubtreeBinary): Uint8Array {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonChunkLength = align8(jsonBytes.byteLength);
  const binaryChunkLength = binary.payloads.length > 0 ? align8(binary.byteLength) : 0;
  const totalLength = 24 + jsonChunkLength + binaryChunkLength;
  if (!Number.isSafeInteger(totalLength) || totalLength > 0xffff_ffff) {
    throw new RangeError('The binary subtree exceeds the 4 GiB safety limit.');
  }

  const output = new Uint8Array(totalLength);
  const header = new DataView(output.buffer, output.byteOffset, 24);
  header.setUint32(0, 0x74627573, true);
  header.setUint32(4, 1, true);
  header.setBigUint64(8, BigInt(jsonChunkLength), true);
  header.setBigUint64(16, BigInt(binaryChunkLength), true);
  output.set(jsonBytes, 24);
  output.fill(0x20, 24 + jsonBytes.byteLength, 24 + jsonChunkLength);

  for (const payload of binary.payloads) {
    output.set(payload.bytes, 24 + jsonChunkLength + payload.byteOffset);
  }
  return output;
}

export function align8(value: number): number {
  return Math.ceil(value / 8) * 8;
}

export type ImplicitHierarchyNode = Readonly<{
  node: TileHierarchyNode;
  /** True only when this node has tile content. Defaults from pointCount when omitted. */
  hasContent?: boolean;
}>;
