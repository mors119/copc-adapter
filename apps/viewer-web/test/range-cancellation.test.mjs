import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectOwnedByteSource,
  RANGE_CANCELLATION_REASON,
  RangeRequestDiagnosticsRecorder,
} from '../src/copc/range/requestDiagnostics.ts';
import { createCopcGetter } from '../src/copc/getter/createCopcGetter.ts';

function createByteSource(readRange) {
  return {
    source: 'https://example.test/data.copc.laz',
    readRange,
    async readRanges(ranges, options) {
      return Promise.all(ranges.map(({ offset, length }) =>
        readRange(offset, length, options)));
    },
    async size() {
      return undefined;
    },
  };
}

function makeAbortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

test('a range cancelled before fetch never reaches the byte source', async () => {
  let fetchCount = 0;
  const caller = new AbortController();
  caller.abort(RANGE_CANCELLATION_REASON.superseded);
  const diagnostics = new RangeRequestDiagnosticsRecorder();
  const source = new ProjectOwnedByteSource(
    createByteSource(async () => {
      fetchCount += 1;
      return new Uint8Array([1]);
    }),
    undefined,
    diagnostics,
  );

  await assert.rejects(
    source.readRange(0, 1, { signal: caller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(diagnostics.getSnapshot(), {
    requested: 1,
    active: 0,
    completed: 0,
    failed: 0,
    abortedSuperseded: 1,
    abortedLifecycle: 0,
  });
});

test('a range cancelled during fetch records lifecycle cancellation', async () => {
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const lifecycle = new AbortController();
  const diagnostics = new RangeRequestDiagnosticsRecorder();
  const source = new ProjectOwnedByteSource(
    createByteSource((_offset, _length, { signal }) => new Promise((_resolve, reject) => {
      resolveStarted();
      signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
    })),
    lifecycle.signal,
    diagnostics,
  );

  const pending = source.readRange(0, 1);
  await started;
  lifecycle.abort(RANGE_CANCELLATION_REASON.lifecycle);
  await assert.rejects(pending, (error) => error.name === 'AbortError');

  assert.deepEqual(diagnostics.getSnapshot(), {
    requested: 1,
    active: 0,
    completed: 0,
    failed: 0,
    abortedSuperseded: 0,
    abortedLifecycle: 1,
  });
});

test('a completion race after the bytes arrive cannot report a completed range', async () => {
  const generation = new AbortController();
  const diagnostics = new RangeRequestDiagnosticsRecorder();
  const source = new ProjectOwnedByteSource(
    createByteSource(async () => new Uint8Array([4, 5, 6])),
    undefined,
    diagnostics,
  );

  const pending = source.readRange(0, 3, { signal: generation.signal });
  generation.abort(RANGE_CANCELLATION_REASON.superseded);
  await assert.rejects(pending, (error) => error.name === 'AbortError');

  assert.deepEqual(diagnostics.getSnapshot(), {
    requested: 1,
    active: 0,
    completed: 0,
    failed: 0,
    abortedSuperseded: 1,
    abortedLifecycle: 0,
  });
});

test('a completed range is retained and counted once', async () => {
  const diagnostics = new RangeRequestDiagnosticsRecorder();
  const source = new ProjectOwnedByteSource(
    createByteSource(async () => new Uint8Array([7, 8])),
    undefined,
    diagnostics,
  );

  assert.deepEqual([...await source.readRange(4, 2)], [7, 8]);
  assert.deepEqual(diagnostics.getSnapshot(), {
    requested: 1,
    active: 0,
    completed: 1,
    failed: 0,
    abortedSuperseded: 0,
    abortedLifecycle: 0,
  });
});

test('the copc-js HTTP getter forwards point cancellation to fetch', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  const generation = new AbortController();
  const diagnostics = new RangeRequestDiagnosticsRecorder();
  let observedSignal;
  let resolveFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    observedSignal = init.signal;
    resolveFetchStarted();
    init.signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
  });
  const getter = createCopcGetter('https://example.test/copc.laz', {
    rangeRequestDiagnostics: diagnostics,
  });

  const pending = getter(20, 24, { signal: generation.signal });
  await fetchStarted;
  generation.abort(RANGE_CANCELLATION_REASON.superseded);
  await assert.rejects(pending, (error) => error.code === 'aborted');

  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason, RANGE_CANCELLATION_REASON.superseded);
  assert.deepEqual(diagnostics.getSnapshot(), {
    requested: 1,
    active: 0,
    completed: 0,
    failed: 0,
    abortedSuperseded: 1,
    abortedLifecycle: 0,
  });
});
