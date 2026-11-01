import type { TilePointFieldSelection, TilePointView } from '../input/tilePointView.js';

/** A bounded reference to one lazily loaded hierarchy page. */
export type TileHierarchyPage = Readonly<{
  key: string;
  pageOffset: number;
  pageLength: number;
}>;

/** Source-neutral COPC-style node record used by the fixture and adapter bridge. */
export type TileHierarchyNode = Readonly<{
  key: string;
  level: number;
  x: number;
  y: number;
  z: number;
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
  children?: readonly string[];
  /** Only true proves that all direct children have been discovered. */
  childrenComplete?: boolean;
}>;

export type TileHierarchyPageResult = Readonly<{
  nodes: readonly TileHierarchyNode[];
  pages: readonly TileHierarchyPage[];
}>;

/** Source-space bounds carried by a Core conservative-bounds result. */
export type TileSourceCellBounds = Readonly<{
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}>;

/** Validated vertical-grid provenance relevant to conservative cell bounds. */
export type TileConservativeBoundsGridProvenance = Readonly<{
  id: string;
  sha256: string;
  sourceVerticalCrs: string;
  targetVerticalCrs: 'EPSG:4979';
  samplingHorizontalCrs: 'EPSG:4326';
  referenceEllipsoid: 'WGS84';
  interpolation: 'bilinear';
  valueUnit: string;
  valueConvention: 'ellipsoidal-minus-orthometric';
  noDataValue: number | null;
  width: number;
  height: number;
  longitude: Readonly<{ min: number; max: number; coverage: 'none' | 'duplicated-seam' | 'periodic' }>;
  latitude: Readonly<{ min: number; max: number }>;
  minimumUndulationMeters: number;
  maximumUndulationMeters: number;
  sourceCoordinateEpoch?: number;
  gridReferenceEpoch?: number;
  compatibility: 'validated' | 'unsupported';
  compatibilityMessage?: string;
}>;

/**
 * Structural copy of Adapter Core 0.7.1's public result. Keeping this type in
 * the source-neutral Tiles API lets the engine remain usable without Adapter.
 */
export type TileConservativeBoundsResult = Readonly<{
  nodeKey: string;
  sourceCellBounds: TileSourceCellBounds;
  sourceCoordinateSystem: 'copc-source';
  sourceIdentity: string;
  sourceGeneration: number;
  transformGeneration: number;
  transformPlanIdentity: string;
  heightOffsetMeters: number;
  verticalGrid?: TileConservativeBoundsGridProvenance;
}> & (
  | Readonly<{
      status: 'supported';
      boundsEcef: Readonly<{
        coordinateSystem: 'wgs84-ecef-meters';
        minX: number;
        minY: number;
        minZ: number;
        maxX: number;
        maxY: number;
        maxZ: number;
      }>;
      coverage: 'full-source-cell-and-descendant-cells';
      method: 'wgs84-geodetic-interval-v1';
      verification: 'analytic-interval';
      verticalReference: 'ellipsoidal' | 'validated-grid';
      sourceVerticalUnitToMeters: number;
      encoderErrorPaddingRequired: true;
      assumptions: readonly string[];
    }>
  | Readonly<{
      status: 'unsupported';
      reasonCode:
        | 'unsupported-horizontal-crs'
        | 'unsupported-horizontal-units'
        | 'unsupported-axis-order'
        | 'unsupported-coordinate-epoch'
        | 'unsupported-vertical-reference'
        | 'unsupported-vertical-grid'
        | 'vertical-grid-has-nodata-sentinel'
        | 'vertical-grid-outside-cell-coverage'
        | 'invalid-source-cell'
        | 'unsupported-geographic-cell'
        | 'numeric-range';
      reason: string;
    }>
);

export interface TileNodeSource {
  readonly sourceIdentity: string;
  /** Adapter source generation when available; changes invalidate prior reads. */
  readonly sourceGeneration?: number;
  readonly transformGeneration: number;
  /** False after close, source replacement, or a transform-policy change. */
  isCurrent?(): boolean;
  getRootHierarchyPage(): TileHierarchyPage;
  /** Optional source-space bounds for validating conservative-result provenance. */
  getNodeCellBounds?(nodeKey: string): TileSourceCellBounds;
  /** Implementations should honor the signal; synchronous decoders may only reject after the current decode finishes. */
  loadHierarchyPage(page: TileHierarchyPage, signal?: AbortSignal): Promise<TileHierarchyPageResult>;
  loadNode(
    node: TileHierarchyNode,
    selection: TilePointFieldSelection,
    signal?: AbortSignal,
  ): Promise<TilePointView>;
  /** Close only when ownership has explicitly been transferred to a provider. */
  close?(): void | Promise<void>;
}

/** Optional metadata-only capability used to gate safe multi-node Tilesets. */
export interface TileConservativeNodeSource extends TileNodeSource {
  /** Adapter/source identity carried inside conservative-bounds provenance, when distinct from the Tiles caller identity. */
  readonly conservativeBoundsSourceIdentity?: string;
  /**
   * Bounds the complete source cell and its spatial descendants when
   * supported. This operation must not read points or issue network requests.
   */
  getConservativeNodeEcefBounds(nodeKey: string): TileConservativeBoundsResult;
}

export type TileNodeReaderLimits = Readonly<{
  maxHierarchyPages?: number;
  maxHierarchyPageBytes?: number;
  maxTotalHierarchyPageBytes?: number;
  maxHierarchyNodes?: number;
  maxNodesPerPage?: number;
  maxRequestedNodes?: number;
  maxSelectedExtraDimensions?: number;
  maxPointsPerNode?: number;
  maxTotalPoints?: number;
  maxPointDataBytesPerNode?: number;
  maxTotalPointDataBytes?: number;
  maxDecodedBytesPerNode?: number;
  maxTotalDecodedBytes?: number;
  maxConcurrentNodeReads?: number;
}>;

export type TileNodeReadOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Result of an explicit, bounded metadata-only hierarchy scan. */
export type TileNodeHierarchy = Readonly<{
  nodes: readonly TileHierarchyNode[];
  hierarchyPagesRead: number;
  hierarchyPageBytesRead: number;
}>;

export type TileHierarchyScanOptions = TileNodeReadOptions & Readonly<{
  /** Called once for each validated node before following additional pages. */
  onNode?: (node: TileHierarchyNode) => void;
}>;

export type TileNodeReaderErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_HIERARCHY_PAGE'
  | 'INVALID_HIERARCHY_NODE'
  | 'CONFLICTING_NODE'
  | 'NODE_NOT_FOUND'
  | 'INCOMPLETE_HIERARCHY'
  | 'HIERARCHY_LIMIT'
  | 'REQUEST_LIMIT'
  | 'POINT_DATA_LIMIT'
  | 'DECODED_DATA_LIMIT'
  | 'NODE_CONTENT_MISMATCH'
  | 'STALE_SOURCE'
  | 'ABORTED';

export class TileNodeReaderError extends Error {
  readonly code: TileNodeReaderErrorCode;
  readonly pageKey: string | undefined;
  readonly nodeKey: string | undefined;

  constructor(
    code: TileNodeReaderErrorCode,
    message: string,
    details: Readonly<{ pageKey?: string; nodeKey?: string }> = {},
  ) {
    super(message);
    this.name = code === 'ABORTED' ? 'AbortError' : 'TileNodeReaderError';
    this.code = code;
    this.pageKey = details.pageKey;
    this.nodeKey = details.nodeKey;
  }
}
