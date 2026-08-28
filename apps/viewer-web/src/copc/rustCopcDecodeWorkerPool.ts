import type { CopcPointBuffer } from './types/copc';
import type {
  RustCopcDecodeWorkerJob,
  RustCopcDecodeWorkerRequest,
  RustCopcDecodeWorkerResponse,
} from './rustCopcDecodeWorkerProtocol';

export type RustCopcDecodeWorkerLike = {
  onmessage: ((event: MessageEvent<RustCopcDecodeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  postMessage(message: RustCopcDecodeWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void | Promise<void>;
};

export type RustCopcDecodeWorkerPoolOptions = {
  workerCount?: number;
  workerFactory?: () => RustCopcDecodeWorkerLike;
};

export type RustCopcDecodeRequest = {
  nodeKey: string;
  pointCount: number;
  requestedFields: number;
  chunk: Uint8Array;
};

export class RustCopcWorkerError extends Error {
  readonly workerCode: 'worker-failure' | 'worker-message' | 'worker-cancelled' | 'worker-destroyed';
  readonly nodeKey?: string;
  readonly rustCode?: string;

  constructor(
    workerCode: RustCopcWorkerError['workerCode'],
    message: string,
    options: { nodeKey?: string; rustCode?: string } = {},
  ) {
    super(message);
    this.name = 'RustCopcWorkerError';
    this.workerCode = workerCode;
    this.nodeKey = options.nodeKey;
    this.rustCode = options.rustCode;
  }
}

type QueueEntry = {
  id: number;
  request: RustCopcDecodeRequest;
  resolve: (buffer: CopcPointBuffer & { decodeDurationMs: number }) => void;
  reject: (error: unknown) => void;
};

type WorkerSlot = {
  worker: RustCopcDecodeWorkerLike;
  ready: boolean;
  phase: 'initializing' | 'decoding';
  current?: QueueEntry;
};

function defaultWorkerCount(): number {
  const hardwareConcurrency = typeof navigator !== 'undefined'
    ? navigator.hardwareConcurrency
    : 4;
  return Math.min(4, Math.max(1, hardwareConcurrency - 1));
}

function defaultWorkerFactory(): RustCopcDecodeWorkerLike {
  return new Worker(new URL('./rustCopcDecodeWorker.ts', import.meta.url), {
    type: 'module',
  });
}

function bufferFrom(value: ArrayBuffer | undefined, type: 'u16' | 'u8'): Uint16Array | Uint8Array | undefined {
  if (!value) return undefined;
  return type === 'u16' ? new Uint16Array(value) : new Uint8Array(value);
}

/** Bounded, FIFO Rust/WASM decode queue owned by one COPC source instance. */
export class RustCopcDecodeWorkerPool {
  readonly workerCount: number;
  private readonly workerFactory: () => RustCopcDecodeWorkerLike;
  private readonly workers: WorkerSlot[] = [];
  private readonly queue: QueueEntry[] = [];
  private readonly entries = new Map<number, QueueEntry>();
  private metadata?: Uint8Array;
  private nextId = 1;
  private destroyed = false;

  constructor(options: RustCopcDecodeWorkerPoolOptions = {}) {
    const workerCount = options.workerCount ?? defaultWorkerCount();
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new RangeError('Rust COPC worker count must be a positive integer');
    }
    this.workerCount = workerCount;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
  }

  setMetadata(metadata: Uint8Array): void {
    if (this.destroyed) return;
    this.metadata = metadata.slice();
  }

  submit(request: RustCopcDecodeRequest): Promise<CopcPointBuffer & { decodeDurationMs: number }> {
    if (this.destroyed) {
      return Promise.reject(new RustCopcWorkerError('worker-destroyed', 'Rust COPC worker pool was destroyed'));
    }
    if (!this.metadata) {
      return Promise.reject(new RustCopcWorkerError('worker-failure', 'Rust COPC worker metadata is unavailable', { nodeKey: request.nodeKey }));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        id: this.nextId++,
        request,
        resolve,
        reject,
      };
      this.queue.push(entry);
      this.entries.set(entry.id, entry);
      this.dispatch();
    });
  }

  /** Remove queued work that is no longer relevant to the current view. */
  cancelQueued(predicate: (request: RustCopcDecodeRequest) => boolean = () => true): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const entry = this.queue[index];
      if (!predicate(entry.request)) continue;
      this.queue.splice(index, 1);
      this.entries.delete(entry.id);
      entry.reject(new RustCopcWorkerError('worker-cancelled', 'Queued Rust COPC decode was superseded', {
        nodeKey: entry.request.nodeKey,
      }));
    }
  }

  /** Optional priority hook; the default queue remains deterministic FIFO. */
  reprioritizeQueued(compare: (left: RustCopcDecodeRequest, right: RustCopcDecodeRequest) => number): void {
    this.queue.sort((left, right) => compare(left.request, right.request));
    this.dispatch();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const error = new RustCopcWorkerError('worker-destroyed', 'Rust COPC worker pool was destroyed');
    for (const entry of this.queue.splice(0)) {
      this.entries.delete(entry.id);
      entry.reject(error);
    }
    for (const slot of this.workers.splice(0)) {
      if (slot.current) {
        this.entries.delete(slot.current.id);
        slot.current.reject(error);
      }
      void slot.worker.terminate();
    }
  }

  private dispatch(): void {
    if (this.destroyed) return;
    while (this.queue.length > 0) {
      let slot = this.workers.find((candidate) => !candidate.current);
      if (!slot && this.workers.length < this.workerCount) {
        try {
          slot = this.createSlot();
        } catch (error: unknown) {
          const entry = this.queue.shift();
          if (entry) {
            this.entries.delete(entry.id);
            entry.reject(new RustCopcWorkerError(
              'worker-failure',
              error instanceof Error ? error.message : String(error),
              { nodeKey: entry.request.nodeKey },
            ));
          }
          continue;
        }
      }
      if (!slot) return;
      const entry = this.queue.shift();
      if (!entry) return;
      slot.current = entry;
      if (!slot.ready) {
        slot.phase = 'initializing';
        const metadata = this.metadata!.slice().buffer;
        try {
          slot.worker.postMessage({ type: 'init', metadata }, [metadata]);
        } catch (error: unknown) {
          this.handleWorkerFailure(
            slot,
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        this.postJob(slot, entry);
      }
    }
  }

  private createSlot(): WorkerSlot {
    const worker = this.workerFactory();
    const slot: WorkerSlot = { worker, ready: false, phase: 'initializing' };
    worker.onmessage = (event) => this.handleMessage(slot, event.data);
    worker.onerror = (event) => this.handleWorkerFailure(slot, event.message || 'Rust COPC worker failed');
    if (worker.onmessageerror !== undefined) {
      worker.onmessageerror = () => this.handleWorkerFailure(slot, 'Rust COPC worker message failed');
    }
    this.workers.push(slot);
    return slot;
  }

  private postJob(slot: WorkerSlot, entry: QueueEntry): void {
    slot.phase = 'decoding';
    const chunk = entry.request.chunk.slice().buffer;
    const job: RustCopcDecodeWorkerJob = {
      type: 'decode',
      id: entry.id,
      nodeKey: entry.request.nodeKey,
      pointCount: entry.request.pointCount,
      requestedFields: entry.request.requestedFields,
      chunk,
    };
    try {
      slot.worker.postMessage(job, [chunk]);
    } catch (error: unknown) {
      this.handleWorkerFailure(
        slot,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleMessage(slot: WorkerSlot, response: RustCopcDecodeWorkerResponse): void {
    const entry = slot.current;
    if (response.type === 'ready') {
      slot.ready = true;
      if (entry) this.postJob(slot, entry);
      return;
    }
    if (!entry || response.id !== entry.id) {
      this.handleWorkerFailure(slot, 'Rust COPC worker returned an unexpected job response');
      return;
    }
    slot.current = undefined;
    this.entries.delete(entry.id);
    if (response.type === 'error') {
      entry.reject(new RustCopcWorkerError('worker-failure', response.error.message, {
        nodeKey: response.nodeKey ?? entry.request.nodeKey,
        rustCode: response.error.code,
      }));
    } else {
      const attributes = response.intensity || response.classification || response.red || response.green || response.blue
        ? {
          intensity: bufferFrom(response.intensity, 'u16') as Uint16Array | undefined,
          classification: bufferFrom(response.classification, 'u8') as Uint8Array | undefined,
          red: bufferFrom(response.red, 'u16') as Uint16Array | undefined,
          green: bufferFrom(response.green, 'u16') as Uint16Array | undefined,
          blue: bufferFrom(response.blue, 'u16') as Uint16Array | undefined,
        }
        : undefined;
      entry.resolve({
        pointCount: response.pointCount,
        coordinates: new Float64Array(response.coordinates),
        attributes,
        decodeDurationMs: response.durationMs,
      });
    }
    this.dispatch();
  }

  private handleWorkerFailure(slot: WorkerSlot, message: string): void {
    const entry = slot.current;
    slot.current = undefined;
    if (entry) {
      this.entries.delete(entry.id);
      entry.reject(new RustCopcWorkerError('worker-failure', message, {
        nodeKey: entry.request.nodeKey,
      }));
    }
    void slot.worker.terminate();
    const index = this.workers.indexOf(slot);
    if (index >= 0) this.workers.splice(index, 1);
    this.dispatch();
  }
}
