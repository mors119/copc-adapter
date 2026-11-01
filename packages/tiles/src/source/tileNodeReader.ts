import {
  snapshotTilePointFieldSelection,
  validateTilePointView,
  type TilePointFieldSelection,
  type TilePointView,
} from '../input/tilePointView.js';
import {
  TileNodeReaderError,
  type TileHierarchyNode,
  type TileHierarchyScanOptions,
  type TileHierarchyPage,
  type TileHierarchyPageResult,
  type TileNodeHierarchy,
  type TileNodeReadOptions,
  type TileNodeReaderLimits,
  type TileNodeSource,
} from './tileNodeSource.js';

const DEFAULT_LIMITS = Object.freeze({
  maxHierarchyPages: 512,
  maxHierarchyPageBytes: 16 * 1024 * 1024,
  maxTotalHierarchyPageBytes: 64 * 1024 * 1024,
  maxHierarchyNodes: 500_000,
  maxNodesPerPage: 100_000,
  maxRequestedNodes: 512,
  maxSelectedExtraDimensions: 64,
  maxPointsPerNode: 2_000_000,
  maxTotalPoints: 4_000_000,
  maxPointDataBytesPerNode: 128 * 1024 * 1024,
  maxTotalPointDataBytes: 256 * 1024 * 1024,
  maxDecodedBytesPerNode: 192 * 1024 * 1024,
  maxTotalDecodedBytes: 384 * 1024 * 1024,
  maxConcurrentNodeReads: 4,
});

const HARD_LIMITS = Object.freeze({
  maxHierarchyPages: 4096,
  maxHierarchyPageBytes: 64 * 1024 * 1024,
  maxTotalHierarchyPageBytes: 256 * 1024 * 1024,
  maxHierarchyNodes: 2_000_000,
  maxNodesPerPage: 250_000,
  maxRequestedNodes: 2048,
  maxSelectedExtraDimensions: 256,
  maxPointsPerNode: 10_000_000,
  maxTotalPoints: 20_000_000,
  maxPointDataBytesPerNode: 512 * 1024 * 1024,
  maxTotalPointDataBytes: 1024 * 1024 * 1024,
  maxDecodedBytesPerNode: 768 * 1024 * 1024,
  maxTotalDecodedBytes: 1536 * 1024 * 1024,
  maxConcurrentNodeReads: 16,
});

type Limits = Readonly<{ [Key in keyof typeof DEFAULT_LIMITS]: number }>;

/**
 * Resolves only requested node keys. Hierarchy pages are loaded on demand and
 * node point payloads are read only after every requested node has been found.
 */
export class TileNodeReader {
  readonly #source: TileNodeSource;
  readonly #sourceIdentity: string;
  readonly #sourceGeneration: number | undefined;
  readonly #transformGeneration: number;
  readonly #limits: Limits;
  /** Metadata retained only for a complete, explicitly requested hierarchy scan. */
  readonly #resolvedNodes = new Map<string, TileHierarchyNode>();

  constructor(source: TileNodeSource, limits: TileNodeReaderLimits = {}) {
    if (!source || typeof source !== 'object') {
      throw new TileNodeReaderError('INVALID_REQUEST', 'A TileNodeSource is required.');
    }
    if (typeof source.sourceIdentity !== 'string' || source.sourceIdentity.trim() === '') {
      throw new TileNodeReaderError('INVALID_REQUEST', 'sourceIdentity must be a non-empty opaque identifier.');
    }
    if (!Number.isSafeInteger(source.transformGeneration) || source.transformGeneration < 0) {
      throw new TileNodeReaderError('INVALID_REQUEST', 'transformGeneration must be a non-negative safe integer.');
    }
    if (source.sourceGeneration !== undefined && (!Number.isSafeInteger(source.sourceGeneration) || source.sourceGeneration < 0)) {
      throw new TileNodeReaderError('INVALID_REQUEST', 'sourceGeneration must be a non-negative safe integer when provided.');
    }
    this.#source = source;
    this.#sourceIdentity = source.sourceIdentity;
    this.#sourceGeneration = source.sourceGeneration;
    this.#transformGeneration = source.transformGeneration;
    this.#limits = normalizeLimits(limits);
  }

  async readNodes(
    nodeKeys: readonly string[],
    selection: TilePointFieldSelection = {},
    options: TileNodeReadOptions = {},
  ): Promise<ReadonlyMap<string, TilePointView>> {
    const fields = snapshotTilePointFieldSelection(selection);
    const extraDimensionCount = fields.attributes?.extraDimensions?.length ?? 0;
    if (extraDimensionCount > this.#limits.maxSelectedExtraDimensions) {
      throw new TileNodeReaderError('REQUEST_LIMIT', `Requested ${extraDimensionCount} extra dimensions; limit is ${this.#limits.maxSelectedExtraDimensions}.`);
    }
    const uniqueKeys = normalizeRequestedKeys(nodeKeys, this.#limits.maxRequestedNodes);
    if (uniqueKeys.length === 0) return new Map();

    const batch = createBatchSignal(options.signal);
    try {
      this.#assertCurrent(batch.signal);
      const nodes = await this.#resolveNodes(uniqueKeys, batch.signal);
      this.#assertCurrent(batch.signal);
      const nodeList = uniqueKeys.map((key) => {
        const node = nodes.get(key);
        if (!node) throw new TileNodeReaderError('NODE_NOT_FOUND', `Requested node "${key}" was not resolved.`, { nodeKey: key });
        return node;
      });
      this.#assertPointBudget(nodeList);

      const views = await this.#loadNodeViews(nodeList, fields, batch);
      this.#assertCurrent(batch.signal);
      const result = new Map<string, TilePointView>();
      for (const node of nodeList) {
        const view = views.get(node.key);
        if (!view) {
          throw new TileNodeReaderError('NODE_CONTENT_MISMATCH', 'A requested node has no loaded point view.', { nodeKey: node.key });
        }
        result.set(node.key, view);
      }
      return result;
    } catch (error) {
      batch.controller.abort();
      if (options.signal?.aborted) {
        throw new TileNodeReaderError('ABORTED', 'Tile node read was cancelled.');
      }
      throw error;
    } finally {
      batch.dispose();
    }
  }

  /**
   * Explicitly scan every hierarchy page without reading point payloads.
   * This is opt-in and bounded by the same page, byte, and node limits as
   * requested-node reads. Every node must certify complete child discovery.
   */
  async readHierarchy(options: TileHierarchyScanOptions = {}): Promise<TileNodeHierarchy> {
    const batch = createBatchSignal(options.signal);
    try {
      this.#assertCurrent(batch.signal);
      const rootPage = validatePage(this.#source.getRootHierarchyPage(), this.#limits);
      const queue: TileHierarchyPage[] = [rootPage];
      const queuedPageSignatures = new Map<string, string>([[rootPage.key, pageSignature(rootPage)]]);
      const loadedPages = new Set<string>();
      const nodes = new Map<string, TileHierarchyNode>();
      let pageBytes = 0;

      while (queue.length > 0) {
        this.#assertCurrent(batch.signal);
        const page = queue.shift();
        if (!page) break;
        const signature = pageSignature(page);
        if (queuedPageSignatures.get(page.key) !== signature) {
          throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'A hierarchy page key refers to conflicting byte ranges.', { pageKey: page.key });
        }
        if (loadedPages.has(page.key)) continue;
        if (loadedPages.size >= this.#limits.maxHierarchyPages) {
          throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy page limit ${this.#limits.maxHierarchyPages} reached.`, { pageKey: page.key });
        }
        pageBytes += page.pageLength;
        if (!Number.isSafeInteger(pageBytes) || pageBytes > this.#limits.maxTotalHierarchyPageBytes) {
          throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy reads exceed ${this.#limits.maxTotalHierarchyPageBytes} bytes.`, { pageKey: page.key });
        }
        loadedPages.add(page.key);
        const rawResult = await this.#source.loadHierarchyPage(page, batch.signal);
        this.#assertCurrent(batch.signal);
        const result = validatePageResult(rawResult, page, this.#limits);
        for (const rawNode of result.nodes) {
          const node = validateNode(rawNode, this.#limits);
          const prior = nodes.get(node.key);
          if (prior && !sameNode(prior, node)) {
            throw new TileNodeReaderError('CONFLICTING_NODE', 'A hierarchy node key was returned with conflicting metadata.', { nodeKey: node.key, pageKey: page.key });
          }
          if (!prior && nodes.size >= this.#limits.maxHierarchyNodes) {
            throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy traversal exceeds ${this.#limits.maxHierarchyNodes} nodes.`, { pageKey: page.key });
          }
          nodes.set(node.key, node);
          if (!prior) options.onNode?.(node);
        }
        for (const rawChildPage of result.pages) {
          const childPage = validatePage(rawChildPage, this.#limits);
          const childSignature = pageSignature(childPage);
          const priorSignature = queuedPageSignatures.get(childPage.key);
          if (priorSignature !== undefined && priorSignature !== childSignature) {
            throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'A hierarchy page key refers to conflicting byte ranges.', { pageKey: childPage.key });
          }
          if (!priorSignature) {
            if (queuedPageSignatures.size >= this.#limits.maxHierarchyPages) {
              throw new TileNodeReaderError('HIERARCHY_LIMIT', `Discovered hierarchy pages exceed ${this.#limits.maxHierarchyPages}.`, { pageKey: childPage.key });
            }
            queuedPageSignatures.set(childPage.key, childSignature);
            queue.push(childPage);
          }
        }
      }

      if (nodes.size === 0) {
        throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'The loaded hierarchy contains no nodes.');
      }
      const incomplete = [...nodes.values()].find((node) => node.childrenComplete !== true);
      if (incomplete) {
        throw new TileNodeReaderError('INCOMPLETE_HIERARCHY', 'A complete hierarchy scan found a node without proven direct-child discovery.', { nodeKey: incomplete.key });
      }
      this.#assertCurrent(batch.signal);
      this.#resolvedNodes.clear();
      for (const node of nodes.values()) this.#resolvedNodes.set(node.key, node);
      return Object.freeze({
        nodes: Object.freeze([...nodes.values()]),
        hierarchyPagesRead: loadedPages.size,
        hierarchyPageBytesRead: pageBytes,
      });
    } catch (error) {
      batch.controller.abort();
      if (options.signal?.aborted) {
        throw new TileNodeReaderError('ABORTED', 'Tile hierarchy scan was cancelled.');
      }
      throw error;
    } finally {
      batch.dispose();
    }
  }

  /** Load a node retained by an explicit readHierarchy() scan without traversing pages again. */
  async readNode(
    rawNode: TileHierarchyNode,
    selection: TilePointFieldSelection = {},
    options: TileNodeReadOptions = {},
  ): Promise<TilePointView> {
    const fields = snapshotTilePointFieldSelection(selection);
    const extraDimensionCount = fields.attributes?.extraDimensions?.length ?? 0;
    if (extraDimensionCount > this.#limits.maxSelectedExtraDimensions) {
      throw new TileNodeReaderError('REQUEST_LIMIT', `Requested ${extraDimensionCount} extra dimensions; limit is ${this.#limits.maxSelectedExtraDimensions}.`);
    }
    const node = validateNode(rawNode, this.#limits);
    const knownNode = this.#resolvedNodes.get(node.key);
    if (!knownNode || !sameNode(knownNode, node)) {
      throw new TileNodeReaderError('NODE_NOT_FOUND', 'Point data can only be loaded for a node resolved from this source hierarchy.', { nodeKey: node.key });
    }
    this.#assertPointBudget([node]);
    const batch = createBatchSignal(options.signal);
    try {
      this.#assertCurrent(batch.signal);
      const views = await this.#loadNodeViews([node], fields, batch);
      this.#assertCurrent(batch.signal);
      const view = views.get(node.key);
      if (!view) {
        throw new TileNodeReaderError('NODE_CONTENT_MISMATCH', 'A requested node has no loaded point view.', { nodeKey: node.key });
      }
      return view;
    } catch (error) {
      batch.controller.abort();
      if (options.signal?.aborted) {
        throw new TileNodeReaderError('ABORTED', 'Tile node read was cancelled.');
      }
      throw error;
    } finally {
      batch.dispose();
    }
  }

  async #resolveNodes(
    requestedKeys: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, TileHierarchyNode>> {
    const wanted = new Set(requestedKeys);
    const found = new Map<string, TileHierarchyNode>();
    const knownNodes = new Map<string, TileHierarchyNode>();
    const pageQueue: TileHierarchyPage[] = [];
    const queuedPageKeys = new Map<string, string>();
    const loadedPageKeys = new Set<string>();
    let incompleteChildDiscovery = false;
    let loadedPages = 0;
    let loadedPageBytes = 0;
    let loadedNodes = 0;

    const rootPage = validatePage(this.#source.getRootHierarchyPage(), this.#limits);
    pageQueue.push(rootPage);
    queuedPageKeys.set(rootPage.key, pageSignature(rootPage));

    while (pageQueue.length > 0 && found.size < wanted.size) {
      this.#assertCurrent(signal);
      const page = pageQueue.shift();
      if (!page) break;
      const signature = pageSignature(page);
      const priorSignature = queuedPageKeys.get(page.key);
      if (priorSignature !== undefined && priorSignature !== signature) {
        throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'A hierarchy page key refers to conflicting byte ranges.', { pageKey: page.key });
      }
      if (loadedPageKeys.has(page.key)) continue;
      if (loadedPages >= this.#limits.maxHierarchyPages) {
        throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy page limit ${this.#limits.maxHierarchyPages} reached before all requested nodes were found.`, { pageKey: page.key });
      }

      loadedPageKeys.add(page.key);
      loadedPages += 1;
      loadedPageBytes += page.pageLength;
      if (!Number.isSafeInteger(loadedPageBytes) || loadedPageBytes > this.#limits.maxTotalHierarchyPageBytes) {
        throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy reads exceed ${this.#limits.maxTotalHierarchyPageBytes} bytes.`, { pageKey: page.key });
      }
      const rawResult = await this.#source.loadHierarchyPage(page, signal);
      this.#assertCurrent(signal);
      const result = validatePageResult(rawResult, page, this.#limits);
      loadedNodes += result.nodes.length;
      if (!Number.isSafeInteger(loadedNodes) || loadedNodes > this.#limits.maxHierarchyNodes) {
        throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy traversal exceeds ${this.#limits.maxHierarchyNodes} nodes.`, { pageKey: page.key });
      }

      for (const rawNode of result.nodes) {
        const node = validateNode(rawNode, this.#limits);
        if (node.childrenComplete !== true) incompleteChildDiscovery = true;
        const existing = knownNodes.get(node.key);
        if (existing && !sameNode(existing, node)) {
          throw new TileNodeReaderError('CONFLICTING_NODE', 'A hierarchy node key was returned with conflicting metadata.', { nodeKey: node.key, pageKey: page.key });
        }
        knownNodes.set(node.key, node);
        if (wanted.has(node.key)) found.set(node.key, node);
      }

      if (found.size < wanted.size) {
        for (const rawPage of result.pages) {
          const childPage = validatePage(rawPage, this.#limits);
          const childSignature = pageSignature(childPage);
          const knownSignature = queuedPageKeys.get(childPage.key);
          if (knownSignature !== undefined && knownSignature !== childSignature) {
            throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'A hierarchy page key refers to conflicting byte ranges.', { pageKey: childPage.key });
          }
          if (!queuedPageKeys.has(childPage.key)) {
            if (queuedPageKeys.size >= this.#limits.maxHierarchyPages) {
              throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy page limit ${this.#limits.maxHierarchyPages} exceeded by discovered pages.`, { pageKey: childPage.key });
            }
            queuedPageKeys.set(childPage.key, childSignature);
            pageQueue.push(childPage);
          }
        }
      }
    }

    if (found.size < wanted.size) {
      const missing = requestedKeys.find((key) => !found.has(key));
      if (pageQueue.length > 0) {
        throw new TileNodeReaderError('HIERARCHY_LIMIT', `Hierarchy traversal stopped with ${pageQueue.length} unvisited pages.`, missing === undefined ? {} : { nodeKey: missing });
      }
      if (incompleteChildDiscovery) {
        throw new TileNodeReaderError('INCOMPLETE_HIERARCHY', 'The loaded hierarchy does not prove that an unresolved node is absent.', missing === undefined ? {} : { nodeKey: missing });
      }
      throw new TileNodeReaderError('NODE_NOT_FOUND', 'The requested node key is absent from the complete loaded hierarchy.', missing === undefined ? {} : { nodeKey: missing });
    }
    return found;
  }

  #assertPointBudget(nodes: readonly TileHierarchyNode[]): void {
    let totalPoints = 0;
    let totalBytes = 0;
    for (const node of nodes) {
      totalPoints += node.pointCount;
      totalBytes += node.pointDataLength;
      if (node.pointCount > this.#limits.maxPointsPerNode) {
        throw new TileNodeReaderError('POINT_DATA_LIMIT', `Node point count exceeds ${this.#limits.maxPointsPerNode}.`, { nodeKey: node.key });
      }
      if (node.pointDataLength > this.#limits.maxPointDataBytesPerNode) {
        throw new TileNodeReaderError('POINT_DATA_LIMIT', `Node point-data range exceeds ${this.#limits.maxPointDataBytesPerNode} bytes.`, { nodeKey: node.key });
      }
    }
    if (!Number.isSafeInteger(totalPoints) || totalPoints > this.#limits.maxTotalPoints) {
      throw new TileNodeReaderError('POINT_DATA_LIMIT', `Requested nodes exceed the ${this.#limits.maxTotalPoints}-point batch limit.`);
    }
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.#limits.maxTotalPointDataBytes) {
      throw new TileNodeReaderError('POINT_DATA_LIMIT', `Requested nodes exceed the ${this.#limits.maxTotalPointDataBytes}-byte point-data batch limit.`);
    }
  }

  async #loadNodeViews(
    nodes: readonly TileHierarchyNode[],
    selection: TilePointFieldSelection,
    batch: Readonly<{ controller: AbortController; signal: AbortSignal }>,
  ): Promise<Map<string, TilePointView>> {
    const result = new Map<string, TilePointView>();
    let cursor = 0;
    let decodedBytes = 0;
    let hasFailure = false;
    let firstFailure: unknown;

    const worker = async (): Promise<void> => {
      while (true) {
        this.#assertCurrent(batch.signal);
        const index = cursor;
        cursor += 1;
        if (index >= nodes.length) return;
        const node = nodes[index];
        if (!node) return;
        try {
          const rawView = await this.#source.loadNode(node, selection, batch.signal);
          this.#assertCurrent(batch.signal);
          const view = validateTilePointView(rawView, {
            sourceIdentity: this.#sourceIdentity,
            ...(this.#sourceGeneration === undefined ? {} : { sourceGeneration: this.#sourceGeneration }),
            transformGeneration: this.#transformGeneration,
          }, selection);
          if (view.context.nodeKey !== node.key || view.pointCount !== node.pointCount) {
            throw new TileNodeReaderError('NODE_CONTENT_MISMATCH', 'Loaded point view identity or point count does not match its hierarchy node.', { nodeKey: node.key });
          }
          const bytes = decodedViewByteLength(view);
          if (bytes > this.#limits.maxDecodedBytesPerNode) {
            throw new TileNodeReaderError('DECODED_DATA_LIMIT', `Decoded node view exceeds ${this.#limits.maxDecodedBytesPerNode} bytes.`, { nodeKey: node.key });
          }
          decodedBytes += bytes;
          if (!Number.isSafeInteger(decodedBytes) || decodedBytes > this.#limits.maxTotalDecodedBytes) {
            throw new TileNodeReaderError('DECODED_DATA_LIMIT', `Decoded batch exceeds ${this.#limits.maxTotalDecodedBytes} bytes.`, { nodeKey: node.key });
          }
          result.set(node.key, view);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
            batch.controller.abort(error);
          }
          throw error;
        }
      }
    };

    const settled = await Promise.allSettled(Array.from(
      { length: Math.min(nodes.length, this.#limits.maxConcurrentNodeReads) },
      () => worker(),
    ));
    if (hasFailure) throw firstFailure;
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return result;
  }

  #assertCurrent(signal: AbortSignal): void {
    assertNotAborted(signal);
    if (
      this.#source.sourceIdentity !== this.#sourceIdentity ||
      this.#source.sourceGeneration !== this.#sourceGeneration ||
      this.#source.transformGeneration !== this.#transformGeneration ||
      this.#source.isCurrent?.() === false
    ) {
      throw new TileNodeReaderError('STALE_SOURCE', 'Source identity or transform generation changed during the node read.');
    }
  }
}

function normalizeRequestedKeys(keys: readonly string[], maxRequested: number): string[] {
  if (!Array.isArray(keys)) throw new TileNodeReaderError('INVALID_REQUEST', 'nodeKeys must be an array.');
  if (keys.length > maxRequested) {
    throw new TileNodeReaderError('REQUEST_LIMIT', `Requested ${keys.length} nodes; limit is ${maxRequested}.`);
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string' || key.trim() === '' || key.length > 1024) {
      throw new TileNodeReaderError(
        'INVALID_REQUEST',
        'Node keys must be non-empty strings of at most 1024 characters.',
        typeof key === 'string' ? { nodeKey: key } : {},
      );
    }
    seen.add(key);
  }
  return [...seen];
}

function normalizeLimits(input: TileNodeReaderLimits): Limits {
  if (!input || typeof input !== 'object') {
    throw new TileNodeReaderError('INVALID_REQUEST', 'Reader limits must be an object.');
  }
  const result: { -readonly [Key in keyof Limits]: number } = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) {
      throw new TileNodeReaderError('INVALID_REQUEST', `${key} must be a positive safe integer no greater than ${HARD_LIMITS[key]}.`);
    }
    result[key] = value;
  }
  if (result.maxTotalPoints < result.maxPointsPerNode) {
    throw new TileNodeReaderError('INVALID_REQUEST', 'maxTotalPoints must be at least maxPointsPerNode.');
  }
  if (result.maxTotalPointDataBytes < result.maxPointDataBytesPerNode) {
    throw new TileNodeReaderError('INVALID_REQUEST', 'maxTotalPointDataBytes must be at least maxPointDataBytesPerNode.');
  }
  if (result.maxTotalDecodedBytes < result.maxDecodedBytesPerNode) {
    throw new TileNodeReaderError('INVALID_REQUEST', 'maxTotalDecodedBytes must be at least maxDecodedBytesPerNode.');
  }
  return Object.freeze(result);
}

function validatePage(value: unknown, limits: Limits): TileHierarchyPage {
  if (!isRecord(value)) {
    throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'Hierarchy page must be an object.');
  }
  const { key, pageOffset, pageLength } = value;
  if (
    typeof key !== 'string' || key.trim() === '' || key.length > 1024 ||
    !Number.isSafeInteger(pageOffset) || (pageOffset as number) < 0 ||
    !Number.isSafeInteger(pageLength) || (pageLength as number) <= 0 ||
    (pageLength as number) > limits.maxHierarchyPageBytes ||
    !Number.isSafeInteger((pageOffset as number) + (pageLength as number))
  ) {
    throw new TileNodeReaderError(
      'INVALID_HIERARCHY_PAGE',
      'Hierarchy page key, range, or length is invalid.',
      typeof key === 'string' ? { pageKey: key } : {},
    );
  }
  return Object.freeze({ key, pageOffset: pageOffset as number, pageLength: pageLength as number });
}

function validatePageResult(value: unknown, page: TileHierarchyPage, limits: Limits): TileHierarchyPageResult {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.pages)) {
    throw new TileNodeReaderError('INVALID_HIERARCHY_PAGE', 'Hierarchy page result must include node and page arrays.', { pageKey: page.key });
  }
  if (value.nodes.length > limits.maxNodesPerPage || value.pages.length > limits.maxHierarchyPages) {
    throw new TileNodeReaderError('HIERARCHY_LIMIT', 'Hierarchy response exceeds configured page or node limits.', { pageKey: page.key });
  }
  return value as unknown as TileHierarchyPageResult;
}

function validateNode(value: unknown, limits: Limits): TileHierarchyNode {
  if (!isRecord(value)) {
    throw new TileNodeReaderError('INVALID_HIERARCHY_NODE', 'Hierarchy node must be an object.');
  }
  const { key, level, x, y, z, pointCount, pointDataOffset, pointDataLength, children, childrenComplete } = value;
  const coordinatesValid = [level, x, y, z].every((item) => Number.isSafeInteger(item) && (item as number) >= 0);
  const childKeysValid = children === undefined || (
    Array.isArray(children) &&
    children.every((child) => typeof child === 'string' && child.trim() !== '' && child.length <= 1024) &&
    new Set(children).size === children.length
  );
  if (
    typeof key !== 'string' || key.trim() === '' || key.length > 1024 ||
    !coordinatesValid || (level as number) > 52 ||
    [x, y, z].some((coordinate) => (coordinate as number) >= 2 ** (level as number)) ||
    !Number.isSafeInteger(pointCount) || (pointCount as number) < 0 ||
    !Number.isSafeInteger(pointDataOffset) || (pointDataOffset as number) < 0 ||
    !Number.isSafeInteger(pointDataLength) || (pointDataLength as number) < 0 ||
    !Number.isSafeInteger((pointDataOffset as number) + (pointDataLength as number)) ||
    !childKeysValid || (childrenComplete !== undefined && typeof childrenComplete !== 'boolean')
  ) {
    throw new TileNodeReaderError(
      'INVALID_HIERARCHY_NODE',
      'Hierarchy node identity, coordinates, counts, range, or child state is invalid.',
      typeof key === 'string' ? { nodeKey: key } : {},
    );
  }
  if ((pointCount as number) > 0 && (pointDataLength as number) === 0) {
    throw new TileNodeReaderError('INVALID_HIERARCHY_NODE', 'A non-empty point node must have a non-empty point-data range.', { nodeKey: key as string });
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

function sameNode(a: TileHierarchyNode, b: TileHierarchyNode): boolean {
  return a.key === b.key && a.level === b.level && a.x === b.x && a.y === b.y && a.z === b.z &&
    a.pointCount === b.pointCount && a.pointDataOffset === b.pointDataOffset && a.pointDataLength === b.pointDataLength &&
    a.childrenComplete === b.childrenComplete && JSON.stringify(a.children ?? []) === JSON.stringify(b.children ?? []);
}

function pageSignature(page: TileHierarchyPage): string {
  return `${page.pageOffset}:${page.pageLength}`;
}

function decodedViewByteLength(view: TilePointView): number {
  let bytes = view.ecef.byteLength;
  if (view.preparedHeight) bytes += view.preparedHeight.byteLength;
  if (view.source) bytes += view.source.byteLength;
  if (view.geographic) bytes += view.geographic.byteLength;
  if (view.attributes) {
    for (const values of [view.attributes.red, view.attributes.green, view.attributes.blue, view.attributes.intensity, view.attributes.classification]) {
      if (values) bytes += values.byteLength;
    }
    for (const values of Object.values(view.attributes.extraDimensions ?? {})) bytes += values.byteLength;
  }
  return bytes;
}

function createBatchSignal(parent: AbortSignal | undefined): Readonly<{
  controller: AbortController;
  signal: AbortSignal;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const relay = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) relay();
  else parent?.addEventListener('abort', relay, { once: true });
  return Object.freeze({
    controller,
    signal: controller.signal,
    dispose: () => parent?.removeEventListener('abort', relay),
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TileNodeReaderError('ABORTED', 'Tile node read was cancelled.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
