import { Copc } from 'copc';
import {
  toCopcHierarchyNode,
  toCopcHierarchyPage,
} from '../adapters/hierarchyAdapter';
import { toCopcMetadata } from '../adapters/metadataAdapter';
import { createCopcGetter } from '../getter/createCopcGetter';
import { decodeCopcPointBuffer } from '../../wasm/copcDecoder';
import type { CopcHierarchySubtree } from '../hierarchy/types';
import type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcMetadata,
  CopcPointBuffer,
  CopcPointView,
} from '../types/copc';
import {
  type CopcPointComponent,
  type CopcPointField,
  type CopcPointFieldSelection,
} from '../points/fieldSelection';
import type { CopcBackend, CopcSource } from './types';
import { performanceNow, type CopcPerformanceObserver } from '../performance';
import { CopcBackendError } from '../errors';

const SOURCE_DIMENSIONS: Readonly<Record<CopcPointComponent, string>> = {
  x: 'X',
  y: 'Y',
  z: 'Z',
  intensity: 'Intensity',
  classification: 'Classification',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

const FIELD_COMPONENTS: Readonly<Record<CopcPointField, readonly CopcPointComponent[]>> = {
  position: ['x', 'y', 'z'],
  intensity: ['intensity'],
  classification: ['classification'],
  rgb: ['red', 'green', 'blue'],
};

type SourcePointView = {
  pointCount: number;
  dimensions: Record<string, unknown>;
  getter(name: string): (index: number) => number;
};

function mapCopcJsError(
  source: string,
  error: unknown,
  operation: 'open' | 'hierarchy' | 'point',
  nodeKey?: string,
): CopcBackendError {
  if (error instanceof CopcBackendError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (operation === 'open') {
    const metadataFailure = /header|signature|version|VLR|COPC info|WKT/i.test(message);
    return new CopcBackendError(
      source,
      metadataFailure ? 'metadata' : 'source',
      metadataFailure ? 'header-parse' : 'source-range',
      message,
      { cause: error },
    );
  }

  if (operation === 'hierarchy') {
    return new CopcBackendError(source, 'hierarchy', 'hierarchy', message, { cause: error });
  }

  if (/point selection|unsupported/i.test(message)) {
    return new CopcBackendError(source, 'decode', 'unsupported', message, {
      cause: error,
      nodeKey,
    });
  }

  if (/point range returned/i.test(message)) {
    return new CopcBackendError(source, 'point-data', 'point-chunk', message, {
      cause: error,
      nodeKey,
    });
  }

  return new CopcBackendError(source, 'decode', 'laz-decode', message, {
    cause: error,
    nodeKey,
  });
}

export function toCopcPointView(
  view: SourcePointView,
  requestedFields: CopcPointFieldSelection,
): CopcPointView {
  const sourceDimensions = new Set(Object.keys(view.dimensions));
  const availableFields = new Set<CopcPointField>();
  const availableComponents = new Set<CopcPointComponent>();

  for (const field of requestedFields) {
    const components = FIELD_COMPONENTS[field];

    if (components.every((component) => sourceDimensions.has(SOURCE_DIMENSIONS[component]))) {
      availableFields.add(field);
      for (const component of components) {
        availableComponents.add(component);
      }
    }
  }

  return {
    pointCount: view.pointCount,
    availableFields,
    getter(component: CopcPointComponent): (index: number) => number {
      if (!availableComponents.has(component)) {
        throw new Error(`COPC point component is unavailable: ${component}`);
      }

      return view.getter(SOURCE_DIMENSIONS[component]);
    },
  };
}

/** The production source adapter backed by copc.js. */
class CopcJsSource implements CopcSource {
  readonly source: string;
  private readonly getter: ReturnType<typeof createCopcGetter>;
  private readonly copc: Copc;
  private performanceObserver?: CopcPerformanceObserver;
  private activeNodeKey?: string;
  private activeNodePointCount?: number;
  private pointRangeDurationMs = 0;

  constructor(
    source: string,
    getter: ReturnType<typeof createCopcGetter>,
    copc: Copc,
  ) {
    this.source = source;
    this.getter = async (begin, end) => {
      const rangeStartedAt = performanceNow();
      const bytes = await getter(begin, end);
      if (this.activeNodeKey && bytes.byteLength !== end - begin) {
        throw new Error(
          `COPC point range returned ${bytes.byteLength} bytes; expected ${end - begin}`,
        );
      }
      if (
        this.activeNodeKey
        && this.activeNodePointCount !== undefined
        && bytes.byteLength >= this.copc.header.pointDataRecordLength + 4
      ) {
        const countOffset = this.copc.header.pointDataRecordLength;
        const compressedPointCount = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getUint32(countOffset, true);
        if (compressedPointCount !== this.activeNodePointCount) {
          throw new Error(
            `COPC chunk point count ${compressedPointCount} does not match hierarchy count ${this.activeNodePointCount}`,
          );
        }
      }
      const durationMs = performanceNow() - rangeStartedAt;
      this.pointRangeDurationMs += durationMs;
      this.performanceObserver?.({
        stage: 'rangeFetch',
        durationMs,
        nodeKey: this.activeNodeKey,
      });
      return bytes;
    };
    this.copc = copc;
  }

  getMetadata(): CopcMetadata {
    return toCopcMetadata(this.copc);
  }

  getRootHierarchyPage(): CopcHierarchyPage {
    return {
      key: '0-0-0-0',
      pageOffset: this.copc.info.rootHierarchyPage.pageOffset,
      pageLength: this.copc.info.rootHierarchyPage.pageLength,
    };
  }

  async loadHierarchyPage(
    page: CopcHierarchyPage,
  ): Promise<CopcHierarchySubtree> {
    try {
      const subtree = await Copc.loadHierarchyPage(this.getter, {
        pageOffset: page.pageOffset,
        pageLength: page.pageLength,
      });
      const nodes: CopcHierarchySubtree['nodes'] = [];
      const pages: CopcHierarchySubtree['pages'] = [];

      for (const [key, node] of Object.entries(subtree.nodes)) {
        if (node) {
          nodes.push(toCopcHierarchyNode(key, node));
        }
      }

      for (const [key, childPage] of Object.entries(subtree.pages)) {
        if (childPage) {
          pages.push(toCopcHierarchyPage(key, childPage));
        }
      }

      return { nodes, pages };
    } catch (error: unknown) {
      throw mapCopcJsError(this.source, error, 'hierarchy');
    }
  }

  async loadPointDataView(
    hierarchyNode: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView> {
    if (!fields.has('position')) {
      throw mapCopcJsError(
        this.source,
        new Error('COPC point selection must include position'),
        'point',
        hierarchyNode.key,
      );
    }
    this.activeNodeKey = hierarchyNode.key;
    this.activeNodePointCount = hierarchyNode.pointCount;
    this.pointRangeDurationMs = 0;
    const startedAt = performanceNow();
    try {
      const view = await Copc.loadPointDataView(
        this.getter,
        this.copc,
        hierarchyNode,
      );

      // copc.js currently exposes a complete point view. Keep the requested
      // fields enforced at this adapter boundary until a backend can skip LAZ
      // layers during decode.
      this.performanceObserver?.({
        stage: 'decode',
        durationMs: Math.max(0, performanceNow() - startedAt - this.pointRangeDurationMs),
        nodeKey: hierarchyNode.key,
      });
      return toCopcPointView(view, fields);
    } catch (error: unknown) {
      throw mapCopcJsError(this.source, error, 'point', hierarchyNode.key);
    } finally {
      this.activeNodeKey = undefined;
      this.activeNodePointCount = undefined;
      this.pointRangeDurationMs = 0;
    }
  }

  async loadPointDataBuffer(
    hierarchyNode: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointBuffer> {
    return decodeCopcPointBuffer(await this.loadPointDataView(hierarchyNode, fields));
  }

  setPerformanceObserver(observer: CopcPerformanceObserver | undefined): void {
    this.performanceObserver = observer;
  }
}

/** Opens COPC resources through copc.js. */
export class CopcJsBackend implements CopcBackend {
  async open(source: string): Promise<CopcSource> {
    try {
      const getter = createCopcGetter(source);
      const copc = await Copc.create(getter);

      return new CopcJsSource(source, getter, copc);
    } catch (error: unknown) {
      throw mapCopcJsError(source, error, 'open');
    }
  }
}

/** Shared default backend used when callers do not provide one. */
export const copcJsBackend: CopcBackend = new CopcJsBackend();
