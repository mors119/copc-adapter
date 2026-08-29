import { CopcBackendError } from '../errors';
import { RustCopcParseError, RustCopcReader } from '../rustCopcReader';
import { CopcWasmError } from '../../wasm/copcWasm';
import { HttpRangeByteSource } from '../range/httpRangeSource';
import {
  RangeSourceError,
  type RandomAccessByteSource,
} from '../range/types';
import type {
  CopcHierarchyNode,
  CopcPointBuffer,
  CopcPointView,
} from '../types/copc';
import type {
  CopcPointComponent,
  CopcPointField,
  CopcPointFieldSelection,
} from '../points/fieldSelection';
import type { CopcBackend, CopcSource, CopcWorkerDiagnostics } from './types';
import type { CopcPerformanceObserver } from '../performance';
import { RustCopcWorkerError } from '../rustCopcDecodeWorkerPool';

export type RustByteSourceFactory = (
  source: string,
) => RandomAccessByteSource;

export type RustCopcBackendOptions = {
  /** Optional source factory for tests, workers, or a host-owned file bridge. */
  readonly createByteSource?: RustByteSourceFactory;
};

function fieldAvailable(
  buffer: CopcPointBuffer,
  field: 'intensity' | 'classification' | 'rgb',
): boolean {
  if (field === 'intensity') {
    return buffer.attributes?.intensity !== undefined;
  }

  if (field === 'classification') {
    return buffer.attributes?.classification !== undefined;
  }

  return buffer.attributes?.red !== undefined
    && buffer.attributes.green !== undefined
    && buffer.attributes.blue !== undefined;
}

function unavailable(component: string): never {
  throw new Error(`COPC point component is unavailable: ${component}`);
}

function toCopcPointView(
  buffer: CopcPointBuffer,
  requestedFields: CopcPointFieldSelection,
): CopcPointView {
  const availableFields = new Set<CopcPointField>();
  if (requestedFields.has('position')) {
    availableFields.add('position');
  }
  for (const field of ['intensity', 'classification', 'rgb'] as const) {
    if (requestedFields.has(field) && fieldAvailable(buffer, field)) {
      availableFields.add(field);
    }
  }

  const getters: Record<CopcPointComponent, (index: number) => number> = {
    x: (index) => buffer.coordinates[index * 3],
    y: (index) => buffer.coordinates[index * 3 + 1],
    z: (index) => buffer.coordinates[index * 3 + 2],
    intensity: (index) => buffer.attributes?.intensity?.[index] ?? unavailable('intensity'),
    classification: (index) => buffer.attributes?.classification?.[index] ?? unavailable('classification'),
    red: (index) => buffer.attributes?.red?.[index] ?? unavailable('red'),
    green: (index) => buffer.attributes?.green?.[index] ?? unavailable('green'),
    blue: (index) => buffer.attributes?.blue?.[index] ?? unavailable('blue'),
  };

  return {
    pointCount: buffer.pointCount,
    availableFields,
    getter(component: CopcPointComponent): (index: number) => number {
      const field: CopcPointField = component === 'x' || component === 'y' || component === 'z'
        ? 'position'
        : component === 'intensity'
          ? 'intensity'
          : component === 'classification'
            ? 'classification'
            : 'rgb';

      if (!availableFields.has(field)) {
        throw new Error(`COPC point component is unavailable: ${component}`);
      }

      return getters[component];
    },
  };
}

function rustErrorCategory(
  error: RustCopcParseError,
  operation: 'open' | 'hierarchy' | 'point',
): {
  stage: 'metadata' | 'hierarchy' | 'decode';
  code: 'header-parse' | 'hierarchy' | 'laz-decode' | 'unsupported' | 'unknown';
} {
  if (error.code === 'unsupported-point-format' || error.code === 'unsupported-value') {
    return {
      stage: operation === 'point' ? 'decode' : 'metadata',
      code: 'unsupported',
    };
  }

  if (operation === 'point' && error.code === 'invalid-value') {
    return { stage: 'decode', code: 'unsupported' };
  }

  if (operation === 'point') {
    return {
      stage: 'decode',
      code: 'laz-decode',
    };
  }

  if (operation === 'hierarchy') {
    return { stage: 'hierarchy', code: 'hierarchy' };
  }

  return { stage: 'metadata', code: 'header-parse' };
}

function mapRustError(
  source: string,
  error: unknown,
  operation: 'open' | 'hierarchy' | 'point',
  nodeKey?: string,
): CopcBackendError {
  if (error instanceof CopcBackendError) {
    return error;
  }

  if (error instanceof RangeSourceError) {
    const pointChunk = operation === 'point';
    return new CopcBackendError(
      source,
      pointChunk ? 'point-data' : operation === 'hierarchy' ? 'hierarchy' : 'source',
      pointChunk ? 'point-chunk' : operation === 'hierarchy' ? 'hierarchy' : 'source-range',
      error.message,
      { cause: error, nodeKey },
    );
  }

  if (error instanceof CopcWasmError) {
    return new CopcBackendError(source, 'wasm', 'wasm', error.message, {
      cause: error,
      nodeKey,
    });
  }

  if (error instanceof RustCopcWorkerError) {
    return new CopcBackendError(source, 'decode', 'worker', error.message, {
      cause: error,
      nodeKey: error.nodeKey ?? nodeKey,
    });
  }

  if (error instanceof RustCopcParseError) {
    const category = rustErrorCategory(error, operation);
    return new CopcBackendError(source, category.stage, category.code, error.message, {
      cause: error,
      nodeKey,
    });
  }

  return new CopcBackendError(
    source,
    operation === 'point' ? 'decode' : operation === 'hierarchy' ? 'hierarchy' : 'source',
    operation === 'point' ? 'wasm' : 'unknown',
    error instanceof Error ? error.message : String(error),
    { cause: error, nodeKey },
  );
}

class RustCopcSource implements CopcSource {
  readonly source: string;
  private readonly reader: RustCopcReader;

  constructor(
    source: string,
    reader: RustCopcReader,
  ) {
    this.source = source;
    this.reader = reader;
  }

  getMetadata(): ReturnType<CopcSource['getMetadata']> {
    try {
      return this.reader.getMetadata();
    } catch (error: unknown) {
      throw mapRustError(this.source, error, 'open');
    }
  }

  getRootHierarchyPage(): ReturnType<CopcSource['getRootHierarchyPage']> {
    try {
      return this.reader.getRootHierarchyPage();
    } catch (error: unknown) {
      throw mapRustError(this.source, error, 'open');
    }
  }

  async loadHierarchyPage(
    page: Parameters<CopcSource['loadHierarchyPage']>[0],
  ): ReturnType<CopcSource['loadHierarchyPage']> {
    try {
      return await this.reader.loadHierarchyPage(page);
    } catch (error: unknown) {
      throw mapRustError(this.source, error, 'hierarchy');
    }
  }

  async loadPointDataBuffer(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointBuffer> {
    try {
      return await this.reader.loadPointDataBuffer(node, fields);
    } catch (error: unknown) {
      throw mapRustError(this.source, error, 'point', node.key);
    }
  }

  async loadPointDataView(
    node: CopcHierarchyNode,
    fields: CopcPointFieldSelection,
  ): Promise<CopcPointView> {
    return toCopcPointView(await this.loadPointDataBuffer(node, fields), fields);
  }

  setPerformanceObserver(observer: CopcPerformanceObserver | undefined): void {
    this.reader.setPerformanceObserver(observer);
  }

  cancelPendingPointJobs(): void {
    this.reader.cancelPendingPointJobs();
  }

  getWorkerDiagnostics(): CopcWorkerDiagnostics | undefined {
    return this.reader.getWorkerDiagnostics();
  }

  destroy(): void {
    this.reader.destroy();
  }
}

/** Opt-in Rust/WASM implementation of the project-owned COPC backend. */
export class RustCopcBackend implements CopcBackend {
  private readonly createByteSource: RustByteSourceFactory;

  constructor(options: RustCopcBackendOptions = {}) {
    this.createByteSource = options.createByteSource
      ?? ((source) => new HttpRangeByteSource(source));
  }

  async open(source: string): Promise<CopcSource> {
    let byteSource: RandomAccessByteSource;
    try {
      byteSource = this.createByteSource(source);
    } catch (error: unknown) {
      throw mapRustError(source, error, 'open');
    }

    try {
      return new RustCopcSource(source, await RustCopcReader.open(byteSource));
    } catch (error: unknown) {
      throw mapRustError(source, error, 'open');
    }
  }
}

/** Shared opt-in backend used by the string selector. */
export const rustCopcBackend: CopcBackend = new RustCopcBackend();
