import {
  getFloat32EcefReconstructionErrorBound,
  type TileLocalCoordinateOptions,
} from '../geometry/tileLocalCoordinates.js';
import { encodePointCloudGlb, type PointCloudGlbOptions } from '../gltf/pointCloudGlb.js';
import type {
  TilePointFieldSelection,
  TilePointView,
  TileSourceCrsEvidence,
  TileVerticalDatumEvidence,
} from '../input/tilePointView.js';
import {
  EXPLICIT_TILESET_DEFAULT_LIMITS,
  EXPLICIT_TILESET_HARD_LIMITS,
  createExplicitTileset,
  createPaddedEcefBoundsFromConservativeResult,
  getExplicitTileContentUri,
  type EcefAxisAlignedBounds,
  type ExplicitTilesetOptions,
  type TilesetNodeInput,
} from '../tileset/explicitTileset.js';
import {
  resolveTileNodeReaderLimits,
  TileNodeReader,
  TILE_NODE_READER_DEFAULT_LIMITS,
  type ResolvedTileNodeReaderLimits,
} from '../source/tileNodeReader.js';
import type {
  TileConservativeBoundsResult,
  TileConservativeNodeSource,
  TileHierarchyNode,
  TileNodeSource,
  TileNodeReaderLimits,
} from '../source/tileNodeSource.js';
import type { TileResourceProvider } from './tileResourceServer.js';

type CopcTileResourceProviderBaseOptions = Readonly<{
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

export type DecodedContentBoundsProvenance = Readonly<{
  strategy: 'decoded-content';
  nodeKey: string;
  sourceIdentity: string;
  sourceGeneration: number;
  transformGeneration: number;
  transformPlanIdentity: string;
  coordinateSystem: 'wgs84-ecef-meters';
  /** Tight envelope of every prepared ECEF point in this content node. */
  contentBoundsEcef: Readonly<{
    coordinateSystem: 'wgs84-ecef-meters';
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }>;
  /** Per-content Float32 reconstruction envelope and proven padding. */
  paddedContentBoundsEcef: EcefAxisAlignedBounds;
  encoderPaddingMeters: number;
  coverage: 'all-points-in-node';
  pointCount: number;
  scannedPointCount: number;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  verticalPlacement: 'verified' | 'unverified';
  heightOffsetMeters: number;
}>;

export type DecodedContentScanProgress = Readonly<{
  phase: 'hierarchy' | 'preflight' | 'points' | 'complete';
  hierarchyNodes: number;
  hierarchyPages: number;
  hierarchyPageBytes: number;
  contentNodes: number;
  scannedNodes: number;
  totalPoints: number;
  scannedPoints: number;
  totalPointDataBytes: number;
  decodedEcefBytesScanned: number;
  peakDecodedEcefBufferBytes: number;
  elapsedMilliseconds: number;
  transformPlanIdentity?: string;
  sourceCrs?: TileSourceCrsEvidence;
  verticalDatum?: TileVerticalDatumEvidence;
}>;

export type DecodedContentScanSummary = Readonly<{
  strategy: 'decoded-content';
  status: 'complete';
  coverage: 'all-content-points-in-complete-hierarchy';
  sourceIdentity: string;
  sourceGeneration: number;
  transformGeneration: number;
  transformPlanIdentity: string;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  verticalPlacement: 'verified' | 'unverified';
  hierarchyNodes: number;
  hierarchyPages: number;
  hierarchyPageBytes: number;
  tilesetNodes: number;
  contentNodes: number;
  emptyNodes: number;
  emptyNodesOmittedFromTileset: number;
  totalPoints: number;
  scannedPoints: number;
  totalPointDataBytes: number;
  decodedEcefBytesScanned: number;
  peakDecodedEcefBufferBytes: number;
  scanDurationMilliseconds: number;
  metadataOnlySourceCellStatus?: 'supported' | 'unsupported';
  metadataOnlySourceCellReasonCode?: string;
  metadataOnlySourceCellReason?: string;
  /** Per-content-node envelopes and provenance; no decoded point buffers are retained. */
  contentBounds: readonly DecodedContentBoundsProvenance[];
}>;

export type ConservativeSourceCellProviderOptions = CopcTileResourceProviderBaseOptions & Readonly<{
  /** Existing fast path; omitted means `conservative-source-cell`. */
  boundsStrategy?: 'conservative-source-cell';
  allowDecodedContentBounds?: never;
  onDecodedContentProgress?: never;
}>;

export type DecodedContentProviderOptions = CopcTileResourceProviderBaseOptions & Readonly<{
  /** Explicitly opt into a complete, bounded scan of all rendered points. */
  boundsStrategy: 'decoded-content';
  /** Required explicit authorization; this strategy is never the default. */
  allowDecodedContentBounds: true;
  onDecodedContentProgress?: (progress: DecodedContentScanProgress) => void;
}>;

export type CopcTileResourceProviderOptions = ConservativeSourceCellProviderOptions | DecodedContentProviderOptions;

export type CopcTileResourceProvider = TileResourceProvider & Readonly<{
  tileset: Readonly<Record<string, unknown>>;
  hierarchyPagesRead: number;
  hierarchyPageBytesRead: number;
  boundsStrategy: 'conservative-source-cell' | 'decoded-content';
  decodedContentScan?: DecodedContentScanSummary;
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
  | 'CONTENT_SCAN_NOT_AUTHORIZED'
  | 'CONTENT_SCAN_LIMIT'
  | 'CONTENT_SCAN_INVALID'
  | 'POINT_OUTSIDE_DECODED_BOUNDS'
  | 'ENCODER_PADDING_MISMATCH'
  | 'RESOURCE_LIMIT'
  | 'SOURCE_CLOSED';

export class CopcTileResourceProviderError extends Error {
  readonly code: CopcTileResourceProviderErrorCode;
  readonly nodeKey: string | undefined;
  readonly conservativeBoundsResult: TileConservativeBoundsResult | undefined;
  readonly decodedContentBounds: DecodedContentBoundsProvenance | undefined;

  constructor(
    code: CopcTileResourceProviderErrorCode,
    message: string,
    details: Readonly<{
      nodeKey?: string;
      conservativeBoundsResult?: TileConservativeBoundsResult;
      decodedContentBounds?: DecodedContentBoundsProvenance;
    }> = {},
  ) {
    super(message);
    this.name = 'CopcTileResourceProviderError';
    this.code = code;
    this.nodeKey = details.nodeKey;
    this.conservativeBoundsResult = details.conservativeBoundsResult;
    this.decodedContentBounds = details.decodedContentBounds;
  }
}

type ConservativePreparedTileNode = Readonly<{
  node: TileHierarchyNode;
  conservativeBounds: Extract<TileConservativeBoundsResult, { status: 'supported' }>;
  bounds: EcefAxisAlignedBounds;
  originEcef: Float64Array;
  encoderPaddingMeters: number;
}>;

type DecodedPreparedTileNode = Readonly<{
  /** Original hierarchy identity used when re-reading source content. */
  node: TileHierarchyNode;
  /** Pruned child links used only to construct the spatial Tileset. */
  tilesetNode: TileHierarchyNode;
  decodedContentBounds?: DecodedContentBoundsProvenance;
  contentBounds?: EcefAxisAlignedBounds;
  bounds: EcefAxisAlignedBounds;
  originEcef: Float64Array;
  encoderPaddingMeters: number;
}>;

type PreparedTileNode = ConservativePreparedTileNode | DecodedPreparedTileNode;

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
export function createCopcTileResourceProvider(
  source: TileConservativeNodeSource,
  options: ConservativeSourceCellProviderOptions,
): Promise<CopcTileResourceProvider>;
export function createCopcTileResourceProvider(
  source: TileNodeSource,
  options: DecodedContentProviderOptions,
): Promise<CopcTileResourceProvider>;
export function createCopcTileResourceProvider(
  source: TileNodeSource,
  options: CopcTileResourceProviderOptions,
): Promise<CopcTileResourceProvider>;
export async function createCopcTileResourceProvider(
  source: TileNodeSource,
  options: CopcTileResourceProviderOptions,
): Promise<CopcTileResourceProvider> {
  validateOptions(options);
  assertNotAborted(options.signal);

  if (options.boundsStrategy === 'decoded-content') {
    return createDecodedContentProvider(source, options);
  }
  validateSource(source as TileConservativeNodeSource);
  return createConservativeSourceCellProvider(source as TileConservativeNodeSource, options);
}

async function createConservativeSourceCellProvider(
  source: TileConservativeNodeSource,
  options: ConservativeSourceCellProviderOptions,
): Promise<CopcTileResourceProvider> {
  validateSource(source);

  const sourceIdentity = source.sourceIdentity;
  const sourceGeneration = source.sourceGeneration;
  const sourceTransformGeneration = source.transformGeneration;
  const reader = new TileNodeReader(source, options.readerLimits);
  const maxEncoderPaddingMeters = options.maxEncoderPaddingMeters ?? DEFAULT_MAX_ENCODER_PADDING_METERS;
  const pendingNodes = new Map<string, PendingTileNode>();
  const preparedNodes = new Map<string, ConservativePreparedTileNode>();
  const tilesetInputs: TilesetNodeInput[] = [];
  let expectedSourceGeneration = source.sourceGeneration;

  const prepareNodeBounds = (node: TileHierarchyNode): void => {
    assertNotAborted(options.signal);
    assertSourceCurrent(source, sourceIdentity, sourceGeneration, expectedSourceGeneration, sourceTransformGeneration);
    const prior = pendingNodes.get(node.key);
    if (prior) {
      // Adapter's public hierarchy loader first exposes the root page for an
      // early conservative-CRS check, then returns its child-complete form.
      // Keep the validated bounds and replace only that hierarchy snapshot.
      pendingNodes.set(node.key, Object.freeze({ ...prior, node }));
      return;
    }
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
    onRootNode: prepareNodeBounds,
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

  const contentByUri = new Map<string, ConservativePreparedTileNode>();
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
    boundsStrategy: 'conservative-source-cell',
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
        assertPointsWithinConservativeBounds(view, prepared.conservativeBounds, prepared.node.key);
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

async function createDecodedContentProvider(
  source: TileNodeSource,
  options: DecodedContentProviderOptions,
): Promise<CopcTileResourceProvider> {
  validateDecodedSource(source);
  const sourceIdentity = source.sourceIdentity;
  const sourceGeneration = source.sourceGeneration!;
  const transformGeneration = source.transformGeneration;
  const limits = resolveTileNodeReaderLimits(options.readerLimits);
  const reader = new TileNodeReader(source, options.readerLimits);
  const startedAt = performanceNow();
  const discovered = new Set<string>();
  const reportProgress = (
    phase: DecodedContentScanProgress['phase'],
    values: Partial<DecodedContentScanProgress> = {},
  ): void => {
    options.onDecodedContentProgress?.(Object.freeze({
      phase,
      hierarchyNodes: discovered.size,
      hierarchyPages: 0,
      hierarchyPageBytes: 0,
      contentNodes: 0,
      scannedNodes: 0,
      totalPoints: 0,
      scannedPoints: 0,
      totalPointDataBytes: 0,
      decodedEcefBytesScanned: 0,
      peakDecodedEcefBufferBytes: 0,
      elapsedMilliseconds: Math.max(0, performanceNow() - startedAt),
      ...values,
    }));
  };
  const hierarchy = await reader.readHierarchy({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onNode: (node) => {
      discovered.add(node.key);
      reportProgress('hierarchy');
    },
  });
  assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
  validateDecodedContentHierarchy(hierarchy.nodes);

  const effectiveLimits = preflightDecodedContentHierarchy(hierarchy.nodes, limits, options.tilesetOptions);
  const contentNodes = hierarchy.nodes.filter((node) => node.pointCount > 0);
  if (contentNodes.length === 0 || effectiveLimits.totalPoints === 0) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      'Decoded-content bounds require at least one content-bearing node with prepared point positions.',
    );
  }
  reportProgress('preflight', {
    hierarchyNodes: hierarchy.nodes.length,
    hierarchyPages: hierarchy.hierarchyPagesRead,
    hierarchyPageBytes: hierarchy.hierarchyPageBytesRead,
    contentNodes: contentNodes.length,
    totalPoints: effectiveLimits.totalPoints,
    totalPointDataBytes: effectiveLimits.totalPointDataBytes,
  });

  const ownContentBounds = new Map<string, EcefAxisAlignedBounds>();
  const ownProvenance = new Map<string, Omit<DecodedContentBoundsProvenance, 'encoderPaddingMeters' | 'paddedContentBoundsEcef'>>();
  let commonProvenance: Readonly<{
    transformPlanIdentity: string;
    sourceCrs: TileSourceCrsEvidence;
    verticalDatum: TileVerticalDatumEvidence;
    heightOffsetMeters: number;
  }> | undefined;
  let scannedPoints = 0;
  let decodedEcefBytesScanned = 0;
  let peakDecodedEcefBufferBytes = 0;
  let scannedNodes = 0;

  for (const node of contentNodes) {
    assertNotAborted(options.signal);
    assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
    const scanned = await scanDecodedContentNode(reader, source, node, sourceGeneration, transformGeneration, options.signal);
    if (!commonProvenance) commonProvenance = scanned.provenance;
    else if (!sameDecodedSourceProvenance(commonProvenance, scanned.provenance)) {
      throw new CopcTileResourceProviderError(
        'CONTENT_SCAN_INVALID',
        `Node ${node.key} returned a different source CRS, vertical reference, or transform plan from the rest of this source scan.`,
        { nodeKey: node.key },
      );
    }
    ownContentBounds.set(node.key, scanned.bounds);
    ownProvenance.set(node.key, Object.freeze({
      strategy: 'decoded-content',
      nodeKey: node.key,
      sourceIdentity,
      sourceGeneration,
      transformGeneration,
      transformPlanIdentity: scanned.provenance.transformPlanIdentity,
      coordinateSystem: 'wgs84-ecef-meters',
      contentBoundsEcef: toEcefBoundsRecord(scanned.bounds),
      coverage: 'all-points-in-node',
      pointCount: node.pointCount,
      scannedPointCount: scanned.pointCount,
      sourceCrs: scanned.provenance.sourceCrs,
      verticalDatum: scanned.provenance.verticalDatum,
      verticalPlacement: scanned.provenance.verticalDatum.status === 'verified' ? 'verified' : 'unverified',
      heightOffsetMeters: scanned.provenance.heightOffsetMeters,
    }));
    scannedNodes += 1;
    scannedPoints += scanned.pointCount;
    decodedEcefBytesScanned += scanned.ecefByteLength;
    peakDecodedEcefBufferBytes = Math.max(peakDecodedEcefBufferBytes, scanned.ecefByteLength);
    assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
    reportProgress('points', {
      hierarchyNodes: hierarchy.nodes.length,
      hierarchyPages: hierarchy.hierarchyPagesRead,
      hierarchyPageBytes: hierarchy.hierarchyPageBytesRead,
      contentNodes: contentNodes.length,
      scannedNodes,
      totalPoints: effectiveLimits.totalPoints,
      scannedPoints,
      totalPointDataBytes: effectiveLimits.totalPointDataBytes,
      decodedEcefBytesScanned,
      peakDecodedEcefBufferBytes,
      transformPlanIdentity: commonProvenance.transformPlanIdentity,
      sourceCrs: commonProvenance.sourceCrs,
      verticalDatum: commonProvenance.verticalDatum,
    });
  }

  if (!commonProvenance || scannedNodes !== contentNodes.length || scannedPoints !== effectiveLimits.totalPoints) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      `Decoded-content scan accounted for ${scannedPoints}/${effectiveLimits.totalPoints} points across ${scannedNodes}/${contentNodes.length} content nodes.`,
    );
  }

  const maxEncoderPaddingMeters = options.maxEncoderPaddingMeters ?? DEFAULT_MAX_ENCODER_PADDING_METERS;
  const subtreeRawBounds = new Map<string, EcefAxisAlignedBounds>();
  const subtreeTileBounds = new Map<string, EcefAxisAlignedBounds>();
  const preparedNodes = new Map<string, DecodedPreparedTileNode>();
  const includedNodeKeys = new Set<string>();
  const completedContentBounds = new Map<string, DecodedContentBoundsProvenance>();
  const tilesetInputs: TilesetNodeInput[] = [];

  for (const node of [...hierarchy.nodes].sort((left, right) => right.level - left.level)) {
    const includedChildren = (node.children ?? []).filter((childKey) => includedNodeKeys.has(childKey));
    // Empty terminal branches contain no rendered points and have no valid
    // content envelope to place. Account for them in the scan summary but
    // omit them from the spatial Tileset instead of inventing an ECEF box.
    if (node.pointCount === 0 && includedChildren.length === 0) continue;
    let rawBounds = ownContentBounds.get(node.key);
    let volumeBounds = ownContentBounds.get(node.key);
    for (const childKey of includedChildren) {
      const childRaw = subtreeRawBounds.get(childKey);
      const childVolume = subtreeTileBounds.get(childKey);
      if (!childRaw || !childVolume) {
        throw new CopcTileResourceProviderError(
          'CONTENT_SCAN_INVALID',
          `Node ${node.key} references child ${childKey}, but that child's content and Tileset bounds were not finalized.`,
          { nodeKey: node.key },
        );
      }
      rawBounds = rawBounds ? unionBounds(rawBounds, childRaw) : childRaw;
      volumeBounds = volumeBounds ? unionBounds(volumeBounds, childVolume) : childVolume;
    }
    rawBounds ??= zeroBounds();
    volumeBounds ??= rawBounds;
    subtreeRawBounds.set(node.key, rawBounds);

    const nodeEncoderPadding = node.pointCount > 0
      ? getFloat32EcefReconstructionErrorBound(volumeBounds)
      : 0;
    if (node.pointCount > 0 && nodeEncoderPadding > maxEncoderPaddingMeters) {
      const result = withContentPadding(ownProvenance.get(node.key), nodeEncoderPadding);
      throw new CopcTileResourceProviderError(
        'ENCODER_PADDING_LIMIT',
        `Node ${node.key} needs ${nodeEncoderPadding} m of Float32 reconstruction padding; configured limit is ${maxEncoderPaddingMeters} m.`,
        { nodeKey: node.key, ...(result === undefined ? {} : { decodedContentBounds: result }) },
      );
    }
    // Child volumes are already finalized, including their Float32 allowance.
    // Expand the union by this node's own GLB allowance, then honor the 3D
    // Tiles minimum half extent while keeping the box centered on its bound.
    const bounds = ensureMinimumHalfExtent(expandBounds(volumeBounds, nodeEncoderPadding));
    subtreeTileBounds.set(node.key, bounds);
    const contentBounds = ownContentBounds.get(node.key);
    const ownBounds = ownProvenance.get(node.key);
    const decodedContentBounds = ownBounds
      ? withContentPadding(ownBounds, nodeEncoderPadding)
      : undefined;
    if (decodedContentBounds) completedContentBounds.set(node.key, decodedContentBounds);
    const tilesetNode = Object.freeze({ ...node, children: Object.freeze(includedChildren) });
    const prepared: DecodedPreparedTileNode = Object.freeze({
      node,
      tilesetNode,
      ...(decodedContentBounds === undefined ? {} : { decodedContentBounds }),
      ...(contentBounds === undefined ? {} : { contentBounds }),
      bounds,
      originEcef: centerOf(bounds),
      encoderPaddingMeters: nodeEncoderPadding,
    });
    includedNodeKeys.add(node.key);
    preparedNodes.set(node.key, prepared);
    tilesetInputs.push({ node: prepared.tilesetNode, bounds });
  }

  assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
  const tilesetOptions = {
    ...options.tilesetOptions,
    maxNodes: effectiveLimits.maxNodes,
    maxTotalPoints: effectiveLimits.maxTotalPoints,
  };
  const generatedTileset = createExplicitTileset(tilesetInputs, tilesetOptions);
  const rootKey = hierarchy.nodes.find((node) => node.level === 0 && node.x === 0 && node.y === 0 && node.z === 0)?.key;
  const generatedRoot = (generatedTileset as { root?: Record<string, unknown> }).root;
  if (!rootKey || !generatedRoot) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', 'Complete hierarchy did not produce a single level-zero Tileset root.');
  }
  const decoratedRoot = decorateDecodedContentTile(
    generatedRoot,
    rootKey,
    preparedNodes,
    subtreeRawBounds,
    subtreeTileBounds,
    commonProvenance,
    sourceIdentity,
    sourceGeneration,
    transformGeneration,
  );
  const decodedContentScan: DecodedContentScanSummary = Object.freeze({
    strategy: 'decoded-content',
    status: 'complete',
    coverage: 'all-content-points-in-complete-hierarchy',
    sourceIdentity,
    sourceGeneration,
    transformGeneration,
    transformPlanIdentity: commonProvenance.transformPlanIdentity,
    sourceCrs: commonProvenance.sourceCrs,
    verticalDatum: commonProvenance.verticalDatum,
    verticalPlacement: commonProvenance.verticalDatum.status === 'verified' ? 'verified' : 'unverified',
    hierarchyNodes: hierarchy.nodes.length,
    hierarchyPages: hierarchy.hierarchyPagesRead,
    hierarchyPageBytes: hierarchy.hierarchyPageBytesRead,
    tilesetNodes: tilesetInputs.length,
    contentNodes: contentNodes.length,
    emptyNodes: hierarchy.nodes.length - contentNodes.length,
    emptyNodesOmittedFromTileset: hierarchy.nodes.filter((node) => node.pointCount === 0 && !includedNodeKeys.has(node.key)).length,
    totalPoints: effectiveLimits.totalPoints,
    scannedPoints,
    totalPointDataBytes: effectiveLimits.totalPointDataBytes,
    decodedEcefBytesScanned,
    peakDecodedEcefBufferBytes,
    scanDurationMilliseconds: Math.max(0, performanceNow() - startedAt),
    ...getMetadataOnlyBoundsStatus(source, rootKey),
    contentBounds: Object.freeze(contentNodes.map((node) => {
      const bounds = completedContentBounds.get(node.key);
      if (!bounds) throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Node ${node.key} has no recorded content envelope.`, { nodeKey: node.key });
      return bounds;
    })),
  });
  const tileset = Object.freeze({
    ...generatedTileset,
    root: decoratedRoot,
    extras: Object.freeze({
      boundsStrategy: 'decoded-content',
      boundsCoverage: 'all-content-points-in-complete-hierarchy',
      sourceCellCoverage: false,
      hierarchyNodes: hierarchy.nodes.length,
      tilesetNodes: tilesetInputs.length,
      emptyNodesOmittedFromTileset: decodedContentScan.emptyNodesOmittedFromTileset,
      sourceIdentity,
      sourceGeneration,
      transformGeneration,
      transformPlanIdentity: commonProvenance.transformPlanIdentity,
      sourceCrs: commonProvenance.sourceCrs,
      verticalDatum: commonProvenance.verticalDatum,
      heightOffsetMeters: commonProvenance.heightOffsetMeters,
      verticalPlacement: decodedContentScan.verticalPlacement,
    }),
  });
  const tilesetBytes = new TextEncoder().encode(JSON.stringify(tileset));
  if (tilesetBytes.byteLength > (options.maxTilesetBytes ?? DEFAULT_MAX_TILESET_BYTES)) {
    throw new CopcTileResourceProviderError('RESOURCE_LIMIT', 'Generated tileset.json exceeds its configured byte limit.');
  }
  const contentByUri = new Map<string, DecodedPreparedTileNode>();
  for (const prepared of preparedNodes.values()) {
    if (prepared.node.pointCount > 0) contentByUri.set(getExplicitTileContentUri(prepared.node.key), prepared);
  }

  const lifecycle = new AbortController();
  let closed = false;
  const isCurrent = (): boolean => !closed &&
    source.sourceIdentity === sourceIdentity &&
    source.sourceGeneration === sourceGeneration &&
    source.transformGeneration === transformGeneration &&
    (source.isCurrent?.() ?? true);
  const provider: CopcTileResourceProvider = Object.freeze({
    sourceIdentity,
    generation: sourceGeneration,
    isCurrent,
    tileset,
    hierarchyPagesRead: hierarchy.hierarchyPagesRead,
    hierarchyPageBytesRead: hierarchy.hierarchyPageBytesRead,
    boundsStrategy: 'decoded-content',
    decodedContentScan,
    getResource: async (uri: string, signal: AbortSignal): Promise<Uint8Array | undefined> => {
      if (closed) throw new CopcTileResourceProviderError('SOURCE_CLOSED', 'COPC Tiles resource provider is closed.');
      const operation = combineSignals(signal, lifecycle.signal);
      try {
        assertNotAborted(operation.signal);
        assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
        if (uri === 'tileset.json') return tilesetBytes.slice();
        const prepared = contentByUri.get(uri);
        if (!prepared) return undefined;
        const view = await reader.readNode(prepared.node, options.selection, { signal: operation.signal });
        assertNotAborted(operation.signal);
        assertSourceCurrent(source, sourceIdentity, sourceGeneration, sourceGeneration, transformGeneration);
        const provenance = prepared.decodedContentBounds;
        if (!provenance || !prepared.contentBounds) {
          throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Node ${prepared.node.key} has no completed decoded-content envelope.`, { nodeKey: prepared.node.key });
        }
        assertDecodedViewProvenance(view, provenance);
        assertPointsWithinDecodedBounds(view, provenance, prepared.node.key);
        const encoded = encodePointCloudGlb(view, encoderOptions(options, prepared));
        if (!encoded) return undefined;
        if (encoded.maxAbsoluteErrorMeters > provenance.encoderPaddingMeters) {
          throw new CopcTileResourceProviderError(
            'ENCODER_PADDING_MISMATCH',
            `Node ${prepared.node.key} Float32 error ${encoded.maxAbsoluteErrorMeters} m exceeds its computed padding ${provenance.encoderPaddingMeters} m.`,
            { nodeKey: prepared.node.key, decodedContentBounds: provenance },
          );
        }
        assertBoundsWithin(encoded.reconstructedEcefBounds, provenance.paddedContentBoundsEcef, prepared.node.key);
        assertBoundsWithin(encoded.reconstructedEcefBounds, prepared.bounds, prepared.node.key);
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
  reportProgress('complete', {
    hierarchyNodes: hierarchy.nodes.length,
    hierarchyPages: hierarchy.hierarchyPagesRead,
    hierarchyPageBytes: hierarchy.hierarchyPageBytesRead,
    contentNodes: contentNodes.length,
    scannedNodes,
    totalPoints: effectiveLimits.totalPoints,
    scannedPoints,
    totalPointDataBytes: effectiveLimits.totalPointDataBytes,
    transformPlanIdentity: commonProvenance.transformPlanIdentity,
    sourceCrs: commonProvenance.sourceCrs,
    verticalDatum: commonProvenance.verticalDatum,
  });
  return provider;
}

function decorateDecodedContentTile(
  tile: Record<string, unknown>,
  nodeKey: string,
  preparedNodes: ReadonlyMap<string, DecodedPreparedTileNode>,
  subtreeRawBounds: ReadonlyMap<string, EcefAxisAlignedBounds>,
  subtreeTileBounds: ReadonlyMap<string, EcefAxisAlignedBounds>,
  commonProvenance: DecodedSourceProvenance,
  sourceIdentity: string,
  sourceGeneration: number,
  transformGeneration: number,
): Record<string, unknown> {
  const prepared = preparedNodes.get(nodeKey);
  const rawBounds = subtreeRawBounds.get(nodeKey);
  const tileBounds = subtreeTileBounds.get(nodeKey);
  if (!prepared || !rawBounds || !tileBounds) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Node ${nodeKey} is missing finalized content or descendant bounds.`, { nodeKey });
  }
  const node = prepared.tilesetNode;
  const children = (tile.children as Record<string, unknown>[] | undefined) ?? [];
  if (children.length !== (node.children?.length ?? 0)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Generated Tileset children do not match hierarchy node ${nodeKey}.`, { nodeKey });
  }
  return Object.freeze({
    ...tile,
    extras: Object.freeze({
      boundsStrategy: 'decoded-content',
      nodeKey,
      sourceIdentity,
      sourceGeneration,
      transformGeneration,
      transformPlanIdentity: commonProvenance.transformPlanIdentity,
      contentCoverage: node.pointCount > 0 ? 'all-points-in-node' : 'no-own-content',
      pointCount: node.pointCount,
      ...(prepared.decodedContentBounds === undefined ? {} : {
        contentBoundsEcef: prepared.decodedContentBounds.contentBoundsEcef,
        paddedContentBoundsEcef: prepared.decodedContentBounds.paddedContentBoundsEcef,
        encoderPaddingMeters: prepared.decodedContentBounds.encoderPaddingMeters,
        verticalPlacement: prepared.decodedContentBounds.verticalPlacement,
      }),
      descendantCoverage: 'all-descendant-content-points',
      descendantBoundsEcef: toEcefBoundsRecord(rawBounds),
      paddedDescendantBoundsEcef: toEcefBoundsRecord(tileBounds),
    }),
    ...(children.length === 0 ? {} : {
      children: Object.freeze(children.map((child, index) => {
        const childKey = node.children?.[index];
        if (!childKey) throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Node ${nodeKey} has an unkeyed Tileset child.`, { nodeKey });
        return decorateDecodedContentTile(
          child,
          childKey,
          preparedNodes,
          subtreeRawBounds,
          subtreeTileBounds,
          commonProvenance,
          sourceIdentity,
          sourceGeneration,
          transformGeneration,
        );
      })),
    }),
  });
}

type DecodedSourceProvenance = Readonly<{
  transformPlanIdentity: string;
  sourceCrs: TileSourceCrsEvidence;
  verticalDatum: TileVerticalDatumEvidence;
  heightOffsetMeters: number;
}>;

async function scanDecodedContentNode(
  reader: TileNodeReader,
  source: TileNodeSource,
  node: TileHierarchyNode,
  sourceGeneration: number,
  transformGeneration: number,
  signal?: AbortSignal,
): Promise<Readonly<{
  bounds: EcefAxisAlignedBounds;
  pointCount: number;
  ecefByteLength: number;
  provenance: DecodedSourceProvenance;
}>> {
  const view = await reader.readNode(node, {}, signal === undefined ? {} : { signal });
  if (
    view.pointCount !== node.pointCount || view.context.nodeKey !== node.key ||
    view.context.sourceIdentity !== source.sourceIdentity ||
    view.context.sourceGeneration !== sourceGeneration ||
    view.context.transformGeneration !== transformGeneration ||
    view.ecef.length !== view.pointCount * 3
  ) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      `Prepared node ${node.key} does not match its hierarchy identity, source generation, transform generation, or point count.`,
      { nodeKey: node.key },
    );
  }
  const planIdentity = view.context.transformPlan?.identity?.key;
  if (typeof planIdentity !== 'string' || planIdentity.trim() === '') {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      `Prepared node ${node.key} has no immutable coordinate transform plan identity.`,
      { nodeKey: node.key },
    );
  }
  if (!Number.isFinite(view.context.heightOffsetMeters)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Prepared node ${node.key} has a non-finite height offset.`, { nodeKey: node.key });
  }
  const bounds = boundsFromPreparedEcef(view, node.key);
  return Object.freeze({
    bounds,
    pointCount: view.pointCount,
    ecefByteLength: view.ecef.byteLength,
    provenance: Object.freeze({
      transformPlanIdentity: planIdentity,
      sourceCrs: view.context.sourceCrs,
      verticalDatum: view.context.verticalDatum,
      heightOffsetMeters: view.context.heightOffsetMeters,
    }),
  });
}

function preflightDecodedContentHierarchy(
  nodes: readonly TileHierarchyNode[],
  readerLimits: ResolvedTileNodeReaderLimits,
  tilesetOptions: ExplicitTilesetOptions | undefined,
): Readonly<{
  maxNodes: number;
  maxTotalPoints: number;
  totalPoints: number;
  totalPointDataBytes: number;
  totalDecodedEcefBytes: number;
}> {
  const requestedMaxNodes = tilesetOptions?.maxNodes ?? EXPLICIT_TILESET_DEFAULT_LIMITS.maxNodes;
  const requestedMaxTotalPoints = tilesetOptions?.maxTotalPoints ?? EXPLICIT_TILESET_DEFAULT_LIMITS.maxTotalPoints;
  if (
    !Number.isSafeInteger(requestedMaxNodes) || requestedMaxNodes <= 0 || requestedMaxNodes > EXPLICIT_TILESET_HARD_LIMITS.maxNodes ||
    !Number.isSafeInteger(requestedMaxTotalPoints) || requestedMaxTotalPoints <= 0 || requestedMaxTotalPoints > EXPLICIT_TILESET_HARD_LIMITS.maxTotalPoints
  ) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', 'Tileset node and point budgets must be positive safe integers within the documented hard limits.');
  }
  const maxNodes = Math.min(readerLimits.maxHierarchyNodes, requestedMaxNodes);
  const maxTotalPoints = Math.min(readerLimits.maxTotalPoints, requestedMaxTotalPoints);
  if (nodes.length > maxNodes) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Complete hierarchy contains ${nodes.length} nodes; the effective configured limit is ${maxNodes}. No point payloads were read.`);
  }

  let totalPoints = 0;
  let totalPointDataBytes = 0;
  let totalDecodedEcefBytes = 0;
  for (const node of nodes) {
    if (node.pointCount === 0) continue;
    if (node.pointCount > readerLimits.maxPointsPerNode) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Node ${node.key} declares ${node.pointCount} points; maxPointsPerNode is ${readerLimits.maxPointsPerNode}. No point payloads were read.`, { nodeKey: node.key });
    }
    if (node.pointDataLength > readerLimits.maxPointDataBytesPerNode) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Node ${node.key} declares ${node.pointDataLength} point-data bytes; maxPointDataBytesPerNode is ${readerLimits.maxPointDataBytesPerNode}. No point payloads were read.`, { nodeKey: node.key });
    }
    const decodedEcefBytes = node.pointCount * 3 * Float64Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(decodedEcefBytes) || decodedEcefBytes > readerLimits.maxDecodedBytesPerNode) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Node ${node.key} needs ${decodedEcefBytes} prepared ECEF bytes; maxDecodedBytesPerNode is ${readerLimits.maxDecodedBytesPerNode}. No point payloads were read.`, { nodeKey: node.key });
    }
    totalPoints += node.pointCount;
    totalPointDataBytes += node.pointDataLength;
    totalDecodedEcefBytes += decodedEcefBytes;
    if (![totalPoints, totalPointDataBytes, totalDecodedEcefBytes].every(Number.isSafeInteger)) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', 'Hierarchy preflight totals exceed the safe integer range. No point payloads were read.', { nodeKey: node.key });
    }
    if (totalPoints > maxTotalPoints) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Hierarchy declares ${totalPoints} points; the effective maxTotalPoints is ${maxTotalPoints}. No point payloads were read.`, { nodeKey: node.key });
    }
    if (totalPointDataBytes > readerLimits.maxTotalPointDataBytes) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Hierarchy declares ${totalPointDataBytes} point-data bytes; maxTotalPointDataBytes is ${readerLimits.maxTotalPointDataBytes}. No point payloads were read.`, { nodeKey: node.key });
    }
    if (totalDecodedEcefBytes > readerLimits.maxTotalDecodedBytes) {
      throw new CopcTileResourceProviderError('CONTENT_SCAN_LIMIT', `Prepared ECEF output needs ${totalDecodedEcefBytes} bytes across all content; maxTotalDecodedBytes is ${readerLimits.maxTotalDecodedBytes}. No point payloads were read.`, { nodeKey: node.key });
    }
  }
  return Object.freeze({ maxNodes, maxTotalPoints, totalPoints, totalPointDataBytes, totalDecodedEcefBytes });
}

function validateDecodedContentHierarchy(nodes: readonly TileHierarchyNode[]): void {
  const nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  const parentByChild = new Map<string, string>();
  const roots = nodes.filter((node) => node.level === 0 && node.x === 0 && node.y === 0 && node.z === 0);
  if (roots.length !== 1) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      `Decoded-content scan requires exactly one COPC root node; found ${roots.length}.`,
    );
  }
  const root = roots[0]!;

  for (const node of nodes) {
    for (const childKey of node.children ?? []) {
      const child = nodesByKey.get(childKey);
      if (!child) {
        throw new CopcTileResourceProviderError(
          'CONTENT_SCAN_INVALID',
          `Complete hierarchy node ${node.key} references child ${childKey}, which is absent from the scanned hierarchy; the branch cannot be treated as empty.`,
          { nodeKey: node.key },
        );
      }
      if (parentByChild.has(childKey)) {
        throw new CopcTileResourceProviderError(
          'CONTENT_SCAN_INVALID',
          `Hierarchy child ${childKey} is referenced by more than one parent.`,
          { nodeKey: childKey },
        );
      }
      if (
        child.level !== node.level + 1 || Math.floor(child.x / 2) !== node.x ||
        Math.floor(child.y / 2) !== node.y || Math.floor(child.z / 2) !== node.z
      ) {
        throw new CopcTileResourceProviderError(
          'CONTENT_SCAN_INVALID',
          `Hierarchy child ${childKey} is not the next octree node below ${node.key}.`,
          { nodeKey: childKey },
        );
      }
      parentByChild.set(childKey, node.key);
    }
  }

  if (parentByChild.has(root.key)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', 'The COPC root node is referenced as another node’s child.', { nodeKey: root.key });
  }
  const disconnected = nodes.find((node) => node.key !== root.key && !parentByChild.has(node.key));
  if (disconnected) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_INVALID',
      `Hierarchy node ${disconnected.key} is not reachable from the COPC root.`,
      { nodeKey: disconnected.key },
    );
  }
}

function validateDecodedSource(source: TileNodeSource): void {
  if (
    !source || typeof source !== 'object' || typeof source.sourceIdentity !== 'string' || source.sourceIdentity.trim() === '' ||
    !Number.isSafeInteger(source.transformGeneration) || source.transformGeneration < 0 ||
    !Number.isSafeInteger(source.sourceGeneration) || source.sourceGeneration! < 0 ||
    typeof source.getRootHierarchyPage !== 'function' || typeof source.loadHierarchyPage !== 'function' ||
    typeof source.loadNode !== 'function'
  ) {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'Decoded-content bounds require a current public node source with stable source and transform generations.');
  }
  if (source.isCurrent?.() === false) {
    throw new CopcTileResourceProviderError('STALE_SOURCE', 'COPC source is already stale.');
  }
}

function boundsFromPreparedEcef(view: TilePointView, nodeKey: string): EcefAxisAlignedBounds {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let point = 0; point < view.pointCount; point += 1) {
    const index = point * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = view.ecef[index + axis];
      if (!Number.isFinite(value)) {
        throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Prepared node ${nodeKey} has a non-finite ECEF coordinate at point ${point}, axis ${axis}.`, { nodeKey });
      }
      minimum[axis] = Math.min(minimum[axis]!, value);
      maximum[axis] = Math.max(maximum[axis]!, value);
    }
  }
  if (view.pointCount === 0 || ![...minimum, ...maximum].every(Number.isFinite)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', `Prepared node ${nodeKey} has no finite positions to enclose.`, { nodeKey });
  }
  return Object.freeze({ minimum: Object.freeze(minimum as [number, number, number]), maximum: Object.freeze(maximum as [number, number, number]) });
}

function sameDecodedSourceProvenance(left: DecodedSourceProvenance, right: DecodedSourceProvenance): boolean {
  return left.transformPlanIdentity === right.transformPlanIdentity &&
    left.heightOffsetMeters === right.heightOffsetMeters &&
    JSON.stringify(left.sourceCrs) === JSON.stringify(right.sourceCrs) &&
    JSON.stringify(left.verticalDatum) === JSON.stringify(right.verticalDatum);
}

function toEcefBoundsRecord(bounds: EcefAxisAlignedBounds): DecodedContentBoundsProvenance['contentBoundsEcef'] {
  return Object.freeze({
    coordinateSystem: 'wgs84-ecef-meters',
    minX: bounds.minimum[0], minY: bounds.minimum[1], minZ: bounds.minimum[2],
    maxX: bounds.maximum[0], maxY: bounds.maximum[1], maxZ: bounds.maximum[2],
  });
}

function withContentPadding(
  provenance: Omit<DecodedContentBoundsProvenance, 'encoderPaddingMeters' | 'paddedContentBoundsEcef'> | undefined,
  padding: number,
): DecodedContentBoundsProvenance | undefined {
  if (!provenance) return undefined;
  const bounds = expandBounds(
    {
      minimum: [provenance.contentBoundsEcef.minX, provenance.contentBoundsEcef.minY, provenance.contentBoundsEcef.minZ],
      maximum: [provenance.contentBoundsEcef.maxX, provenance.contentBoundsEcef.maxY, provenance.contentBoundsEcef.maxZ],
    },
    padding,
  );
  return Object.freeze({ ...provenance, encoderPaddingMeters: padding, paddedContentBoundsEcef: bounds });
}

function zeroBounds(): EcefAxisAlignedBounds {
  return Object.freeze({ minimum: [0, 0, 0], maximum: [0, 0, 0] });
}

function unionBounds(left: EcefAxisAlignedBounds, right: EcefAxisAlignedBounds): EcefAxisAlignedBounds {
  return Object.freeze({
    minimum: Object.freeze(left.minimum.map((value, axis) => Math.min(value, right.minimum[axis])) as [number, number, number]),
    maximum: Object.freeze(left.maximum.map((value, axis) => Math.max(value, right.maximum[axis])) as [number, number, number]),
  });
}

function expandBounds(bounds: EcefAxisAlignedBounds, padding: number): EcefAxisAlignedBounds {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', 'Content encoder padding must be finite and non-negative.');
  }
  const minimum = bounds.minimum.map((value) => value - padding) as [number, number, number];
  const maximum = bounds.maximum.map((value) => value + padding) as [number, number, number];
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', 'Padded decoded-content bounds exceed the finite numeric range.');
  }
  return Object.freeze({ minimum: Object.freeze(minimum), maximum: Object.freeze(maximum) });
}

function ensureMinimumHalfExtent(bounds: EcefAxisAlignedBounds): EcefAxisAlignedBounds {
  const minimum = bounds.minimum.map((value, axis) => {
    const center = value + (bounds.maximum[axis] - value) / 2;
    return Math.min(value, center - Math.max((bounds.maximum[axis] - value) / 2, 0.001));
  }) as [number, number, number];
  const maximum = bounds.maximum.map((value, axis) => {
    const center = bounds.minimum[axis] + (value - bounds.minimum[axis]) / 2;
    return Math.max(value, center + Math.max((value - bounds.minimum[axis]) / 2, 0.001));
  }) as [number, number, number];
  if (![...minimum, ...maximum].every(Number.isFinite)) {
    throw new CopcTileResourceProviderError('CONTENT_SCAN_INVALID', 'Minimum 3D Tiles bounding-volume extents exceed the finite numeric range.');
  }
  return Object.freeze({ minimum: Object.freeze(minimum), maximum: Object.freeze(maximum) });
}

function assertDecodedViewProvenance(view: TilePointView, result: DecodedContentBoundsProvenance): void {
  if (
    view.context.sourceIdentity !== result.sourceIdentity || view.context.nodeKey !== result.nodeKey ||
    view.context.sourceGeneration !== result.sourceGeneration || view.context.transformGeneration !== result.transformGeneration ||
    view.context.transformPlan?.identity?.key !== result.transformPlanIdentity ||
    view.context.heightOffsetMeters !== result.heightOffsetMeters ||
    JSON.stringify(view.context.sourceCrs) !== JSON.stringify(result.sourceCrs) ||
    JSON.stringify(view.context.verticalDatum) !== JSON.stringify(result.verticalDatum) ||
    view.pointCount !== result.pointCount
  ) {
    throw new CopcTileResourceProviderError('STALE_SOURCE', `Node ${result.nodeKey} point data does not match the source, transform, or decoded-content scan provenance.`, {
      nodeKey: result.nodeKey,
      decodedContentBounds: result,
    });
  }
}

function assertPointsWithinDecodedBounds(view: TilePointView, result: DecodedContentBoundsProvenance, nodeKey: string): void {
  const minimum = [result.contentBoundsEcef.minX, result.contentBoundsEcef.minY, result.contentBoundsEcef.minZ];
  const maximum = [result.contentBoundsEcef.maxX, result.contentBoundsEcef.maxY, result.contentBoundsEcef.maxZ];
  for (let point = 0; point < view.pointCount; point += 1) {
    const index = point * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = view.ecef[index + axis];
      if (!Number.isFinite(coordinate) || coordinate < minimum[axis]! || coordinate > maximum[axis]!) {
        throw new CopcTileResourceProviderError('POINT_OUTSIDE_DECODED_BOUNDS', `Regenerated point ${point} in node ${nodeKey} is outside the content envelope recorded during preprocessing.`, {
          nodeKey,
          decodedContentBounds: result,
        });
      }
    }
  }
}

function assertBoundsWithin(
  actual: DecodedContentBoundsProvenance['contentBoundsEcef'],
  expected: EcefAxisAlignedBounds,
  nodeKey: string,
): void {
  if (
    actual.minX < expected.minimum[0] || actual.minY < expected.minimum[1] || actual.minZ < expected.minimum[2] ||
    actual.maxX > expected.maximum[0] || actual.maxY > expected.maximum[1] || actual.maxZ > expected.maximum[2]
  ) {
    throw new CopcTileResourceProviderError('ENCODER_PADDING_MISMATCH', `Generated GLB positions for node ${nodeKey} fall outside the padded decoded-content bound.`, { nodeKey });
  }
}

function getMetadataOnlyBoundsStatus(
  source: TileNodeSource,
  rootNodeKey: string | undefined,
): Pick<DecodedContentScanSummary, 'metadataOnlySourceCellStatus' | 'metadataOnlySourceCellReasonCode' | 'metadataOnlySourceCellReason'> {
  const conservative = source as Partial<TileConservativeNodeSource>;
  if (!rootNodeKey || typeof conservative.getConservativeNodeEcefBounds !== 'function') return {};
  const result = conservative.getConservativeNodeEcefBounds(rootNodeKey);
  return result.status === 'supported'
    ? { metadataOnlySourceCellStatus: 'supported' }
    : {
      metadataOnlySourceCellStatus: 'unsupported',
      metadataOnlySourceCellReasonCode: result.reasonCode,
      metadataOnlySourceCellReason: result.reason,
    };
}

function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
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
  if ((options as { boundsStrategy?: unknown }).boundsStrategy === 'decoded-content' &&
      (options as { allowDecodedContentBounds?: unknown }).allowDecodedContentBounds !== true) {
    throw new CopcTileResourceProviderError(
      'CONTENT_SCAN_NOT_AUTHORIZED',
      'Set allowDecodedContentBounds: true together with boundsStrategy: "decoded-content" to authorize full bounded point preprocessing.',
    );
  }
  if (
    (options as { boundsStrategy?: unknown }).boundsStrategy !== undefined &&
    (options as { boundsStrategy?: unknown }).boundsStrategy !== 'conservative-source-cell' &&
    (options as { boundsStrategy?: unknown }).boundsStrategy !== 'decoded-content'
  ) {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'Unknown Tiles bounds strategy.');
  }
  if ((options as { boundsStrategy?: unknown }).boundsStrategy !== 'decoded-content' &&
      (options as { allowDecodedContentBounds?: unknown }).allowDecodedContentBounds !== undefined) {
    throw new CopcTileResourceProviderError('INVALID_SOURCE', 'Decoded-content authorization is valid only for the decoded-content strategy.');
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

function assertPointsWithinConservativeBounds(
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
  source: TileNodeSource,
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
