import type {
  TileSourceCrsEvidence,
  TileVerticalDatumEvidence,
} from '../input/tilePointView.js';
import type { TileHierarchyNode } from '../source/tileNodeSource.js';
import type { EcefAxisAlignedBounds } from '../tileset/explicitTileset.js';

export type DecodedContentBoundsIndexNode = Readonly<{
  node: TileHierarchyNode;
  /** Present only when the node owns point content. Bounds enclose its points and GLB reconstruction. */
  content?: Readonly<{
    pointCount: number;
    contentBoundsEcef: EcefRecord;
    paddedContentBoundsEcef: EcefAxisAlignedBounds;
    encoderPaddingMeters: number;
  }>;
}>;

export type DecodedContentBoundsIndex = Readonly<{
  schema: 'copc-adapter-decoded-content-bounds-index';
  version: 1;
  sourceFingerprint: string;
  transformPlanIdentity: string;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  verticalPlacement: 'verified' | 'unverified';
  heightOffsetMeters: number;
  coverage: 'all-content-points-in-complete-hierarchy';
  hierarchyNodes: number;
  contentNodes: number;
  totalPoints: number;
  totalPointDataBytes: number;
  nodes: readonly DecodedContentBoundsIndexNode[];
  integrity: Readonly<{ algorithm: 'SHA-256'; digest: string }>;
}>;

export type DecodedContentBoundsIndexBuildInput = Readonly<{
  sourceFingerprint: string;
  transformPlanIdentity: string;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  heightOffsetMeters: number;
  hierarchy: readonly TileHierarchyNode[];
  contentBounds: ReadonlyMap<string, Readonly<{
    contentBoundsEcef: EcefRecord;
    paddedContentBoundsEcef: EcefAxisAlignedBounds;
    encoderPaddingMeters: number;
  }>>;
  totalPoints: number;
  totalPointDataBytes: number;
}>;

type EcefRecord = Readonly<{
  coordinateSystem: 'wgs84-ecef-meters';
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}>;

/** Build a deterministic, checksummed index from a completed content scan. */
export async function createDecodedContentBoundsIndex(
  input: DecodedContentBoundsIndexBuildInput,
): Promise<DecodedContentBoundsIndex> {
  validateFingerprint(input.sourceFingerprint);
  if (typeof input.transformPlanIdentity !== 'string' || input.transformPlanIdentity.trim() === '') {
    throw new TypeError('A non-empty immutable transform plan identity is required to build a content-bounds index.');
  }
  const contentNodes = input.hierarchy.filter((node) => node.pointCount > 0);
  if (contentNodes.length !== input.contentBounds.size) {
    throw new TypeError('A complete content-bounds index needs exactly one bound record for every content node.');
  }
  const nodes: DecodedContentBoundsIndexNode[] = input.hierarchy.map((node) => {
    if (node.childrenComplete !== true) throw new TypeError(`Node ${node.key} lacks complete child discovery.`);
    if (node.pointCount === 0) return Object.freeze({ node: copyNode(node) });
    const content = input.contentBounds.get(node.key);
    if (!content) throw new TypeError(`Content node ${node.key} has no indexed bound.`);
    return Object.freeze({
      node: copyNode(node),
      content: Object.freeze({
        pointCount: node.pointCount,
        contentBoundsEcef: Object.freeze({ ...content.contentBoundsEcef }),
        paddedContentBoundsEcef: copyAxisBounds(content.paddedContentBoundsEcef),
        encoderPaddingMeters: content.encoderPaddingMeters,
      }),
    });
  });
  const body = Object.freeze({
    schema: 'copc-adapter-decoded-content-bounds-index' as const,
    version: 1 as const,
    sourceFingerprint: input.sourceFingerprint,
    transformPlanIdentity: input.transformPlanIdentity,
    sourceCrs: deepFreezeJson(input.sourceCrs) as TileSourceCrsEvidence,
    verticalDatum: deepFreezeJson(input.verticalDatum) as TileVerticalDatumEvidence,
    verticalPlacement: input.verticalDatum.status === 'verified' ? 'verified' as const : 'unverified' as const,
    heightOffsetMeters: input.heightOffsetMeters,
    coverage: 'all-content-points-in-complete-hierarchy' as const,
    hierarchyNodes: input.hierarchy.length,
    contentNodes: contentNodes.length,
    totalPoints: input.totalPoints,
    totalPointDataBytes: input.totalPointDataBytes,
    nodes: Object.freeze(nodes),
  });
  validateIndexTotals(body);
  const digest = await sha256Hex(canonicalJson(body));
  return Object.freeze({
    ...body,
    integrity: Object.freeze({ algorithm: 'SHA-256', digest }),
  });
}

/** Validate checksum, provenance, complete coverage, and equality to live hierarchy metadata. */
export async function validateDecodedContentBoundsIndex(
  value: unknown,
  expected: Readonly<{
    sourceFingerprint: string;
    transformPlanIdentity: string;
    hierarchy: readonly TileHierarchyNode[];
  }>,
): Promise<DecodedContentBoundsIndex> {
  if (!isRecord(value) || value.schema !== 'copc-adapter-decoded-content-bounds-index' || value.version !== 1) {
    throw new TypeError('The content-bounds index schema or version is unsupported.');
  }
  if (!isRecord(value.integrity) || value.integrity.algorithm !== 'SHA-256' || !isHexDigest(value.integrity.digest)) {
    throw new TypeError('The content-bounds index has no valid SHA-256 integrity record.');
  }
  const { integrity: _integrity, ...rawBody } = value;
  const actualDigest = await sha256Hex(canonicalJson(rawBody));
  if (actualDigest !== value.integrity.digest) throw new TypeError('The content-bounds index checksum does not match its contents.');
  validateFingerprint(value.sourceFingerprint);
  if (value.sourceFingerprint !== expected.sourceFingerprint) {
    throw new TypeError('The content-bounds index belongs to a different immutable source fingerprint.');
  }
  if (typeof value.transformPlanIdentity !== 'string' || value.transformPlanIdentity !== expected.transformPlanIdentity) {
    throw new TypeError('The content-bounds index belongs to a different coordinate transform plan.');
  }
  if (value.coverage !== 'all-content-points-in-complete-hierarchy') {
    throw new TypeError('Partial content-bounds indexes cannot serve a complete Tileset.');
  }
  if (!Array.isArray(value.nodes) || value.nodes.length !== expected.hierarchy.length) {
    throw new TypeError('The content-bounds index hierarchy is incomplete or has extra nodes.');
  }
  if (!isRecord(value.sourceCrs) || !isRecord(value.verticalDatum) ||
      !Number.isFinite(value.heightOffsetMeters) ||
      (value.verticalPlacement !== 'verified' && value.verticalPlacement !== 'unverified')) {
    throw new TypeError('The content-bounds index has invalid CRS or vertical-datum provenance.');
  }
  validateCrsEvidence(value.sourceCrs);
  validateVerticalEvidence(value.verticalDatum);
  if (value.verticalPlacement !== (value.verticalDatum.status === 'verified' ? 'verified' : 'unverified')) {
    throw new TypeError('The content-bounds index vertical-placement summary disagrees with its datum evidence.');
  }
  const nodes: DecodedContentBoundsIndexNode[] = [];
  let contentNodes = 0;
  let totalPoints = 0;
  let totalPointDataBytes = 0;
  for (let index = 0; index < expected.hierarchy.length; index += 1) {
    const record = value.nodes[index];
    const liveNode = expected.hierarchy[index];
    if (!isRecord(record) || !isRecord(record.node) || !liveNode) throw new TypeError('The content-bounds index has a malformed hierarchy record.');
    const node = normalizeIndexNode(record.node);
    if (!sameNode(node, liveNode)) throw new TypeError(`The content-bounds index hierarchy metadata is stale at node ${liveNode.key}.`);
    if (node.childrenComplete !== true) throw new TypeError(`The content-bounds index does not prove complete child discovery for ${node.key}.`);
    if (node.pointCount === 0) {
      if (record.content !== undefined) throw new TypeError(`Empty node ${node.key} unexpectedly contains a content bound.`);
      nodes.push(Object.freeze({ node }));
      continue;
    }
    const content = record.content;
    if (!isRecord(content) || content.pointCount !== node.pointCount ||
        !isEcefRecord(content.contentBoundsEcef) ||
        !isAxisBounds(content.paddedContentBoundsEcef) ||
        typeof content.encoderPaddingMeters !== 'number' ||
        !Number.isFinite(content.encoderPaddingMeters) || content.encoderPaddingMeters < 0) {
      throw new TypeError(`Content node ${node.key} has an invalid bound or encoder allowance.`);
    }
    const raw = content.contentBoundsEcef as EcefRecord;
    const padded = content.paddedContentBoundsEcef as unknown as EcefAxisAlignedBounds;
    const encoderPaddingMeters = content.encoderPaddingMeters as number;
    if (!contains(padded, raw) || !containsPadding(raw, padded, encoderPaddingMeters)) {
      throw new TypeError(`Content node ${node.key} has inconsistent raw, padded, or encoder bounds.`);
    }
    nodes.push(Object.freeze({
      node,
      content: Object.freeze({
        pointCount: node.pointCount,
        contentBoundsEcef: Object.freeze({ ...raw }),
        paddedContentBoundsEcef: copyAxisBounds(padded),
        encoderPaddingMeters,
      }),
    }));
    contentNodes += 1;
    totalPoints += node.pointCount;
    totalPointDataBytes += node.pointDataLength;
  }
  const checked = Object.freeze({
    schema: 'copc-adapter-decoded-content-bounds-index' as const,
    version: 1 as const,
    sourceFingerprint: value.sourceFingerprint,
    transformPlanIdentity: value.transformPlanIdentity,
    sourceCrs: deepFreezeJson(value.sourceCrs) as TileSourceCrsEvidence,
    verticalDatum: deepFreezeJson(value.verticalDatum) as TileVerticalDatumEvidence,
    verticalPlacement: value.verticalPlacement,
    heightOffsetMeters: value.heightOffsetMeters as number,
    coverage: 'all-content-points-in-complete-hierarchy' as const,
    hierarchyNodes: value.hierarchyNodes as number,
    contentNodes: value.contentNodes as number,
    totalPoints: value.totalPoints as number,
    totalPointDataBytes: value.totalPointDataBytes as number,
    nodes: Object.freeze(nodes),
    integrity: Object.freeze({ algorithm: 'SHA-256' as const, digest: value.integrity.digest }),
  });
  validateIndexTotals(checked);
  if (checked.hierarchyNodes !== expected.hierarchy.length || checked.contentNodes !== contentNodes ||
      checked.totalPoints !== totalPoints || checked.totalPointDataBytes !== totalPointDataBytes) {
    throw new TypeError('The content-bounds index totals do not match its complete hierarchy.');
  }
  return checked;
}

function validateCrsEvidence(value: Record<string, unknown>): void {
  if (!['identified', 'unverified', 'unknown'].includes(String(value.status))) {
    throw new TypeError('The content-bounds index has an unsupported horizontal CRS evidence status.');
  }
  for (const key of ['identifier', 'definition', 'horizontalUnit', 'verticalUnit', 'reason']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new TypeError(`The content-bounds index CRS evidence field ${key} is malformed.`);
    }
  }
}

function validateVerticalEvidence(value: Record<string, unknown>): void {
  if (!['verified', 'unverified', 'unknown'].includes(String(value.status)) ||
      (value.identifier !== undefined && typeof value.identifier !== 'string') ||
      !Array.isArray(value.corrections)) {
    throw new TypeError('The content-bounds index has malformed vertical-datum evidence.');
  }
  for (const correction of value.corrections) {
    if (!isRecord(correction)) throw new TypeError('The content-bounds index has a malformed vertical correction record.');
    if (correction.kind === 'manual-offset') {
      if (typeof correction.offsetMeters !== 'number' || !Number.isFinite(correction.offsetMeters) ||
          (correction.identifier !== undefined && typeof correction.identifier !== 'string')) {
        throw new TypeError('The content-bounds index manual vertical correction is malformed.');
      }
    } else if (correction.kind === 'validated-grid') {
      if (typeof correction.identifier !== 'string' || correction.identifier.trim() === '' ||
          (correction.version !== undefined && typeof correction.version !== 'string')) {
        throw new TypeError('The content-bounds index validated-grid provenance is malformed.');
      }
    } else {
      throw new TypeError('The content-bounds index contains an unknown vertical correction kind.');
    }
  }
}

export function validateContentBoundsSourceFingerprint(value: unknown): asserts value is string {
  validateFingerprint(value);
}

function validateIndexTotals(value: Pick<DecodedContentBoundsIndex, 'hierarchyNodes' | 'contentNodes' | 'totalPoints' | 'totalPointDataBytes' | 'nodes'>): void {
  if (!Number.isSafeInteger(value.hierarchyNodes) || value.hierarchyNodes <= 0 ||
      !Number.isSafeInteger(value.contentNodes) || value.contentNodes <= 0 || value.contentNodes > value.hierarchyNodes ||
      !Number.isSafeInteger(value.totalPoints) || value.totalPoints <= 0 ||
      !Number.isSafeInteger(value.totalPointDataBytes) || value.totalPointDataBytes <= 0 ||
      value.nodes.length !== value.hierarchyNodes) {
    throw new TypeError('The content-bounds index has inconsistent or unsafe coverage totals.');
  }
}

function normalizeIndexNode(value: Record<string, unknown>): TileHierarchyNode {
  const children = value.children;
  if (!Array.isArray(children) || children.some((child) => typeof child !== 'string')) {
    throw new TypeError('Indexed hierarchy children must be a complete string array.');
  }
  const numbers = [value.level, value.x, value.y, value.z, value.pointCount, value.pointDataOffset, value.pointDataLength];
  if (typeof value.key !== 'string' || value.key.trim() === '' ||
      !numbers.every((number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) ||
      value.childrenComplete !== true) {
    throw new TypeError('The content-bounds index contains an invalid COPC hierarchy node.');
  }
  const [level, x, y, z, pointCount, pointDataOffset, pointDataLength] = numbers as number[];
  return Object.freeze({
    key: value.key,
    level: level!,
    x: x!,
    y: y!,
    z: z!,
    pointCount: pointCount!,
    pointDataOffset: pointDataOffset!,
    pointDataLength: pointDataLength!,
    children: Object.freeze([...children] as string[]),
    childrenComplete: true,
  });
}

function copyNode(node: TileHierarchyNode): TileHierarchyNode {
  return Object.freeze({
    key: node.key,
    level: node.level,
    x: node.x,
    y: node.y,
    z: node.z,
    pointCount: node.pointCount,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
    children: Object.freeze([...(node.children ?? [])]),
    ...(node.childrenComplete === undefined ? {} : { childrenComplete: node.childrenComplete }),
  });
}

function sameNode(left: TileHierarchyNode, right: TileHierarchyNode): boolean {
  return left.key === right.key && left.level === right.level && left.x === right.x && left.y === right.y && left.z === right.z &&
    left.pointCount === right.pointCount && left.pointDataOffset === right.pointDataOffset && left.pointDataLength === right.pointDataLength &&
    left.childrenComplete === right.childrenComplete && JSON.stringify(left.children ?? []) === JSON.stringify(right.children ?? []);
}

function isEcefRecord(value: unknown): value is EcefRecord {
  return isRecord(value) && value.coordinateSystem === 'wgs84-ecef-meters' &&
    ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
    (value.minX as number) <= (value.maxX as number) && (value.minY as number) <= (value.maxY as number) && (value.minZ as number) <= (value.maxZ as number);
}

function isAxisBounds(value: unknown): value is EcefAxisAlignedBounds {
  if (!isRecord(value) || !Array.isArray(value.minimum) || !Array.isArray(value.maximum) ||
      value.minimum.length !== 3 || value.maximum.length !== 3 ||
      ![...value.minimum, ...value.maximum].every((number) => typeof number === 'number' && Number.isFinite(number))) return false;
  const minimum = value.minimum as number[];
  const maximum = value.maximum as number[];
  return minimum[0]! <= maximum[0]! && minimum[1]! <= maximum[1]! && minimum[2]! <= maximum[2]!;
}

function contains(bounds: EcefAxisAlignedBounds, value: EcefRecord): boolean {
  return bounds.minimum[0] <= value.minX && bounds.minimum[1] <= value.minY && bounds.minimum[2] <= value.minZ &&
    bounds.maximum[0] >= value.maxX && bounds.maximum[1] >= value.maxY && bounds.maximum[2] >= value.maxZ;
}

function containsPadding(raw: EcefRecord, padded: EcefAxisAlignedBounds, allowance: number): boolean {
  return padded.minimum[0] <= raw.minX - allowance && padded.minimum[1] <= raw.minY - allowance && padded.minimum[2] <= raw.minZ - allowance &&
    padded.maximum[0] >= raw.maxX + allowance && padded.maximum[1] >= raw.maxY + allowance && padded.maximum[2] >= raw.maxZ + allowance;
}

function copyAxisBounds(bounds: EcefAxisAlignedBounds): EcefAxisAlignedBounds {
  return Object.freeze({
    minimum: Object.freeze([...bounds.minimum]) as unknown as EcefAxisAlignedBounds['minimum'],
    maximum: Object.freeze([...bounds.maximum]) as unknown as EcefAxisAlignedBounds['maximum'],
  });
}

function validateFingerprint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^(?:sha256|http-etag-sha256):[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError('A source fingerprint must be a SHA-256 content hash or an http-etag-sha256 immutable resource-version identity.');
  }
}

function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value) as T;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const canonicalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (isRecord(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonicalize(entry[key])]));
    }
    throw new TypeError('The content-bounds index contains a value that is not JSON-safe.');
  };
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 index integrity requires Web Crypto in a secure context.');
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
