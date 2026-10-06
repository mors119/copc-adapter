import type { RangeReadOptions, RandomAccessByteSource } from './types';

export const RANGE_CANCELLATION_REASON = {
  superseded: 'superseded',
  lifecycle: 'lifecycle',
} as const;

export type RangeCancellationReason =
  typeof RANGE_CANCELLATION_REASON[keyof typeof RANGE_CANCELLATION_REASON];

export type RangeRequestOutcome =
  | 'requested'
  | 'completed'
  | 'failed'
  | 'abortedSuperseded'
  | 'abortedLifecycle';

export type RangeRequestDiagnostics = {
  requested: number;
  active: number;
  completed: number;
  failed: number;
  abortedSuperseded: number;
  abortedLifecycle: number;
};

const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

function increment(current: number): number {
  return Math.min(MAX_SAFE_COUNTER, current + 1);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
    || typeof DOMException !== 'undefined'
      && error instanceof DOMException
      && error.name === 'AbortError';
}

function abortError(signal: AbortSignal): Error {
  const error = new Error('Range request was cancelled', { cause: signal.reason });
  error.name = 'AbortError';
  return error;
}

function linkSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }

    const listener = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}

/** Records aggregate byte-range request outcomes without retaining node logs. */
export class RangeRequestDiagnosticsRecorder {
  private diagnostics: RangeRequestDiagnostics = {
    requested: 0,
    active: 0,
    completed: 0,
    failed: 0,
    abortedSuperseded: 0,
    abortedLifecycle: 0,
  };

  record(outcome: RangeRequestOutcome): void {
    if (outcome === 'requested') {
      this.diagnostics.requested = increment(this.diagnostics.requested);
      this.diagnostics.active = increment(this.diagnostics.active);
      return;
    }
    this.diagnostics[outcome] = increment(this.diagnostics[outcome]);
    this.diagnostics.active = Math.max(0, this.diagnostics.active - 1);
  }

  getSnapshot(): RangeRequestDiagnostics {
    return { ...this.diagnostics };
  }
}

/**
 * Adds project lifecycle cancellation and aggregate accounting to a byte
 * source. Point callers may supply a second signal; hierarchy callers inherit
 * only the source lifecycle signal so reusable page reads stay intact.
 */
export class ProjectOwnedByteSource implements RandomAccessByteSource {
  readonly source: string;
  private readonly delegate: RandomAccessByteSource;
  private readonly lifecycleSignal?: AbortSignal;
  private readonly diagnostics: RangeRequestDiagnosticsRecorder;

  constructor(
    delegate: RandomAccessByteSource,
    lifecycleSignal: AbortSignal | undefined,
    diagnostics: RangeRequestDiagnosticsRecorder,
  ) {
    this.delegate = delegate;
    this.source = delegate.source;
    this.lifecycleSignal = lifecycleSignal;
    this.diagnostics = diagnostics;
  }

  async readRange(
    offset: number,
    length: number,
    options: RangeReadOptions = {},
  ): Promise<Uint8Array> {
    const linked = linkSignals([this.lifecycleSignal, options.signal]);
    this.diagnostics.record('requested');
    try {
      if (linked.signal.aborted) {
        throw abortError(linked.signal);
      }
      const bytes = await this.delegate.readRange(offset, length, {
        signal: linked.signal,
      });
      if (linked.signal.aborted) {
        throw abortError(linked.signal);
      }
      this.diagnostics.record('completed');
      return bytes;
    } catch (error: unknown) {
      if (linked.signal.aborted || isAbortError(error)) {
        const reason = linked.signal.reason;
        this.diagnostics.record(reason === RANGE_CANCELLATION_REASON.lifecycle
          ? 'abortedLifecycle'
          : 'abortedSuperseded');
      } else {
        this.diagnostics.record('failed');
      }
      throw error;
    } finally {
      linked.dispose();
    }
  }

  readRanges(
    ranges: Parameters<RandomAccessByteSource['readRanges']>[0],
    options: RangeReadOptions = {},
  ): Promise<Uint8Array[]> {
    return Promise.all(ranges.map(({ offset, length }) =>
      this.readRange(offset, length, options)));
  }

  size(): Promise<number | undefined> {
    return this.delegate.size();
  }
}
