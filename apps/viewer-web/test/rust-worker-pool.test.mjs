import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RustCopcDecodeWorkerPool,
  RustCopcWorkerError,
} from '../src/copc/rustCopcDecodeWorkerPool.ts';

function createFakeWorkerHarness({ delay = 5, fail = false } = {}) {
  const workers = [];
  let active = 0;
  let peak = 0;
  const order = [];

  class FakeWorker {
    onmessage = null;
    onerror = null;
    onmessageerror = null;
    terminated = false;

    postMessage(message) {
      if (this.terminated) throw new Error('worker terminated');
      if (message.type === 'init') {
        setTimeout(() => this.onmessage?.({ data: { type: 'ready' } }), 0);
        return;
      }
      order.push(message.nodeKey);
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        if (this.terminated) return;
        if (fail) {
          this.onmessage?.({ data: {
            type: 'error',
            id: message.id,
            nodeKey: message.nodeKey,
            error: { name: 'Error', message: 'synthetic worker failure', code: 'synthetic' },
          } });
          return;
        }
        const coordinates = new Float64Array([message.id, message.pointCount, 3]);
        const intensity = message.requestedFields & 1 ? new Uint16Array([11]) : undefined;
        const classification = message.requestedFields & 2 ? new Uint8Array([7]) : undefined;
        const red = message.requestedFields & 4 ? new Uint16Array([101]) : undefined;
        const green = message.requestedFields & 4 ? new Uint16Array([102]) : undefined;
        const blue = message.requestedFields & 4 ? new Uint16Array([103]) : undefined;
        const response = {
          type: 'result',
          id: message.id,
          nodeKey: message.nodeKey,
          pointCount: message.pointCount,
          durationMs: delay,
          coordinates: coordinates.buffer,
          intensity: intensity?.buffer,
          classification: classification?.buffer,
          red: red?.buffer,
          green: green?.buffer,
          blue: blue?.buffer,
        };
        this.onmessage?.({ data: response });
      }, delay);
    }

    terminate() {
      this.terminated = true;
    }
  }

  return {
    factory() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    workers,
    stats() {
      return { active, peak, order };
    },
  };
}

function request(nodeKey, pointCount = 1, requestedFields = 0) {
  return {
    nodeKey,
    pointCount,
    requestedFields,
    chunk: new Uint8Array([1, 2, 3]),
  };
}

test('Rust decode worker pool bounds concurrency and preserves FIFO order', async () => {
  const harness = createFakeWorkerHarness({ delay: 10 });
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 2, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([9, 8, 7]));

  const results = await Promise.all([
    pool.submit(request('first', 1)),
    pool.submit(request('second', 2)),
    pool.submit(request('third', 3)),
    pool.submit(request('fourth', 4)),
  ]);

  const diagnostics = pool.getDiagnostics();
  assert.equal(harness.stats().peak, 2);
  assert.equal(diagnostics.workerCount, 2);
  assert.equal(diagnostics.peakActiveCount, 2);
  assert.equal(diagnostics.peakQueuedCount, 2);
  assert.equal(diagnostics.activeCount, 0);
  assert.equal(diagnostics.queuedCount, 0);
  assert.equal(diagnostics.submittedCount, 4);
  assert.equal(diagnostics.completedCount, 4);
  assert.equal(diagnostics.cancelledCount, 0);
  assert.equal(diagnostics.failedCount, 0);
  assert.deepEqual(harness.stats().order, ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(results.map((result) => result.pointCount), [1, 2, 3, 4]);
  pool.destroy();
  assert.equal(harness.workers.every((worker) => worker.terminated), true);
});

test('Rust decode worker pool records activity for newly created slots', async () => {
  const harness = createFakeWorkerHarness();
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 2, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([9, 8, 7]));

  await Promise.all([
    pool.submit(request('first', 1)),
    pool.submit(request('second', 2)),
  ]);

  assert.equal(pool.getDiagnostics().peakActiveCount, 2);
  pool.destroy();
});

test('Rust decode worker pool transfers project-owned XYZ and attributes', async () => {
  const harness = createFakeWorkerHarness();
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 1, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([1]));

  const result = await pool.submit(request('attributes', 1, 7));
  assert.deepEqual([...result.coordinates], [1, 1, 3]);
  assert.deepEqual([...result.attributes.intensity], [11]);
  assert.deepEqual([...result.attributes.classification], [7]);
  assert.deepEqual([...result.attributes.red], [101]);
  assert.deepEqual([...result.attributes.green], [102]);
  assert.deepEqual([...result.attributes.blue], [103]);
  assert.equal(result.decodeDurationMs, 5);
  pool.destroy();
});

test('queued Rust decode work can be superseded while active work finishes', async () => {
  const harness = createFakeWorkerHarness({ delay: 20 });
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 1, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([1]));
  const active = pool.submit(request('active'));
  const queued = pool.submit(request('obsolete'));
  pool.cancelQueued();

  await assert.rejects(queued, (error) =>
    error instanceof RustCopcWorkerError && error.workerCode === 'worker-cancelled');
  assert.equal((await active).pointCount, 1);
  assert.deepEqual(harness.stats().order, ['active']);
  pool.destroy();
});

test('worker failures are structured and include the node key', async () => {
  const harness = createFakeWorkerHarness({ fail: true });
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 1, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([1]));

  await assert.rejects(pool.submit(request('failed')), (error) =>
    error instanceof RustCopcWorkerError
      && error.workerCode === 'worker-failure'
      && error.nodeKey === 'failed');
  pool.destroy();
});

test('destroy rejects queued and active decode work and is idempotent', async () => {
  const harness = createFakeWorkerHarness({ delay: 30 });
  const pool = new RustCopcDecodeWorkerPool({ workerCount: 1, workerFactory: harness.factory });
  pool.setMetadata(new Uint8Array([1]));
  const active = pool.submit(request('active'));
  const queued = pool.submit(request('queued'));
  pool.destroy();
  pool.destroy();

  await assert.rejects(active, (error) =>
    error instanceof RustCopcWorkerError && error.workerCode === 'worker-destroyed');
  await assert.rejects(queued, (error) =>
    error instanceof RustCopcWorkerError && error.workerCode === 'worker-destroyed');
});
