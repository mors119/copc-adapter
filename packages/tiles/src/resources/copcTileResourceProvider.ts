import {
  getFloat32EcefReconstructionErrorBound,
  type TileLocalCoordinateOptions,
} from '../geometry/tileLocalCoordinates.js';
import { encodePointCloudGlb, type PointCloudGlbOptions } from '../gltf/pointCloudGlb.js';
import type { TilePointFieldSelection, TilePointView } from '../input/tilePointView.js';
import {
  createExplicitTileset,
  createPaddedEcefBoundsFromConservativeResult,
  getExplicitTileContentUri,
  type EcefAxisAlignedBounds,
  type ExplicitTilesetOptions,
  type TilesetNodeInput,
} from '../tileset/explicitTileset.js';
import { TileNodeReader } from '../source/tileNodeReader.js';
import type {
  TileConservativeBoundsResult,
  TileConservativeNodeSource,
  TileHierarchyNode,
  TileNodeReaderLimits,
} from '../source/tileNodeSource.js';
import type { TileResourceProvider } from './tileResourceServer.js';

export type CopcTileResourceProviderOptions = Readonly<{
  /** Required explicit authorization to scan and materialize the complete hierarchy. */
  scanCompleteHierarchy: true;
  readerLimits?: TileNodeReaderLimits;
  tilesetOptions?: ExplicitTilesetOptions;
  /** Point fields requested only when a content URI is fetched. */
  selection?: TilePointFieldSelection;
  /** Maximum accepted per-axis-safe Float32 reconstruction padding. */
  maxEncoderPaddingMeters?: number;
  maxGlbBytes?: number;
  maxTilesetBytes?: number;
  maxAbsolutePositionErrorMeters?: number;
  maxRelativePositionError?: number;
  /** The caller owns the source by default. */
  ownsSource?: boolean;
  signal?: AbortSignal;
}>;

export type CopcTileResourceProvider = TileResourceProvider & Readonly<{
  tileset: Readonly<Record<string, unknown>>;
  hierarchyPagesRead: number;
  hierarchyPageBytesRead: number;
}>;

export type CopcTileResourceProviderErrorCode =
  | 'INVALID_SOURCE'
  | 'FULL_HIERARCHY_SCAN_NOT_ENABLED'
  | 'STALE_SOURCE'
  | 'ABORTED'
  | 'UNSUPPORTED_BOUNDS'
  | 'INVALID_CONSERVATIVE_BOUNDS'
  | 'ENCODER_PADDING_LIMIT'
  | 'POINT_OUTSIDE_CONSERVATIVE_BOUNDS'
  | 'ENCODER_PADDING_MISMATCH'
  | 'RESOURCE_LIMIT'
  | 'SOURCE_CLOSED';

export class CopcTileResourceProviderError extends Error {
  readonly code: CopcTileResourceProviderErrorCode;
  readonly nodeKey: string | undefined;
  readonly conservativeBoundsResult: TileConservativeBoundsResult | undefined;

  constructor(
    code: CopcTileResourceProviderErrorCode,
    message: string,
    details: Readonly<{ nodeKey?: string; conservativeBoundsResult?: TileConservativeBoundsResult }> = {},
  ) {
    super(message);
    this.name = 'CopcTileResourceProviderError';
    this.code = code;
    this.nodeKey = details.nodeKey;
    this.conservativeBoundsResult = details.conservativeBoundsResult;
  }
}

type PreparedTileNode = Readonly<{
  node: TileHierarchyNode;
  conservativeBounds: Extract<TileConservativeBoundsResult, { status: 'supported' }>;
  bounds: EcefAxisAlignedBounds;
  originEcef: Float64Array;
  encoderPaddingMeters: number;
}>;

type PendingTileNode = Readonly<{
  node: TileHierarchyNode;
  conservativeBounds: Extract<TileConservativeBoundsResult, { status: 'supported' }>;
  ownEncoderPaddingMeters: number;
}>;

const DEFAULT_MAX_ENCODER_PADDING_METERS = 0.01;
const DEFAULT_MAX_GLB_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TILESET_BYTES = 16 * 1024 * 1024;

/**
 * Build an on-demand explicit Tiles provider over the public, renderer-neutral
 * COPC node-source contract. Creation requires explicit authorization via
 * scanCompleteHierarchy and reads bounded hierarchy metadata and conservative
 * bounds only; point payloads are fetched after a content URI is requested.
 */
export async function createCopcTileResourceProvider(
  source: TileConservativeNodeSource,
  options: CopcTileResourceProviderOptions,
): Promise<CopcTileResourceProvider> {
  validateOptions(options);
  validateSource(source);
  assertNotAborted(options.signal);

  const sourceIdentity = source.sourceIdentity;
  const sourceGeneration = source.sourceGeneration;
  const sourceTransformGeneration = source.transformGeneration;
  const reader = new TileNodeReader(source, options.readerLimits);
  const maxEncoderPaddingMeters = options.maxEncoderPaddingMeters ?? DEFAULT_MAX_ENCODER_PADDING_METERS;
  const pendingNodes = new Map<string, PendingTileNode>();
  const preparedNodes = new Map<string, PreparedTileNode>();
  const tilesetInputs: TilesetNodeInput[] = [];
  let expectedSourceGeneration = source.sourceGeneration;

  const prepareNodeBounds = (node: TileHierarchyNode): void => {
    assertNotAborted(options.signal);
    assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
    const result = source.getConservativeNodeEcefBounds(node.key);
    validateConservativeResult(result, source, node.key, expectedSourceGeneration);
    if (expectedSourceGeneration === undefined) expectedSourceGeneration = result.sourceGeneration;
    assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
    if (result.status === 'unsupported') {
      throw new CopcTileResourceProviderError(
        'UNSUPPORTED_BOUNDS',
        `Node ${node.key} cannot be used in a conservative Tileset (${result.reasonCode}): ${result.reason}`,
        { nodeKey: node.key, conservativeBoundsResult: result },
      );
    }
    const rawBounds = resultBounds(result);
    const ownEncoderPaddingMeters = node.pointCount > 0
      ? getFloat32EcefReconstructionErrorBound(rawBounds)
      : 0;
    if (node.pointCount > 0 && ownEncoderPaddingMeters > maxEncoderPaddingMeters) {
      throw new CopcTileResourceProviderError(
        'ENCODER_PADDING_LIMIT',
        `Node ${node.key} needs ${ownEncoderPaddingMeters} m of Float32 reconstruction padding; configured limit is ${maxEncoderPaddingMeters} m.`,
        { nodeKey: node.key, conservativeBoundsResult: result },
      );
    }
    pendingNodes.set(node.key, Object.freeze({ node, conservativeBounds: result, ownEncoderPaddingMeters }));
  };
  const hierarchy = await reader.readHierarchy({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onNode: prepareNodeBounds,
  });

  assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
  const propagatedPadding = new Map<string, number>();
  for (const node of [...hierarchy.nodes].sort((left, right) => right.level - left.level)) {
    const pending = pendingNodes.get(node.key);
    if (!pending) {
      throw new CopcTileResourceProviderError('INVALID_CONSERVATIVE_BOUNDS', `Node ${node.key} has no validated conservative bounds.`, { nodeKey: node.key });
    }
    let padding = pending.ownEncoderPaddingMeters;
    for (const childKey of node.children ?? []) {
      padding = Math.max(padding, propagatedPadding.get(childKey) ?? 0);
    }
    propagatedPadding.set(node.key, padding);
  }
  for (const node of hierarchy.nodes) {
    const pending = pendingNodes.get(node.key);
    if (!pending) continue;
    const encoderPaddingMeters = propagatedPadding.get(node.key) ?? pending.ownEncoderPaddingMeters;
    const bounds = createPaddedEcefBoundsFromConservativeResult(pending.conservativeBounds, encoderPaddingMeters);
    const prepared = Object.freeze({
      node,
      conservativeBounds: pending.conservativeBounds,
      bounds,
      originEcef: centerOf(bounds),
      encoderPaddingMeters,
    });
    preparedNodes.set(node.key, prepared);
    tilesetInputs.push({ node, bounds });
  }
  const tileset = createExplicitTileset(tilesetInputs, options.tilesetOptions);
  const tilesetBytes = new TextEncoder().encode(JSON.stringify(tileset));
  if (tilesetBytes.byteLength > (options.maxTilesetBytes ?? DEFAULT_MAX_TILESET_BYTES)) {
    throw new CopcTileResourceProviderError('RESOURCE_LIMIT', 'Generated tileset.json exceeds its configured byte limit.');
  }

  const contentByUri = new Map<string, PreparedTileNode>();
  for (const prepared of preparedNodes.values()) {
    if (prepared.node.pointCount > 0) contentByUri.set(getExplicitTileContentUri(prepared.node.key), prepared);
  }
  const lifecycle = new AbortController();
  const generation = expectedSourceGeneration ?? sourceTransformGeneration;
  let closed = false;

  const isCurrent = (): boolean => !closed &&
    source.sourceIdentity === sourceIdentity &&
    source.transformGeneration === sourceTransformGeneration &&
    source.sourceGeneration === sourceGeneration &&
    (source.sourceGeneration === undefined || source.sourceGeneration === expectedSourceGeneration) &&
    (source.isCurrent?.() ?? true);

  const provider: CopcTileResourceProvider = Object.freeze({
    sourceIdentity,
    generation,
    isCurrent,
    tileset,
    hierarchyPagesRead: hierarchy.hierarchyPagesRead,
    hierarchyPageBytesRead: hierarchy.hierarchyPageBytesRead,
    getResource: async (uri: string, signal: AbortSignal): Promise<Uint8Array | undefined> => {
      if (closed) throw new CopcTileResourceProviderError('SOURCE_CLOSED', 'COPC Tiles resource provider is closed.');
      const operation = combineSignals(signal, lifecycle.signal);
      try {
        assertNotAborted(operation.signal);
        assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
        if (uri === 'tileset.json') return tilesetBytes.slice();
        const prepared = contentByUri.get(uri);
        if (!prepared) return undefined;
        const view = await reader.readNode(prepared.node, options.selection, { signal: operation.signal });
        assertNotAborted(operation.signal);
        assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
        if (expectedSourceGeneration !== undefined && view.context.sourceGeneration !== expectedSourceGeneration) {
          throw new CopcTileResourceProviderError(
            'STALE_SOURCE',
            `Node ${prepared.node.key} point data belongs to source generation ${String(view.context.sourceGeneration)}; conservative bounds belong to generation ${expectedSourceGeneration}.`,
            { nodeKey: prepared.node.key, conservativeBoundsResult: prepared.conservativeBounds },
          );
        }
        assertPointsWithinBounds(view, prepared.conservativeBounds, prepared.node.key);
        const encoded = encodePointCloudGlb(view, encoderOptions(options, prepared));
        if (!encoded) return undefined;
        if (encoded.maxAbsoluteErrorMeters > prepared.encoderPaddingMeters) {
          throw new CopcTileResourceProviderError(
            'ENCODER_PADDING_MISMATCH',
            `Node ${prepared.node.key} Float32 error ${encoded.maxAbsoluteErrorMeters} m exceeds its certified bound padding ${prepared.encoderPaddingMeters} m.`,
            { nodeKey: prepared.node.key, conservativeBoundsResult: prepared.conservativeBounds },
          );
        }
        return encoded.bytes;
      } finally {
        operation.dispose();
      }
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      lifecycle.abort();
      if (options.ownsSource) await source.close?.();
    },
  });
  return provider;
}

function validateSource(source: TileConservativeNodeSource): void {
  if (
    !source || typeof source !== 'object' || typeof source.sourceIdentity !== 'string' || source.sourceIdentity.trim() === '' ||
    (source.conservativeBoundsSourceIdentity !== undefined && (typeof source.conservativeBoundsSourceIdentity !== 'string' || source.conservativeBoundsSourceIdentity.trim() === '')) ||
    !Number.isSafeInteger(source.transformGeneration) || source.transformGeneration < 0 ||
    (source.sourceGeneration !== undefined && (!Number.isSafeInteger(source.sourceGeneration) || source.sourceGeneration < 0)) ||
    typeof source.getRootHierarchyPage !== 'function' || typeof source.loadHierarchyPage !== 'function' ||
    typeof source.loadNode !== 'function' || typeof source.getConservativeNodeEcefBounds !== 'function'
  ) {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'A current public conservative COPC node source is required.');
  }
  if (source.isCurrent?.() === false) {
    throw new CopcTileResourceProviderError('STALE_SOURCE', 'COPC source is already stale.');
  }
}

function validateOptions(options: CopcTileResourceProviderOptions): void {
  if (!options || typeof options !== 'object') {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'Provider options must be an object.');
  }
  if (options.scanCompleteHierarchy !== true) {
    throw new CopcTileResourceProviderError(
      'FULL_HIERARCHY_SCAN_NOT_ENABLED',
      'Set scanCompleteHierarchy: true to authorize the bounded full metadata scan required by an explicit Tileset.',
    );
  }
  const maxPadding = options.maxEncoderPaddingMeters ?? DEFAULT_MAX_ENCODER_PADDING_METERS;
  const maxGlbBytes = options.maxGlbBytes ?? DEFAULT_MAX_GLB_BYTES;
  const maxTilesetBytes = options.maxTilesetBytes ?? DEFAULT_MAX_TILESET_BYTES;
  if (
    !Number.isFinite(maxPadding) || maxPadding < 0 || maxPadding > 100 ||
    !Number.isSafeInteger(maxGlbBytes) || maxGlbBytes <= 0 || maxGlbBytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(maxTilesetBytes) || maxTilesetBytes <= 0 || maxTilesetBytes > 128 * 1024 * 1024 ||
    (options.maxAbsolutePositionErrorMeters !== undefined && (!Number.isFinite(options.maxAbsolutePositionErrorMeters) || options.maxAbsolutePositionErrorMeters < 0)) ||
    (options.maxRelativePositionError !== undefined && (!Number.isFinite(options.maxRelativePositionError) || options.maxRelativePositionError < 0)) ||
    (options.ownsSource !== undefined && typeof options.ownsSource !== 'boolean')
  ) {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'Provider resource and precision limits must be finite and within their documented bounds.');
  }
}

function validateConservativeResult(
  value: TileConservativeBoundsResult,
  source: TileConservativeNodeSource,
  nodeKey: string,
  expectedSourceGeneration: number | undefined,
): void {
  if (!value || typeof value !== 'object') {
    throw new CopcTileResourceProviderError('INVALID_CONSERVATIVE_BOUNDS', 'Conservative source returned a non-object result.', { nodeKey });
  }
  const sourceCell = value.sourceCellBounds;
  const expectedBoundsSourceIdentity = source.conservativeBoundsSourceIdentity ?? source.sourceIdentity;
  if (
    value.nodeKey !== nodeKey || value.sourceIdentity !== expectedBoundsSourceIdentity ||
    !Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration < 0 ||
    (expectedSourceGeneration !== undefined && value.sourceGeneration !== expectedSourceGeneration) ||
    value.transformGeneration !== source.transformGeneration ||
    typeof value.transformPlanIdentity !== 'string' || value.transformPlanIdentity.trim() === '' ||
    value.sourceCoordinateSystem !== 'copc-source' || !Number.isFinite(value.heightOffsetMeters) ||
    !validBoundsRecord(sourceCell) ||
    (source.getNodeCellBounds !== undefined && !sameSourceBounds(sourceCell, source.getNodeCellBounds(nodeKey)))
  ) {
    throw new CopcTileResourceProviderError('INVALID_CONSERVATIVE_BOUNDS', 'Conservative bounds have mismatched node, source, generation, transform, or source-cell provenance.', { nodeKey });
  }
  if (value.status === 'unsupported') {
    if (typeof value.reasonCode !== 'string' || !value.reasonCode || typeof value.reason !== 'string' || !value.reason.trim() || 'boundsEcef' in value) {
      throw new CopcTileResourceProviderError('INVALID_CONSERVATIVE_BOUNDS', 'Unsupported conservative bounds must retain an exact reason and must not contain fallback ECEF bounds.', { nodeKey });
    }
    return;
  }
  if (
    value.status !== 'supported' || value.boundsEcef?.coordinateSystem !== 'wgs84-ecef-meters' ||
    !validBoundsRecord(value.boundsEcef) ||
    value.coverage !== 'full-source-cell-and-descendant-cells' ||
    value.method !== 'wgs84-geodetic-interval-v1' || value.verification !== 'analytic-interval' ||
    (value.verticalReference !== 'ellipsoidal' && value.verticalReference !== 'validated-grid') ||
    !Number.isFinite(value.sourceVerticalUnitToMeters) || value.sourceVerticalUnitToMeters <= 0 ||
    value.encoderErrorPaddingRequired !== true || !Array.isArray(value.assumptions) ||
    value.assumptions.some((assumption) => typeof assumption !== 'string') ||
    (value.verticalGrid !== undefined && (value.verticalGrid.compatibility !== 'validated' || value.verticalGrid.noDataValue !== null))
  ) {
    throw new CopcTileResourceProviderError('INVALID_CONSERVATIVE_BOUNDS', 'Supported conservative bounds are malformed or lack full-cell and encoder-padding certification.', { nodeKey });
  }
}

type NumericBoundsRecord = Readonly<{ minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }>;

function validBoundsRecord(value: unknown): value is NumericBoundsRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const bounds = value as Record<string, unknown>;
  const numbers = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ];
  return numbers.every((item) => typeof item === 'number' && Number.isFinite(item)) &&
    (bounds.minX as number) <= (bounds.maxX as number) &&
    (bounds.minY as number) <= (bounds.maxY as number) &&
    (bounds.minZ as number) <= (bounds.maxZ as number);
}

function sameSourceBounds(
  actual: TileConservativeBoundsResult['sourceCellBounds'],
  expected: ReturnType<NonNullable<TileConservativeNodeSource['getNodeCellBounds']>>,
): boolean {
  return actual.minX === expected.minX && actual.minY === expected.minY && actual.minZ === expected.minZ &&
    actual.maxX === expected.maxX && actual.maxY === expected.maxY && actual.maxZ === expected.maxZ;
}

function resultBounds(result: Extract<TileConservativeBoundsResult, { status: 'supported' }>): EcefAxisAlignedBounds {
  return {
    minimum: [result.boundsEcef.minX, result.boundsEcef.minY, result.boundsEcef.minZ],
    maximum: [result.boundsEcef.maxX, result.boundsEcef.maxY, result.boundsEcef.maxZ],
  };
}

function centerOf(bounds: EcefAxisAlignedBounds): Float64Array {
  return new Float64Array(bounds.minimum.map((minimum, axis) => minimum + (bounds.maximum[axis] - minimum) / 2));
}

function assertPointsWithinBounds(
  view: TilePointView,
  result: Extract<TileConservativeBoundsResult, { status: 'supported' }>,
  nodeKey: string,
): void {
  const bounds = result.boundsEcef;
  const minimums = [bounds.minX, bounds.minY, bounds.minZ];
  const maximums = [bounds.maxX, bounds.maxY, bounds.maxZ];
  for (let point = 0; point < view.pointCount; point += 1) {
    const index = point * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = view.ecef[index + axis];
      const minimum = minimums[axis];
      const maximum = maximums[axis];
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(minimum), Math.abs(maximum), Math.abs(value)) * 8;
      if (value < minimum - tolerance || value > maximum + tolerance) {
        throw new CopcTileResourceProviderError(
          'POINT_OUTSIDE_CONSERVATIVE_BOUNDS',
          `Decoded point ${point} on axis ${axis} lies outside Adapter's conservative source-cell bound.`,
          { nodeKey, conservativeBoundsResult: result },
        );
      }
    }
  }
}

function encoderOptions(
  options: CopcTileResourceProviderOptions,
  prepared: PreparedTileNode,
): PointCloudGlbOptions {
  const precision: TileLocalCoordinateOptions = {
    originEcef: prepared.originEcef,
    maxAbsoluteErrorMeters: Math.min(options.maxAbsolutePositionErrorMeters ?? prepared.encoderPaddingMeters, prepared.encoderPaddingMeters),
    ...(options.maxRelativePositionError === undefined ? {} : { maxRelativeError: options.maxRelativePositionError }),
  };
  return {
    ...(options.readerLimits?.maxPointsPerNode === undefined ? {} : { maxPoints: options.readerLimits.maxPointsPerNode }),
    maxOutputBytes: options.maxGlbBytes ?? DEFAULT_MAX_GLB_BYTES,
    precision,
  };
}

function combineSignals(request: AbortSignal, lifecycle: AbortSignal): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const controller = new AbortController();
  const relay = (signal: AbortSignal): void => controller.abort(signal.reason);
  const onRequest = (): void => relay(request);
  const onLifecycle = (): void => relay(lifecycle);
  if (request.aborted) onRequest();
  else request.addEventListener('abort', onRequest, { once: true });
  if (lifecycle.aborted) onLifecycle();
  else lifecycle.addEventListener('abort', onLifecycle, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      request.removeEventListener('abort', onRequest);
      lifecycle.removeEventListener('abort', onLifecycle);
    },
  });
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CopcTileResourceProviderError('ABORTED', 'COPC Tiles provider construction or resource request was cancelled.');
  }
}

function assertSourceCurrent(
  source: TileConservativeNodeSource,
  sourceIdentity: string,
  sourceGeneration: number | undefined,
  expectedSourceGeneration: number | undefined,
  transformGeneration: number,
): void {
  if (
    source.sourceIdentity !== sourceIdentity || source.transformGeneration !== transformGeneration ||
    (sourceGeneration !== undefined && source.sourceGeneration !== sourceGeneration) ||
    (expectedSourceGeneration !== undefined && source.sourceGeneration !== undefined && source.sourceGeneration !== expectedSourceGeneration) ||
    source.isCurrent?.() === false
  ) {
    throw new CopcTileResourceProviderError('STALE_SOURCE', 'COPC source changed while its Tiles resources were being prepared.');
  }
}
