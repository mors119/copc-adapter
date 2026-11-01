import {
  resolveCopcBackend,
  type CopcBackendSelection,
} from "../backend/selection";
import type {
  CopcBackendOpenOptions,
  CopcPointLoadOptions,
  CopcSource,
} from "../backend/types";
import { CopcBackendError, CopcLoadError, CopcSourceError } from "../errors";
import { getCopcHierarchyCellBounds } from "../hierarchy/HierarchyLoader";
import type {
  CopcHierarchyBounds,
  CopcHierarchyPageLoadOptions,
  CopcHierarchySource,
  CopcHierarchySubtree,
} from "../hierarchy/types";
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
  PreparedPointData,
} from "../types/copc";
import {
  applyPreparedPointHeightOffset,
  applyPreparedPointVerticalGrid,
  transformPointBufferToPreparedPointData,
} from "../../coordinates/transform/createPointTransformer";
import {
  getCoordinateTransformPlan,
  type CoordinateTransformPlan,
} from "../../coordinates/transform/coordinateTransformPlan";
import type { GtxGeoidGrid } from "../../coordinates/transform/verticalGrid";
import type { Wgs84EcefBounds } from "../../coordinates/types";
import { decodeCopcPointBuffer } from "../../wasm/copcDecoder";
import {
  assertPreparedPointData,
  getPreparedCoordinateOperations,
  getPreparedEcefBounds,
  recordPreparedCoordinateOperations,
} from "../../point/preparedPoint";
import {
  type CopcPointField,
  type CopcPointFieldSelection,
} from "../points/fieldSelection";
import type { CopcPerformanceObserver } from "../performance";
import type { CopcWorkerDiagnostics } from "../backend/types";
import type { CopcInputSource } from "../range/types";
import {
  getConservativeNodeEcefBounds as evaluateConservativeNodeEcefBounds,
} from "./getConservativeNodeEcefBounds";
import type { CopcConservativeBoundsResult } from "./conservativeBounds";
import {
  getCopcSourceIdentity,
  isBlobSource,
} from "../getter/createCopcGetter";

/** Source-open configuration plus an optional validated vertical grid. */
export type CopcContextOptions = CopcBackendOpenOptions & Readonly<{
  /** Verified grid used to convert orthometric heights to WGS84 ellipsoidal height. */
  verticalGrid?: GtxGeoidGrid;
}>;

/** Prepared data and provenance for one decoded node. */
export type CopcPreparedNodeData = Readonly<{
  /** Stable COPC node identity, including any known child completeness. */
  node: Readonly<CopcHierarchyNode>;
  /** Point data in the existing A-shaped source/geographic/ECEF Float64 contract. */
  pointData: PreparedPointData;
  /** Standard fields actually present in this node's result. */
  availableFields: ReadonlySet<CopcPointField>;
  /** Exact named Extra Dimensions returned for this node. */
  availableExtraDimensions: readonly string[];
  /** Tight bound over transformed points in this node; absent for an empty node. */
  ecefBounds?: Readonly<Wgs84EcefBounds>;
  /** Identifies `ecefBounds` as a point-content bound, not a transformed octree-cell bound. */
  ecefBoundsKind: "decoded-point-content";
  /** Source identity for this result. */
  sourceIdentity: string;
  /** Unique lifetime generation assigned when this context opens. */
  sourceGeneration: number;
  /** Immutable transform generation; equal to `sourceGeneration` for this context. */
  transformGeneration: number;
  /** CRS, unit, vertical-grid, height-offset and operation-order provenance. */
  transformPlan: CoordinateTransformPlan;
}>;

/** Minimal read-only, renderer-neutral node-source contract for external schedulers. */
export interface CopcNodeSource extends CopcHierarchySource {
  /** Stable resource identity, such as the input URL or caller-owned byte source identity. */
  readonly source: string;
  /** Generation allocated when this source lifetime opens. */
  readonly sourceGeneration: number;
  /** Generation of the immutable coordinate-transform plan. */
  readonly transformGeneration: number;
  /** Immutable CRS, units, vertical reference, correction, and operation provenance. */
  readonly transformPlan: CoordinateTransformPlan;
  /** Source-level LAS/COPC metadata and CRS evidence. */
  getMetadata(): CopcMetadata;
  /** Whether the context remains valid for this source generation. */
  isCurrent(generation?: number): boolean;
  /** Source-coordinate octree cell bounds for one node key. */
  getNodeCellBounds(nodeKey: string): CopcHierarchyBounds;
  /** Decode one selected node into the A-shaped WGS84 ECEF Float64 contract. */
  loadPreparedNodeData(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ): Promise<CopcPreparedNodeData>;
  /** Close the source and invalidate pending requests and results. */
  close(): void;
}

/** `CopcNodeSource` with the optional conservative source-cell bounds capability. */
export interface CopcConservativeNodeSource extends CopcNodeSource {
  /**
   * Return a metadata-only conservative WGS 84 ECEF bound for the full source
   * cell identified by `nodeKey`, or an explicit unsupported result.
   *
   * This synchronous operation reads no point payload and performs no network
   * request. Supported bounds use ECEF metres and enclose the complete source
   * cell plus its spatial octree descendants; the result identifies this
   * context's source and immutable transform generations. Projected and other
   * transformations without a proven region enclosure return `unsupported`.
   * `getNodeCellBounds()` remains a COPC source CRS bound, while
   * `loadPreparedNodeData().ecefBounds` remains a decoded-point content bound.
   * Tile content encoders must add their own proven reconstruction-error
   * padding. Closed contexts throw `CopcStaleSourceError`.
   */
  getConservativeNodeEcefBounds(nodeKey: string): CopcConservativeBoundsResult;
}

/** Raised when a result belongs to a closed or superseded source context. */
export class CopcStaleSourceError extends Error {
  /** Generation that produced the stale operation. */
  readonly sourceGeneration: number;

  constructor(sourceGeneration: number) {
    super(`COPC source generation ${sourceGeneration} is closed or stale`);
    this.name = "CopcStaleSourceError";
    this.sourceGeneration = sourceGeneration;
  }
}

type LinkedAbortSignal = Readonly<{
  signal: AbortSignal;
  dispose(): void;
}>;

function linkAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): LinkedAbortSignal {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose(): void {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function createAbortError(signal: AbortSignal): Error {
  const error = new Error("COPC source request was cancelled", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw createAbortError(signal);
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (!value || typeof value !== "object") return value;
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)]),
  );
  return Object.freeze(clone) as T;
}

function waitForOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function parseNodeKey(key: string): {
  level: number;
  x: number;
  y: number;
  z: number;
} {
  if (typeof key !== "string" || key.length > 128) {
    throw new TypeError("COPC hierarchy node key must be a short string");
  }
  const values = key.split("-").map(Number);
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError(`Invalid COPC hierarchy node key: ${key}`);
  }
  const [level, x, y, z] = values;
  if (
    level > 31 ||
    x >= 2 ** level ||
    y >= 2 ** level ||
    z >= 2 ** level ||
    key !== `${level}-${x}-${y}-${z}`
  ) {
    throw new TypeError(`COPC hierarchy node key is outside its level: ${key}`);
  }
  return { level, x, y, z };
}

function assertPageReference(page: CopcHierarchyPage): void {
  if (!page || typeof page !== "object") {
    throw new TypeError("COPC hierarchy page must be an object");
  }
  parseNodeKey(page.key);
  if (
    !Number.isSafeInteger(page.pageOffset) ||
    page.pageOffset < 0 ||
    !Number.isSafeInteger(page.pageLength) ||
    page.pageLength <= 0 ||
    !Number.isSafeInteger(page.pageOffset + page.pageLength)
  ) {
    throw new RangeError("COPC hierarchy page offset or length is invalid");
  }
}

function assertNode(node: CopcHierarchyNode): void {
  if (!node || typeof node !== "object") {
    throw new TypeError("COPC hierarchy node must be an object");
  }
  const key = parseNodeKey(node.key);
  if (
    node.level !== key.level ||
    node.x !== key.x ||
    node.y !== key.y ||
    node.z !== key.z
  ) {
    throw new TypeError(`COPC node coordinates do not match its key: ${node.key}`);
  }
  if (
    !Number.isSafeInteger(node.pointCount) ||
    node.pointCount < 0 ||
    !Number.isSafeInteger(node.pointDataOffset) ||
    node.pointDataOffset < 0 ||
    !Number.isSafeInteger(node.pointDataLength) ||
    node.pointDataLength < 0 ||
    !Number.isSafeInteger(node.pointDataOffset + node.pointDataLength) ||
    (node.pointCount > 0 && node.pointDataLength === 0)
  ) {
    throw new RangeError(`COPC node range or point count is invalid: ${node.key}`);
  }
  if (node.childrenComplete !== undefined && typeof node.childrenComplete !== "boolean") {
    throw new TypeError(`COPC node child-completeness state is invalid: ${node.key}`);
  }
  if (node.children !== undefined) {
    if (!Array.isArray(node.children) || new Set(node.children).size !== node.children.length) {
      throw new TypeError(`COPC node child list is invalid: ${node.key}`);
    }
    for (const childKey of node.children) {
      const child = parseNodeKey(childKey);
      if (
        child.level !== key.level + 1 ||
        Math.floor(child.x / 2) !== key.x ||
        Math.floor(child.y / 2) !== key.y ||
        Math.floor(child.z / 2) !== key.z
      ) {
        throw new TypeError(`COPC child key does not belong to ${node.key}: ${childKey}`);
      }
    }
  }
}

function validateSubtree(value: CopcHierarchySubtree): CopcHierarchySubtree {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.pages)) {
    throw new TypeError("COPC hierarchy page result must contain node and page arrays");
  }
  const nodeKeys = new Set<string>();
  for (const node of value.nodes) {
    assertNode(node);
    if (nodeKeys.has(node.key)) {
      throw new TypeError(`COPC hierarchy page repeats node key: ${node.key}`);
    }
    nodeKeys.add(node.key);
  }
  const pageKeys = new Set<string>();
  for (const page of value.pages) {
    assertPageReference(page);
    if (pageKeys.has(page.key) || nodeKeys.has(page.key)) {
      throw new TypeError(`COPC hierarchy page repeats an entry key: ${page.key}`);
    }
    pageKeys.add(page.key);
  }
  return Object.freeze({
    nodes: Object.freeze(value.nodes.map(snapshotNode)) as unknown as CopcHierarchyNode[],
    pages: Object.freeze(
      value.pages.map((page) => Object.freeze({ ...page })),
    ) as unknown as CopcHierarchyPage[],
  });
}

function snapshotNode(node: CopcHierarchyNode): Readonly<CopcHierarchyNode> {
  return Object.freeze({
    ...node,
    ...(node.children ? { children: Object.freeze([...node.children]) as unknown as string[] } : {}),
  });
}

function snapshotPointFields(
  fields: CopcPointFieldSelection,
): CopcPointFieldSelection {
  if (
    !fields ||
    typeof fields.has !== "function" ||
    typeof fields[Symbol.iterator] !== "function"
  ) {
    throw new TypeError("COPC node fields must be an iterable field selection");
  }
  const snapshot = new Set(fields);
  for (const field of snapshot) {
    if (
      field !== "position" &&
      field !== "rgb" &&
      field !== "intensity" &&
      field !== "classification"
    ) {
      throw new TypeError(`Unsupported COPC point field: ${String(field)}`);
    }
  }
  if (!snapshot.has("position")) {
    throw new TypeError("COPC node requests must include the position field");
  }
  return snapshot;
}

function snapshotPointLoadOptions(
  options: CopcPointLoadOptions,
): CopcPointLoadOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("COPC point-load options must be an object");
  }
  if (options.extraDimensions !== undefined && !Array.isArray(options.extraDimensions)) {
    throw new TypeError("COPC Extra Dimension requests must be an array of exact names");
  }
  if (options.extraDimensions) {
    for (const name of options.extraDimensions) {
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new TypeError("COPC Extra Dimension names must be non-empty strings");
      }
    }
  }
  return {
    ...options,
    ...(options.extraDimensions
      ? { extraDimensions: [...options.extraDimensions] }
      : {}),
  };
}

function getAvailableFields(
  prepared: PreparedPointData,
): ReadonlySet<CopcPointField> {
  const fields = new Set<CopcPointField>(["position"]);
  const attributes = prepared.attributes;
  if (attributes?.intensity) fields.add("intensity");
  if (attributes?.classification) fields.add("classification");
  if (attributes?.red && attributes.green && attributes.blue) fields.add("rgb");
  return fields;
}

function assertPointBuffer(buffer: CopcPointBuffer): void {
  if (
    !buffer ||
    !Number.isSafeInteger(buffer.pointCount) ||
    buffer.pointCount < 0 ||
    buffer.pointCount > Number.MAX_SAFE_INTEGER / 3 ||
    !(buffer.coordinates instanceof Float64Array) ||
    buffer.coordinates.length !== buffer.pointCount * 3
  ) {
    throw new TypeError("COPC point buffer has an invalid point count or XYZ array");
  }
  for (const coordinate of buffer.coordinates) {
    if (!Number.isFinite(coordinate)) {
      throw new RangeError("COPC point buffer coordinates must be finite");
    }
  }
  const attributes = buffer.attributes;
  for (const [name, values] of Object.entries(attributes ?? {})) {
    if (!values) continue;
    if (name === "extraDimensions") {
      for (const [dimensionName, dimensionValues] of Object.entries(values)) {
        if (
          !(dimensionValues instanceof Float64Array) &&
          !(dimensionValues instanceof BigInt64Array) &&
          !(dimensionValues instanceof BigUint64Array)
        ) {
          throw new TypeError(`COPC Extra Dimension has an unsupported value array: ${dimensionName}`);
        }
        if (dimensionValues.length !== buffer.pointCount) {
          throw new RangeError(`COPC Extra Dimension length mismatch: ${dimensionName}`);
        }
      }
    } else if (values.length !== buffer.pointCount) {
      throw new RangeError(`COPC point attribute length mismatch: ${name}`);
    }
  }
}

let nextSourceGeneration = 0;

function allocateSourceGeneration(): number {
  nextSourceGeneration += 1;
  if (!Number.isSafeInteger(nextSourceGeneration)) {
    throw new RangeError("COPC source generation counter exceeded safe integer range");
  }
  return nextSourceGeneration;
}

/**
 * Renderer-neutral context around one opened COPC source.
 *
 * Each context owns one immutable transform plan and source generation. Close
 * it when replacing the source or transform policy; pending operations are
 * cancelled where their backend supports cancellation and stale results are
 * always rejected before they are returned.
 */
export class CopcContext implements CopcSource, CopcConservativeNodeSource {
  private readonly delegate: CopcSource;
  private readonly metadata: CopcMetadata;
  private readonly lifecycleController: AbortController;
  private readonly lifetimeLink: LinkedAbortSignal;
  private readonly verticalGrid?: GtxGeoidGrid;
  private closed = false;

  /** Unique lifetime generation for this opened source. */
  readonly sourceGeneration: number;
  /** Immutable transform generation for this source context. */
  readonly transformGeneration: number;
  /** Transform inputs, output systems, provenance and unsupported states. */
  readonly transformPlan: CoordinateTransformPlan;
  /** Height offset already included by the backend's legacy prepared-point method. */
  readonly preparedHeightOffsetMeters?: number;
  readonly loadPointDataBuffer?: (
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ) => Promise<CopcPointBuffer>;
  readonly loadPreparedPointData?: (
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options?: CopcPointLoadOptions,
  ) => Promise<PreparedPointData>;
  readonly setPerformanceObserver?: (
    observer: CopcPerformanceObserver | undefined,
  ) => void;
  readonly cancelPendingPointJobs?: () => void;
  readonly getWorkerDiagnostics?: () => CopcWorkerDiagnostics | undefined;

  private constructor(
    delegate: CopcSource,
    options: CopcContextOptions,
    sourceGeneration: number,
    lifecycleController: AbortController,
    lifetimeLink: LinkedAbortSignal,
  ) {
    this.delegate = delegate;
    this.metadata = cloneAndFreeze(delegate.getMetadata());
    this.sourceGeneration = sourceGeneration;
    this.transformGeneration = sourceGeneration;
    this.lifecycleController = lifecycleController;
    this.lifetimeLink = lifetimeLink;
    this.verticalGrid = options.verticalGrid;
    this.preparedHeightOffsetMeters = delegate.preparedHeightOffsetMeters;
    this.transformPlan = getCoordinateTransformPlan(this.metadata, {
      heightOffsetMeters: options.heightOffsetMeters,
      verticalGrid: options.verticalGrid,
    });

    if (delegate.loadPointDataBuffer) {
      this.loadPointDataBuffer = delegate.loadPointDataBuffer.bind(delegate);
    }
    if (delegate.loadPreparedPointData) {
      this.loadPreparedPointData =
        delegate.loadPreparedPointData.bind(delegate);
    }
    if (delegate.setPerformanceObserver) {
      this.setPerformanceObserver = delegate.setPerformanceObserver.bind(delegate);
    }
    if (delegate.cancelPendingPointJobs) {
      this.cancelPendingPointJobs = delegate.cancelPendingPointJobs.bind(delegate);
    }
    if (delegate.getWorkerDiagnostics) {
      this.getWorkerDiagnostics = delegate.getWorkerDiagnostics.bind(delegate);
    }
  }

  /** Resource identity used for range reads and diagnostics. */
  get source(): string {
    return this.delegate.source;
  }

  /** Return whether this context still owns the supplied result generation. */
  isCurrent(generation = this.sourceGeneration): boolean {
    return !this.closed && generation === this.sourceGeneration;
  }

  /** Open a source with the selected backend and immutable transform options. */
  static async create(
    source: CopcInputSource,
    backend: CopcBackendSelection = "copc-js",
    options: CopcContextOptions = {},
  ): Promise<CopcContext> {
    const lifecycleController = new AbortController();
    const optionsSnapshot: CopcContextOptions = {
      ...options,
      ...(Array.isArray(options.extraDimensions)
        ? { extraDimensions: [...options.extraDimensions] }
        : {}),
    };
    const lifetimeLink = linkAbortSignals([
      optionsSnapshot.signal,
      lifecycleController.signal,
    ]);
    const { verticalGrid, ...backendOptions } = optionsSnapshot;
    let delegate: CopcSource | undefined;
    try {
      throwIfAborted(lifetimeLink.signal);
      delegate = await resolveCopcBackend(backend).open(source, {
        ...backendOptions,
        signal: lifetimeLink.signal,
      });
      if (lifetimeLink.signal.aborted) throw createAbortError(lifetimeLink.signal);
      return new CopcContext(
        delegate,
        { ...backendOptions, verticalGrid },
        allocateSourceGeneration(),
        lifecycleController,
        lifetimeLink,
      );
    } catch (error: unknown) {
      delegate?.destroy?.();
      lifetimeLink.dispose();
      if (lifetimeLink.signal.aborted) throw createAbortError(lifetimeLink.signal);
      if (error instanceof CopcBackendError && error.stage === "source") {
        throw new CopcSourceError(getCopcSourceIdentity(source), {
          cause: error,
        });
      }
      if (error instanceof CopcLoadError) {
        throw error;
      }

      throw new CopcSourceError(getCopcSourceIdentity(source), {
        cause: error,
      });
    }
  }

  /** Return metadata parsed during source initialization. */
  getMetadata(): CopcMetadata {
    return this.metadata;
  }

  /** Return the root hierarchy page reference. */
  getRootHierarchyPage(): CopcHierarchyPage {
    this.assertOpen();
    const page = this.delegate.getRootHierarchyPage();
    assertPageReference(page);
    return Object.freeze({ ...page });
  }

  /** Load one hierarchy page. Aborting this request does not cancel other reads. */
  loadHierarchyPage(
    page: CopcHierarchyPage,
    options: CopcHierarchyPageLoadOptions = {},
  ): Promise<CopcHierarchySubtree> {
    assertPageReference(page);
    const pageSnapshot = Object.freeze({ ...page });
    const optionsSnapshot = { ...options };
    return this.withRequest(optionsSnapshot.signal, async (signal) => {
      const requestOptions: CopcHierarchyPageLoadOptions = { ...optionsSnapshot };
      // HierarchyLoader shares page reads between callers. Only forward a
      // caller-owned signal when this API call explicitly supplied one; the
      // source lifecycle signal was already attached at backend open.
      if (optionsSnapshot.signal) requestOptions.signal = signal;
      else delete requestOptions.signal;
      return validateSubtree(
        await this.delegate.loadHierarchyPage(pageSnapshot, requestOptions),
      );
    });
  }

  /** Load a point view for one selected node and requested source fields. */
  loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options: CopcPointLoadOptions = {},
  ): Promise<CopcPointView> {
    return this.delegate.loadPointDataView(node, fields, options);
  }

  /**
   * Return the source-CRS octree cell for a node key.
   *
   * The returned axes and units come from the COPC metadata cube. This is not
   * an ECEF bound; use `loadPreparedNodeData()` for a proven point-content bound.
   */
  getNodeCellBounds(nodeKey: string): CopcHierarchyBounds {
    assertNodeKey(nodeKey);
    return Object.freeze(getCopcHierarchyCellBounds(nodeKey, this.metadata.cube));
  }

  /** @inheritdoc */
  getConservativeNodeEcefBounds(nodeKey: string): CopcConservativeBoundsResult {
    this.assertOpen();
    assertNodeKey(nodeKey);
    let sourceCellBounds: CopcHierarchyBounds;
    try {
      sourceCellBounds = getCopcHierarchyCellBounds(nodeKey, this.metadata.cube);
    } catch (error: unknown) {
      const fallbackBounds = this.metadata.cube;
      return Object.freeze({
        status: "unsupported",
        nodeKey,
        sourceCellBounds: Object.freeze({ ...fallbackBounds }),
        sourceCoordinateSystem: "copc-source",
        sourceIdentity: this.source,
        sourceGeneration: this.sourceGeneration,
        transformGeneration: this.transformGeneration,
        transformPlanIdentity: this.transformPlan.identity.key,
        heightOffsetMeters: this.transformPlan.manualHeightOffsetMeters,
        ...(this.transformPlan.verticalGrid
          ? { verticalGrid: this.transformPlan.verticalGrid }
          : {}),
        reasonCode: "invalid-source-cell",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return evaluateConservativeNodeEcefBounds(
      {
        metadata: this.metadata,
        sourceIdentity: this.source,
        sourceGeneration: this.sourceGeneration,
        transformGeneration: this.transformGeneration,
        transformPlan: this.transformPlan,
        verticalGrid: this.verticalGrid,
      },
      nodeKey,
      sourceCellBounds,
    );
  }

  /**
   * Decode one node and prepare read-only WGS84 ECEF Float64 point data.
   *
   * The result owns ordinary JavaScript typed arrays that remain readable
   * after this context closes. Callers may retain the arrays, but must not
   * mutate or transfer their buffers. HTTP ranges and Rust worker jobs honor
   * cancellation where supported; synchronous copc-js decoding can only be
   * rejected after it finishes. Source close and caller abort always prevent
   * stale results from being returned.
   */
  async loadPreparedNodeData(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
    options: CopcPointLoadOptions = {},
  ): Promise<CopcPreparedNodeData> {
    assertNode(node);
    const nodeSnapshot: CopcHierarchyNode = {
      ...node,
      ...(node.children ? { children: [...node.children] } : {}),
    };
    const fieldsSnapshot = snapshotPointFields(fields);
    const optionsSnapshot = snapshotPointLoadOptions(options);
    return this.withRequest(optionsSnapshot.signal, async (signal) => {
      const loadOptions = { ...optionsSnapshot, signal };
      let prepared: PreparedPointData;
      if (this.delegate.loadPreparedPointData) {
        prepared = await this.delegate.loadPreparedPointData(
          nodeSnapshot,
          fieldsSnapshot,
          loadOptions,
        );
        throwIfAborted(signal);
        assertPreparedPointData(prepared);
        if (prepared.pointCount !== nodeSnapshot.pointCount) {
          throw new RangeError(`Prepared point count does not match node ${nodeSnapshot.key}`);
        }
        const alreadyAppliedOffset = this.delegate.preparedHeightOffsetMeters ?? 0;
        recordPreparedCoordinateOperations(prepared, {
          manualHeightOffsetMeters: alreadyAppliedOffset,
        });
        if (this.verticalGrid) {
          if (this.transformPlan.verticalGrid?.compatibility !== "validated") {
            throw new Error(
              this.transformPlan.verticalGrid?.compatibilityMessage ??
                "The configured vertical grid is unsupported for this COPC source",
            );
          }
          prepared = applyPreparedPointVerticalGrid(prepared, this.verticalGrid, {
            alreadyAppliedHeightOffsetMeters: alreadyAppliedOffset,
            targetHeightOffsetMeters: this.transformPlan.manualHeightOffsetMeters,
          });
        } else {
          const priorOperations = getPreparedCoordinateOperations(prepared);
          if (priorOperations?.verticalGridIdentity) {
            throw new Error(
              "Backend-prepared node contains a vertical grid absent from this transform plan",
            );
          }
          prepared = applyPreparedPointHeightOffset(
            prepared,
            this.transformPlan.manualHeightOffsetMeters - alreadyAppliedOffset,
          );
        }
      } else {
        const points = this.delegate.loadPointDataBuffer
          ? await this.delegate.loadPointDataBuffer(nodeSnapshot, fieldsSnapshot, loadOptions)
          : await decodeCopcPointBuffer(
              await this.delegate.loadPointDataView(nodeSnapshot, fieldsSnapshot, loadOptions),
            );
        throwIfAborted(signal);
        assertPointBuffer(points);
        if (points.pointCount !== nodeSnapshot.pointCount) {
          throw new RangeError(`COPC point buffer count does not match node ${nodeSnapshot.key}`);
        }
        if (
          this.verticalGrid &&
          this.transformPlan.verticalGrid?.compatibility !== "validated"
        ) {
          throw new Error(
            this.transformPlan.verticalGrid?.compatibilityMessage ??
              "The configured vertical grid is unsupported for this COPC source",
          );
        }
        prepared = transformPointBufferToPreparedPointData(
          this.metadata,
          points,
          this.transformPlan.manualHeightOffsetMeters,
          this.verticalGrid,
        );
      }

      assertPreparedPointData(prepared);
      const ecefBounds = getPreparedEcefBounds(prepared);
      const extraDimensions = Object.keys(
        prepared.attributes?.extraDimensions ?? {},
      );
      return Object.freeze({
        node: snapshotNode(nodeSnapshot),
        pointData: prepared,
        availableFields: getAvailableFields(prepared),
        availableExtraDimensions: Object.freeze(extraDimensions),
        ...(ecefBounds ? { ecefBounds } : {}),
        ecefBoundsKind: "decoded-point-content" as const,
        sourceIdentity: this.source,
        sourceGeneration: this.sourceGeneration,
        transformGeneration: this.transformGeneration,
        transformPlan: this.transformPlan,
      });
    });
  }

  /**
   * Close this source context and invalidate all pending operations.
   *
   * Idempotent. Closing one context never cancels another context or source.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifecycleController.abort("lifecycle");
    this.lifetimeLink.dispose();
    this.delegate.cancelPendingPointJobs?.();
    this.delegate.destroy?.();
  }

  /** Compatibility alias for source implementations that use `destroy()`. */
  destroy(): void {
    this.close();
  }

  private assertOpen(): void {
    if (this.closed || this.lifetimeLink.signal.aborted) {
      throw new CopcStaleSourceError(this.sourceGeneration);
    }
  }

  private async withRequest<T>(
    signal: AbortSignal | undefined,
    operation: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const linked = linkAbortSignals([this.lifetimeLink.signal, signal]);
    try {
      this.assertOpen();
      if (signal?.aborted) throw createAbortError(signal);
      const result = await waitForOperation(
        Promise.resolve().then(() => operation(linked.signal)),
        linked.signal,
      );
      this.assertOpen();
      if (signal?.aborted) throw createAbortError(signal);
      return result;
    } catch (error: unknown) {
      if (this.closed || this.lifetimeLink.signal.aborted) {
        throw new CopcStaleSourceError(this.sourceGeneration);
      }
      if (signal?.aborted) throw createAbortError(signal);
      throw error;
    } finally {
      linked.dispose();
    }
  }
}

function assertNodeKey(nodeKey: string): void {
  parseNodeKey(nodeKey);
}

export type CopcContextInput = CopcInputSource | CopcSource;

/** Open an HTTP, File/Blob, or random-access source using the selected backend. */
export async function createCopcContext(
  source: CopcInputSource,
  backend: CopcBackendSelection = "copc-js",
  options: CopcContextOptions = {},
): Promise<CopcContext> {
  return CopcContext.create(source, backend, options);
}

/** Resolve an input source to a context or reuse an already-open project source. */
export async function resolveCopcContext(
  input: CopcContextInput,
  backend: CopcBackendSelection = "copc-js",
): Promise<CopcSource> {
  if (
    typeof input === "string" ||
    isBlobSource(input) ||
    "readRange" in input
  ) {
    return createCopcContext(input as CopcInputSource, backend);
  }

  return input;
}
