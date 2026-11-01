import type {
  CopcBackendName,
  CopcConservativeBoundsResult,
  CopcConservativeNodeSource,
  CopcContextOptions,
  CopcHierarchyBounds,
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcInputSource,
  CopcMetadata,
  CopcPointField,
  CopcPreparedNodeData,
  CoordinateTransformPlan,
} from '@frillab/copc-adapter/core';
import {
  createTilePointViewFromA,
  snapshotTilePointFieldSelection,
  type TileNodeContext,
  type TilePointFieldSelection,
  type TilePointView,
  type TileTransformPlanProvenance,
} from '../input/tilePointView.js';
import type {
  TileHierarchyNode,
  TileHierarchyPage,
  TileHierarchyPageResult,
  TileConservativeBoundsGridProvenance,
  TileConservativeBoundsResult,
  TileConservativeNodeSource,
} from '../source/tileNodeSource.js';

export type CopcCoreAdapterOptions = Readonly<{
  /** Input supported by the public Core factory: URL, File/Blob, or random-access source. */
  input: CopcInputSource;
  /** Public Core backend identifier. No implicit backend fallback is performed. */
  backend?: CopcBackendName;
  /** Adapter source options, including range limits, height policy and selected Extra Bytes. */
  contextOptions?: CopcContextOptions;
  /** Opaque application-owned identity; never derive it from a signed source URL. */
  sourceIdentity: string;
  /** Optional application generation guard for source replacement outside this context. */
  isCurrent?: () => boolean;
}>;

export type CopcCoreNodeSourceOptions = Readonly<{
  source: CopcConservativeNodeSource;
  sourceIdentity: string;
  /** Destroy the supplied context on close; defaults to false. */
  ownsSource?: boolean;
  /** Optional application generation guard for source replacement outside this context. */
  isCurrent?: () => boolean;
}>;

export type CopcCoreAdapterErrorCode =
  | 'INVALID_SOURCE'
  | 'STALE_SOURCE'
  | 'NODE_MISMATCH'
  | 'INVALID_PREPARED_BOUNDS'
  | 'MISSING_CONSERVATIVE_BOUNDS_API'
  | 'INVALID_CONSERVATIVE_BOUNDS';

export class CopcCoreAdapterError extends Error {
  readonly code: CopcCoreAdapterErrorCode;
  readonly nodeKey: string | undefined;

  constructor(code: CopcCoreAdapterErrorCode, message: string, nodeKey?: string) {
    super(message);
    this.name = 'CopcCoreAdapterError';
    this.code = code;
    this.nodeKey = nodeKey;
  }
}

/**
 * Thin bridge over Adapter's renderer-neutral public CopcNodeSource contract.
 * It uses the Core source's own hierarchy, selected-node preparation,
 * cancellation, generations and immutable transform plan.
 */
export class CopcCoreNodeSource implements TileConservativeNodeSource {
  readonly sourceIdentity: string;
  readonly conservativeBoundsSourceIdentity: string;
  readonly sourceGeneration: number;
  readonly transformGeneration: number;
  readonly transformPlan: CoordinateTransformPlan;
  readonly #source: CopcConservativeNodeSource;
  readonly #ownsSource: boolean;
  readonly #isCurrentOverride: (() => boolean) | undefined;
  readonly #lifecycleAbort = new AbortController();
  #closed = false;

  constructor(options: CopcCoreNodeSourceOptions) {
    if (!options || typeof options !== 'object' || !options.source) {
      throw new CopcCoreAdapterError('INVALID_SOURCE', 'A public CopcNodeSource is required.');
    }
    if (typeof options.sourceIdentity !== 'string' || options.sourceIdentity.trim() === '') {
      throw new CopcCoreAdapterError('INVALID_SOURCE', 'sourceIdentity must be an opaque non-empty identifier.');
    }
    if (typeof options.source.getConservativeNodeEcefBounds !== 'function') {
      throw new CopcCoreAdapterError(
        'MISSING_CONSERVATIVE_BOUNDS_API',
        'Adapter Core 0.7.1 getConservativeNodeEcefBounds(nodeKey) is required for the Tiles Core connector.',
      );
    }
    if (!Number.isSafeInteger(options.source.sourceGeneration) || options.source.sourceGeneration < 0) {
      throw new CopcCoreAdapterError('INVALID_SOURCE', 'Adapter sourceGeneration must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(options.source.transformGeneration) || options.source.transformGeneration < 0) {
      throw new CopcCoreAdapterError('INVALID_SOURCE', 'Adapter transformGeneration must be a non-negative safe integer.');
    }
    this.#source = options.source;
    this.conservativeBoundsSourceIdentity = options.source.source;
    this.#ownsSource = options.ownsSource ?? false;
    this.#isCurrentOverride = options.isCurrent;
    this.sourceIdentity = options.sourceIdentity;
    this.sourceGeneration = options.source.sourceGeneration;
    this.transformGeneration = options.source.transformGeneration;
    this.transformPlan = options.source.transformPlan;
  }

  isCurrent(): boolean {
    return !this.#closed &&
      this.#source.isCurrent(this.sourceGeneration) &&
      (this.#isCurrentOverride?.() ?? true);
  }

  /** Return source metadata without relabeling source-space bounds as ECEF. */
  getMetadata(): CopcMetadata {
    this.#assertCurrent();
    return freezeMetadataCopy(this.#source.getMetadata());
  }

  /** Return one COPC cell in its original source CRS and units. */
  getNodeCellBounds(nodeKey: string): CopcHierarchyBounds {
    this.#assertCurrent();
    const bounds = this.#source.getNodeCellBounds(nodeKey);
    return Object.freeze({
      minX: bounds.minX,
      minY: bounds.minY,
      minZ: bounds.minZ,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      maxZ: bounds.maxZ,
    });
  }

  /**
   * Return Adapter Core's metadata-only source-cell bound without decoding
   * point content. Unsupported results retain their reason and provenance;
   * they are never converted to a decoded-point or guessed ECEF bound.
   */
  getConservativeNodeEcefBounds(nodeKey: string): TileConservativeBoundsResult {
    this.#assertCurrent();
    if (typeof nodeKey !== 'string' || nodeKey.trim() === '') {
      throw new CopcCoreAdapterError('INVALID_CONSERVATIVE_BOUNDS', 'A non-empty hierarchy node key is required.');
    }
    const result = this.#source.getConservativeNodeEcefBounds(nodeKey);
    this.#assertCurrent();
    validateConservativeBoundsResult(
      result,
      nodeKey,
      this.#source,
      this.sourceGeneration,
      this.transformGeneration,
    );
    return freezeMetadataCopy(result) as TileConservativeBoundsResult;
  }

  getRootHierarchyPage(): TileHierarchyPage {
    this.#assertCurrent();
    return copyPage(this.#source.getRootHierarchyPage());
  }

  async loadHierarchyPage(page: TileHierarchyPage, signal?: AbortSignal): Promise<TileHierarchyPageResult> {
    const operation = combineSignals(signal, this.#lifecycleAbort.signal);
    try {
      this.#assertCurrent(operation.signal);
      const result = await this.#source.loadHierarchyPage(copyPage(page), { signal: operation.signal });
      this.#assertCurrent(operation.signal);
      if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.pages)) {
        return result as unknown as TileHierarchyPageResult;
      }
      return Object.freeze({
        nodes: Object.freeze(result.nodes.map(copyCoreNode)),
        pages: Object.freeze(result.pages.map(copyPage)),
      });
    } finally {
      operation.dispose();
    }
  }

  async loadNode(
    node: TileHierarchyNode,
    selection: TilePointFieldSelection,
    signal?: AbortSignal,
  ): Promise<TilePointView> {
    const operation = combineSignals(signal, this.#lifecycleAbort.signal);
    try {
      this.#assertCurrent(operation.signal);
      const selected = snapshotTilePointFieldSelection(selection);
      const fields: CopcPointField[] = ['position'];
      if (selected.attributes?.rgb) fields.push('rgb');
      if (selected.attributes?.intensity) fields.push('intensity');
      if (selected.attributes?.classification) fields.push('classification');
      const extras = selected.attributes?.extraDimensions ?? [];

      const prepared = await this.#source.loadPreparedNodeData(
        copyNodeToCore(node),
        new Set(fields),
        {
          signal: operation.signal,
          ...(extras.length > 0 ? { extraDimensions: extras } : {}),
        },
      );
      this.#assertCurrent(operation.signal);
      validatePreparedIdentity(prepared, node, this.#source, this.sourceGeneration, this.transformGeneration);
      validateDecodedPointBounds(prepared, node.key);

      const context = createNodeContext(
        this.sourceIdentity,
        node.key,
        prepared,
      );
      const view = createTilePointViewFromA(
        prepared.pointData,
        context,
        {
          sourceIdentity: this.sourceIdentity,
          sourceGeneration: this.sourceGeneration,
          transformGeneration: this.transformGeneration,
        },
        selected,
      );
      if (view.pointCount !== node.pointCount || view.context.nodeKey !== node.key) {
        throw new CopcCoreAdapterError('NODE_MISMATCH', 'Prepared data does not match the requested node identity or point count.', node.key);
      }
      return view;
    } finally {
      operation.dispose();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifecycleAbort.abort();
    if (this.#ownsSource) this.#source.close();
  }

  #assertCurrent(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const error = new Error('COPC node read was cancelled.', { cause: signal.reason });
      error.name = 'AbortError';
      throw error;
    }
    if (!this.isCurrent()) {
      throw new CopcCoreAdapterError('STALE_SOURCE', 'COPC source is closed or belongs to a stale generation.');
    }
  }
}

/** Open and own a context through the public `@frillab/copc-adapter/core` entrypoint. */
export async function createCopcCoreNodeSource(options: CopcCoreAdapterOptions): Promise<CopcCoreNodeSource> {
  if (!options || typeof options !== 'object') {
    throw new CopcCoreAdapterError('INVALID_SOURCE', 'Core adapter options are required.');
  }
  const core = await importCoreApi();
  const source = await core.createCopcContext(
    options.input,
    options.backend ?? 'copc-js',
    options.contextOptions ?? {},
  );
  try {
    return new CopcCoreNodeSource({
      source,
      sourceIdentity: options.sourceIdentity,
      ownsSource: true,
      ...(options.isCurrent === undefined ? {} : { isCurrent: options.isCurrent }),
    });
  } catch (error) {
    source.close();
    throw error;
  }
}

/** Wrap an already-open Core context; ownership stays with the caller by default. */
export function wrapCopcCoreNodeSource(options: CopcCoreNodeSourceOptions): CopcCoreNodeSource {
  return new CopcCoreNodeSource(options);
}

type CopcCoreRuntime = typeof import('@frillab/copc-adapter/core');

async function importCoreApi(): Promise<CopcCoreRuntime> {
  return import('@frillab/copc-adapter/core');
}

function copyPage(page: CopcHierarchyPage | TileHierarchyPage): TileHierarchyPage {
  if (!isRecord(page)) return page as TileHierarchyPage;
  return Object.freeze({
    key: page.key as string,
    pageOffset: page.pageOffset as number,
    pageLength: page.pageLength as number,
  });
}

function copyCoreNode(node: CopcHierarchyNode): TileHierarchyNode {
  if (!isRecord(node)) return node as TileHierarchyNode;
  const children = node.children;
  return Object.freeze({
    key: node.key as string,
    level: node.level as number,
    x: node.x as number,
    y: node.y as number,
    z: node.z as number,
    pointCount: node.pointCount as number,
    pointDataOffset: node.pointDataOffset as number,
    pointDataLength: node.pointDataLength as number,
    ...(children === undefined ? {} : {
      children: Array.isArray(children) ? Object.freeze([...children]) as readonly string[] : children as string[],
    }),
    ...(node.childrenComplete === undefined ? {} : { childrenComplete: node.childrenComplete as boolean }),
  });
}

function copyNodeToCore(node: TileHierarchyNode): CopcHierarchyNode {
  return {
    key: node.key,
    level: node.level,
    x: node.x,
    y: node.y,
    z: node.z,
    pointCount: node.pointCount,
    pointDataOffset: node.pointDataOffset,
    pointDataLength: node.pointDataLength,
    ...(node.children === undefined ? {} : { children: [...node.children] }),
    ...(node.childrenComplete === undefined ? {} : { childrenComplete: node.childrenComplete }),
  };
}

function createNodeContext(
  sourceIdentity: string,
  nodeKey: string,
  prepared: CopcPreparedNodeData,
): TileNodeContext {
  const plan = prepared.transformPlan;
  const horizontal = plan.source.horizontalCrs;
  const identifier = horizontal?.authority && horizontal.code
    ? `${horizontal.authority}:${horizontal.code}`
    : horizontal?.name;
  const crsStatus = horizontal?.certainty === 'explicit'
    ? 'identified'
    : horizontal?.certainty === 'inferred'
      ? 'unverified'
      : 'unknown';
  const corrections = [];
  if (plan.manualHeightOffsetMeters !== 0) {
    corrections.push({ kind: 'manual-offset' as const, offsetMeters: plan.manualHeightOffsetMeters });
  }
  if (plan.verticalGrid) {
    corrections.push({ kind: 'validated-grid' as const, identifier: plan.verticalGrid.id });
  }
  const verticalStatus = plan.verticalGrid?.compatibility === 'validated'
    ? 'verified'
    : corrections.length > 0
      ? 'unverified'
      : 'unknown';
  const bounds = prepared.ecefBounds;
  return Object.freeze({
    sourceIdentity,
    nodeKey,
    sourceGeneration: prepared.sourceGeneration,
    transformGeneration: prepared.transformGeneration,
    sourceCrs: Object.freeze({
      status: crsStatus,
      ...(identifier === undefined ? {} : { identifier }),
      ...(plan.provenance.sourceWkt === undefined ? {} : { definition: plan.provenance.sourceWkt }),
      ...(plan.source.horizontalUnits.name === undefined ? {} : { horizontalUnit: plan.source.horizontalUnits.name }),
      ...(plan.source.verticalUnits.name === undefined ? {} : { verticalUnit: plan.source.verticalUnits.name }),
    }),
    verticalDatum: Object.freeze({
      status: verticalStatus,
      ...(plan.source.verticalCrs?.authority && plan.source.verticalCrs.code
        ? { identifier: `${plan.source.verticalCrs.authority}:${plan.source.verticalCrs.code}` }
        : plan.source.verticalCrs?.name === undefined ? {} : { identifier: plan.source.verticalCrs.name }),
      corrections: Object.freeze(corrections),
    }),
    heightOffsetMeters: plan.manualHeightOffsetMeters,
    transformPlan: plan as TileTransformPlanProvenance,
    availableFields: Object.freeze([...prepared.availableFields]),
    availableExtraDimensions: Object.freeze([...prepared.availableExtraDimensions]),
    ...(bounds === undefined ? {} : {
      decodedPointEcefBounds: bounds,
      decodedPointEcefBoundsKind: prepared.ecefBoundsKind,
    }),
  });
}

function validatePreparedIdentity(
  prepared: CopcPreparedNodeData,
  requestedNode: TileHierarchyNode,
  source: CopcConservativeNodeSource,
  sourceGeneration: number,
  transformGeneration: number,
): void {
  if (
    !prepared ||
    prepared.node.key !== requestedNode.key ||
    prepared.node.pointCount !== requestedNode.pointCount ||
    prepared.pointData.pointCount !== requestedNode.pointCount ||
    prepared.sourceIdentity !== source.source ||
    prepared.sourceGeneration !== sourceGeneration ||
    prepared.transformGeneration !== transformGeneration ||
    prepared.sourceGeneration !== source.sourceGeneration ||
    prepared.transformGeneration !== source.transformGeneration ||
    prepared.transformPlan.identity.key !== source.transformPlan.identity.key ||
    prepared.ecefBoundsKind !== 'decoded-point-content'
  ) {
    throw new CopcCoreAdapterError('NODE_MISMATCH', 'Adapter preparation returned stale data or mismatched node/source provenance.', requestedNode.key);
  }
}

const CONSERVATIVE_BOUNDS_REASON_CODES = new Set([
  'unsupported-horizontal-crs',
  'unsupported-horizontal-units',
  'unsupported-axis-order',
  'unsupported-coordinate-epoch',
  'unsupported-vertical-reference',
  'unsupported-vertical-grid',
  'vertical-grid-has-nodata-sentinel',
  'vertical-grid-outside-cell-coverage',
  'invalid-source-cell',
  'unsupported-geographic-cell',
  'numeric-range',
]);

function validateConservativeBoundsResult(
  result: CopcConservativeBoundsResult,
  nodeKey: string,
  source: CopcConservativeNodeSource,
  sourceGeneration: number,
  transformGeneration: number,
): void {
  if (!isRecord(result)) {
    throw new CopcCoreAdapterError('INVALID_CONSERVATIVE_BOUNDS', 'Adapter returned a non-object conservative-bounds result.', nodeKey);
  }
  const sourceCellBounds = result.sourceCellBounds;
  const resultGrid = result.verticalGrid;
  const plannedGrid = source.transformPlan.verticalGrid;
  if (
    result.nodeKey !== nodeKey ||
    result.sourceIdentity !== source.source ||
    result.sourceGeneration !== sourceGeneration ||
    result.transformGeneration !== transformGeneration ||
    result.transformPlanIdentity !== source.transformPlan.identity.key ||
    result.sourceCoordinateSystem !== 'copc-source' ||
    result.heightOffsetMeters !== source.transformPlan.manualHeightOffsetMeters ||
    (resultGrid === undefined) !== (plannedGrid === undefined) ||
    (resultGrid !== undefined && (
      !isConservativeBoundsGridProvenance(resultGrid) ||
      !sameValue(resultGrid, plannedGrid)
    )) ||
    !isRecord(sourceCellBounds) ||
    !validBounds(sourceCellBounds) ||
    !sameBounds(sourceCellBounds, source.getNodeCellBounds(nodeKey))
  ) {
    throw new CopcCoreAdapterError('INVALID_CONSERVATIVE_BOUNDS', 'Adapter conservative bounds have mismatched source, transform, node, or source-cell provenance.', nodeKey);
  }

  if (result.status === 'supported') {
    const bounds = result.boundsEcef;
    if (
      !isRecord(bounds) ||
      bounds.coordinateSystem !== 'wgs84-ecef-meters' ||
      !validBounds(bounds) ||
      result.coverage !== 'full-source-cell-and-descendant-cells' ||
      result.method !== 'wgs84-geodetic-interval-v1' ||
      result.verification !== 'analytic-interval' ||
      !['ellipsoidal', 'validated-grid'].includes(result.verticalReference as string) ||
      typeof result.sourceVerticalUnitToMeters !== 'number' ||
      !Number.isFinite(result.sourceVerticalUnitToMeters) || result.sourceVerticalUnitToMeters <= 0 ||
      (source.transformPlan.source.verticalUnitConversion?.scaleToMeters !== undefined &&
        result.sourceVerticalUnitToMeters !== source.transformPlan.source.verticalUnitConversion.scaleToMeters) ||
      (result.verticalReference === 'validated-grid' &&
        (resultGrid === undefined || resultGrid.compatibility !== 'validated' || resultGrid.noDataValue !== null)) ||
      (resultGrid !== undefined &&
        (resultGrid.compatibility !== 'validated' || resultGrid.noDataValue !== null)) ||
      result.encoderErrorPaddingRequired !== true ||
      !Array.isArray(result.assumptions) || result.assumptions.some((assumption) => typeof assumption !== 'string')
    ) {
      throw new CopcCoreAdapterError('INVALID_CONSERVATIVE_BOUNDS', 'Adapter returned malformed or uncertified supported ECEF bounds.', nodeKey);
    }
    return;
  }

  if (
    result.status !== 'unsupported' ||
    typeof result.reasonCode !== 'string' ||
    !CONSERVATIVE_BOUNDS_REASON_CODES.has(result.reasonCode) ||
    typeof result.reason !== 'string' || result.reason.trim() === '' ||
    'boundsEcef' in result
  ) {
    throw new CopcCoreAdapterError('INVALID_CONSERVATIVE_BOUNDS', 'Adapter returned a malformed unsupported conservative-bounds result.', nodeKey);
  }
}

function validBounds(value: Record<string, unknown>): boolean {
  const coordinates = [value.minX, value.minY, value.minZ, value.maxX, value.maxY, value.maxZ];
  return coordinates.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) &&
    (value.minX as number) <= (value.maxX as number) &&
    (value.minY as number) <= (value.maxY as number) &&
    (value.minZ as number) <= (value.maxZ as number);
}

function sameBounds(a: Record<string, unknown>, b: CopcHierarchyBounds): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.minZ === b.minZ &&
    a.maxX === b.maxX && a.maxY === b.maxY && a.maxZ === b.maxZ;
}

function isConservativeBoundsGridProvenance(value: unknown): value is TileConservativeBoundsGridProvenance {
  if (!isRecord(value) || !isRecord(value.longitude) || !isRecord(value.latitude)) return false;
  const numbers = [
    value.longitude.min, value.longitude.max,
    value.latitude.min, value.latitude.max,
    value.minimumUndulationMeters, value.maximumUndulationMeters,
  ];
  return typeof value.id === 'string' && value.id.trim() !== '' &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256) &&
    typeof value.sourceVerticalCrs === 'string' && value.sourceVerticalCrs.trim() !== '' &&
    value.targetVerticalCrs === 'EPSG:4979' &&
    value.samplingHorizontalCrs === 'EPSG:4326' &&
    value.referenceEllipsoid === 'WGS84' &&
    value.interpolation === 'bilinear' &&
    typeof value.valueUnit === 'string' && value.valueUnit.trim() !== '' &&
    value.valueConvention === 'ellipsoidal-minus-orthometric' &&
    (value.noDataValue === null || (typeof value.noDataValue === 'number' && Number.isFinite(value.noDataValue))) &&
    Number.isSafeInteger(value.width) && (value.width as number) > 0 &&
    Number.isSafeInteger(value.height) && (value.height as number) > 0 &&
    value.longitude.coverage !== undefined &&
    ['none', 'duplicated-seam', 'periodic'].includes(value.longitude.coverage as string) &&
    numbers.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)) &&
    (value.longitude.min as number) <= (value.longitude.max as number) &&
    (value.latitude.min as number) <= (value.latitude.max as number) &&
    (value.minimumUndulationMeters as number) <= (value.maximumUndulationMeters as number) &&
    (value.sourceCoordinateEpoch === undefined || (typeof value.sourceCoordinateEpoch === 'number' && Number.isFinite(value.sourceCoordinateEpoch))) &&
    (value.gridReferenceEpoch === undefined || (typeof value.gridReferenceEpoch === 'number' && Number.isFinite(value.gridReferenceEpoch))) &&
    (value.compatibility === 'validated' || value.compatibility === 'unsupported') &&
    (value.compatibilityMessage === undefined || typeof value.compatibilityMessage === 'string');
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function validateDecodedPointBounds(prepared: CopcPreparedNodeData, nodeKey: string): void {
  const bounds = prepared.ecefBounds;
  if (prepared.pointData.pointCount === 0) {
    if (bounds !== undefined) {
      throw new CopcCoreAdapterError('INVALID_PREPARED_BOUNDS', 'An empty decoded node cannot have point-content ECEF bounds.', nodeKey);
    }
    return;
  }
  if (bounds === undefined) return;
  const values = [bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ];
  if (
    bounds.coordinateSystem !== 'wgs84-ecef-meters' ||
    values.some((value) => !Number.isFinite(value)) ||
    bounds.minX > bounds.maxX || bounds.minY > bounds.maxY || bounds.minZ > bounds.maxZ
  ) {
    throw new CopcCoreAdapterError('INVALID_PREPARED_BOUNDS', 'Adapter returned malformed decoded-point ECEF bounds.', nodeKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function freezeMetadataCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeMetadataCopy(entry))) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, freezeMetadataCopy(entry)]),
  );
  return Object.freeze(copy) as T;
}

function combineSignals(
  requestSignal?: AbortSignal,
  lifecycleSignal?: AbortSignal,
): Readonly<{ signal: AbortSignal; dispose: () => void }> {
  const controller = new AbortController();
  const relayRequest = (): void => controller.abort(requestSignal?.reason);
  const relayLifecycle = (): void => controller.abort(lifecycleSignal?.reason);
  if (requestSignal?.aborted) relayRequest();
  else requestSignal?.addEventListener('abort', relayRequest, { once: true });
  if (lifecycleSignal?.aborted) relayLifecycle();
  else lifecycleSignal?.addEventListener('abort', relayLifecycle, { once: true });
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      requestSignal?.removeEventListener('abort', relayRequest);
      lifecycleSignal?.removeEventListener('abort', relayLifecycle);
    },
  });
}
