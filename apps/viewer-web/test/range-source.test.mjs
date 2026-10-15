import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpRangeByteSource,
  InMemoryByteSource,
  RangeSourceError,
} from '../src/index.ts';
import { redactSourceForDiagnostics } from '../src/copc/range/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(
  __dirname,
  '../../../samples/local/autzen.copc.laz',
);

function makeResponse(status, bytes, headers = {}) {
  return new Response(Uint8Array.from(bytes), { status, headers });
}

function createIndexedRangeFetch(calls) {
  return async (_input, init) => {
    const header = new Headers(init.headers).get('Range');
    const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? '');
    assert.ok(match);
    const offset = Number(match[1]);
    const end = Number(match[2]);
    calls.push({ offset, length: end - offset + 1, signal: init.signal });
    return new Response(Uint8Array.from(
      { length: end - offset + 1 },
      (_value, index) => (offset + index) % 256,
    ), {
      status: 206,
      headers: { 'Content-Range': `bytes ${offset}-${end}/10000000` },
    });
  };
}

test('HttpRangeByteSource constructs exact byte ranges and validates 206 bytes', async () => {
  const requests = [];
  const response = makeResponse(206, [3, 4, 5], {
    'Content-Range': 'bytes 12-14/100',
  });
  response.arrayBuffer = async () => {
    throw new Error('ranged responses must not be buffered with arrayBuffer()');
  };
  const source = new HttpRangeByteSource('https://example.test/autzen.copc.laz', {
    fetch: async (input, init) => {
      requests.push({ input, init });
      return response;
    },
  });

  assert.deepEqual([...await source.readRange(12, 3)], [3, 4, 5]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.get('Range'), 'bytes=12-14');
  assert.equal(await source.size(), 100);
});

test('HttpRangeByteSource redacts URL credentials and query values from errors', async () => {
  const source = new HttpRangeByteSource(
    'https://viewer:password@example.test/data.copc.laz?X-Amz-Signature=secret#private',
    { fetch: async () => makeResponse(200, [1]) },
  );

  await assert.rejects(
    () => source.readRange(0, 1),
    (error) => error instanceof RangeSourceError
      && error.code === 'whole-file-response'
      && error.source === 'https://example.test/data.copc.laz'
      && !error.source.includes('password')
      && !error.source.includes('secret'),
  );
});

test('redactSourceForDiagnostics removes credentials from scheme-relative URLs', () => {
  assert.equal(
    redactSourceForDiagnostics('//viewer:password@example.test/data?token=secret#private'),
    '//example.test/data',
  );
});

test('HttpRangeByteSource rejects invalid ranges before network access', async () => {
  let callCount = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => {
      callCount += 1;
      return makeResponse(206, [1], { 'Content-Range': 'bytes 0-0/1' });
    },
  });

  for (const [offset, length] of [[-1, 1], [0, 0], [0, -1], [0.5, 1]]) {
    await assert.rejects(
      () => source.readRange(offset, length),
      (error) => error instanceof RangeSourceError && error.code === 'invalid-range',
    );
  }

  assert.equal(callCount, 0);
});

test('HttpRangeByteSource rejects a server that ignores Range with 200', async () => {
  let pulled = false;
  let cancelled = false;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 }), { status: 200 }),
  });

  await assert.rejects(
    () => source.readRange(1, 2),
    (error) => error instanceof RangeSourceError
      && error.code === 'whole-file-response'
      && error.status === 200,
  );
  assert.equal(pulled, false, 'a whole-file response must be rejected before body reads');
  assert.equal(cancelled, true, 'the rejected response body should be cancelled');
});

test('HttpRangeByteSource rejects missing and malformed Content-Range headers', async () => {
  let headCalls = 0;
  for (const headers of [{}, { 'Content-Range': 'bytes 1-3/100' }]) {
    const source = new HttpRangeByteSource('https://example.test/data', {
      fetch: async (_input, init) => {
        if (init.method === 'HEAD') headCalls += 1;
        return makeResponse(206, [1, 2, 3], headers);
      },
    });

    await assert.rejects(
      () => source.readRange(0, 3),
      (error) => error instanceof RangeSourceError && error.code === 'content-range',
    );
  }
  assert.equal(headCalls, 0, 'strict mode must not add a HEAD request');
});

test('head-fallback validates an unreadable Content-Range with cached HEAD metadata and exact bytes', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => {
      const method = init.method ?? 'GET';
      calls.push(method);
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Length': '100000', ETag: '"stable"' },
        });
      }
      const range = new Headers(init.headers).get('Range');
      const [offset, end] = range.slice('bytes='.length).split('-').map(Number);
      return new Response(Uint8Array.from(
        { length: end - offset + 1 },
        (_value, index) => offset + index,
      ), {
        status: 206,
        headers: { 'Content-Length': String(end - offset + 1), ETag: '"stable"' },
      });
    },
  });

  assert.deepEqual([...await source.readRange(8, 3)], [8, 9, 10]);
  assert.deepEqual([...await source.readRange(30_000, 2)], [48, 49]);
  assert.equal(await source.size(), 100_000);
  assert.deepEqual(calls, ['GET', 'HEAD', 'GET']);
});

test('head-fallback shares in-flight HEAD work without coupling caller cancellation', async () => {
  let headCalls = 0;
  let headSignal;
  let resolveHead;
  const headStarted = new Promise((resolve) => {
    const start = resolve;
    resolveHead = start;
  });
  let finishHead;
  const source = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => {
      if (init.method === 'HEAD') {
        headCalls += 1;
        headSignal = init.signal;
        resolveHead();
        return new Promise((resolve) => {
          finishHead = () => resolve(new Response(null, {
            status: 200,
            headers: { 'Content-Length': '100000' },
          }));
          init.signal.addEventListener('abort', () => {
            resolve(new Response(null, { status: 499 }));
          }, { once: true });
        });
      }
      const range = new Headers(init.headers).get('Range');
      const [offset, end] = range.slice('bytes='.length).split('-').map(Number);
      return new Response(new Uint8Array(end - offset + 1).fill(offset % 256), {
        status: 206,
        headers: { 'Content-Length': String(end - offset + 1) },
      });
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = source.readRange(0, 2, { signal: firstController.signal });
  const second = source.readRange(20_000, 2, { signal: secondController.signal });
  await headStarted;
  await new Promise((resolve) => setImmediate(resolve));

  firstController.abort('superseded');
  await assert.rejects(first, (error) => error instanceof RangeSourceError && error.code === 'aborted');
  assert.equal(headSignal.aborted, false);
  assert.equal(headCalls, 1);

  finishHead();
  assert.deepEqual([...await second], [32, 32]);
});

test('head-fallback aborts its shared HEAD request when the last range is cancelled', async () => {
  let headSignal;
  let resolveHeadStarted;
  const headStarted = new Promise((resolve) => {
    resolveHeadStarted = resolve;
  });
  const source = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => {
      if (init.method === 'HEAD') {
        headSignal = init.signal;
        resolveHeadStarted();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return makeResponse(206, [1], { 'Content-Length': '1' });
    },
  });
  const controller = new AbortController();
  const pending = source.readRange(0, 1, { signal: controller.signal });
  await headStarted;
  controller.abort('lifecycle');

  await assert.rejects(
    pending,
    (error) => error instanceof RangeSourceError && error.code === 'aborted',
  );
  assert.equal(headSignal.aborted, true);
});

test('head-fallback rejects a HEAD size that contradicts the configured source size', async () => {
  const source = new HttpRangeByteSource('https://example.test/data', {
    size: 100,
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => init.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'Content-Length': '101' } })
      : makeResponse(206, [1], { 'Content-Length': '1' }),
  });

  await assert.rejects(
    () => source.readRange(0, 1),
    (error) => error instanceof RangeSourceError && error.code === 'source-size-changed',
  );
});

test('head-fallback rejects invalid visible Content-Range without downgrading', async () => {
  let headCalls = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => {
      if (init.method === 'HEAD') {
        headCalls += 1;
        return new Response(null, { status: 200, headers: { 'Content-Length': '100' } });
      }
      return makeResponse(206, [1, 2], { 'Content-Range': 'bytes 1-2/100' });
    },
  });

  await assert.rejects(
    () => source.readRange(0, 2),
    (error) => error instanceof RangeSourceError && error.code === 'content-range',
  );
  assert.equal(headCalls, 0);
});

test('HttpRangeByteSource rejects contradictory sizes and readable validator changes', async () => {
  let call = 0;
  const changingSize = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      const range = new Headers(init.headers).get('Range');
      const [offset, end] = range.slice('bytes='.length).split('-').map(Number);
      call += 1;
      return new Response(new Uint8Array(end - offset + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${offset}-${end}/${call === 1 ? 100 : 101}`,
          'Content-Length': String(end - offset + 1),
        },
      });
    },
  });
  await changingSize.readRange(0, 1);
  await assert.rejects(
    () => changingSize.readRange(10, 1),
    (error) => error instanceof RangeSourceError && error.code === 'source-size-changed',
  );

  let etagCall = 0;
  const changingValidator = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => {
      if (init.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Length': '100', ETag: '"version-a"' },
        });
      }
      etagCall += 1;
      return makeResponse(206, [1], {
        'Content-Length': '1',
        ETag: etagCall === 1 ? '"version-a"' : '"version-b"',
      });
    },
  });
  await changingValidator.readRange(0, 1);
  await assert.rejects(
    () => changingValidator.readRange(2, 1),
    (error) => error instanceof RangeSourceError && error.code === 'source-changed',
  );
});

test('HttpRangeByteSource records validators before awaiting concurrent range bodies', async () => {
  let releaseFirstBody;
  let resolveFirstBodyRead;
  const firstBodyRead = new Promise((resolve) => {
    resolveFirstBodyRead = resolve;
  });
  let resolveSecondResponse;
  let resolveSecondRequest;
  const secondRequest = new Promise((resolve) => {
    resolveSecondRequest = resolve;
  });

  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      const range = new Headers(init.headers).get('Range');
      if (range === 'bytes=0-0') {
        return new Response(new ReadableStream({
          pull(controller) {
            resolveFirstBodyRead();
            return new Promise((resolve) => {
              releaseFirstBody = () => {
                controller.enqueue(new Uint8Array([1]));
                controller.close();
                resolve();
              };
            });
          },
        }, { highWaterMark: 0 }), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-0/100001',
            'Content-Length': '1',
            ETag: '"version-a"',
          },
        });
      }

      assert.equal(range, 'bytes=10000-10000');
      resolveSecondRequest();
      return new Promise((resolve) => {
        resolveSecondResponse = () => resolve(makeResponse(206, [2], {
          'Content-Range': 'bytes 10000-10000/100001',
          'Content-Length': '1',
          ETag: '"version-b"',
        }));
      });
    },
  });

  const first = source.readRange(0, 1);
  const second = source.readRange(10_000, 1);
  await Promise.all([firstBodyRead, secondRequest]);
  resolveSecondResponse();

  let secondOutcome;
  try {
    secondOutcome = await second.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  } finally {
    releaseFirstBody();
  }
  assert.ok(
    secondOutcome.error instanceof RangeSourceError && secondOutcome.error.code === 'source-changed',
  );
  assert.deepEqual([...await first], [1]);
});

test('head-fallback rejects HEAD failures, invalid lengths, and out-of-bounds reads', async () => {
  for (const response of [
    new Response(null, { status: 405 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 200, headers: { 'Content-Length': '9007199254740992' } }),
  ]) {
    const source = new HttpRangeByteSource('https://example.test/data', {
      rangeValidation: 'head-fallback',
      fetch: async (_input, init) => init.method === 'HEAD'
        ? response
        : makeResponse(206, [1], { 'Content-Length': '1' }),
    });
    await assert.rejects(
      () => source.readRange(0, 1),
      (error) => error instanceof RangeSourceError && error.code === 'head-metadata',
    );
  }

  const source = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => init.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'Content-Length': '1' } })
      : makeResponse(206, [1, 2], { 'Content-Length': '2' }),
  });
  await assert.rejects(
    () => source.readRange(0, 2),
    (error) => error instanceof RangeSourceError && error.code === 'out-of-bounds',
  );
});

test('HttpRangeByteSource reports HTTP failures and short bodies structurally', async () => {
  for (const status of [404, 416]) {
    const source = new HttpRangeByteSource('https://example.test/data', {
      fetch: async () => makeResponse(status, []),
    });

    await assert.rejects(
      () => source.readRange(0, 3),
      (error) => error instanceof RangeSourceError
        && error.code === 'http-status'
        && error.status === status,
    );
  }

  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => makeResponse(206, [1, 2], {
      'Content-Range': 'bytes 0-2/3',
    }),
  });

  await assert.rejects(
    () => source.readRange(0, 3),
    (error) => error instanceof RangeSourceError && error.code === 'body-length',
  );
});

test('HttpRangeByteSource rejects declared oversized bodies before reading and stops at first streamed surplus', async () => {
  let pulled = false;
  let declaredBodyCancelled = false;
  const declaredLengthSource = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => new Response(new ReadableStream({
      pull() {
        pulled = true;
      },
      cancel() {
        declaredBodyCancelled = true;
      },
    }, { highWaterMark: 0 }), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 0-1/100',
        'Content-Length': '1000000',
      },
    }),
  });
  await assert.rejects(
    () => declaredLengthSource.readRange(0, 2),
    (error) => error instanceof RangeSourceError && error.code === 'body-length',
  );
  assert.equal(pulled, false);
  assert.equal(declaredBodyCancelled, true);

  let surplusCancelled = false;
  let surplusBytesProduced = 0;
  const surplusSource = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        surplusBytesProduced += 1;
        controller.enqueue(new Uint8Array([surplusBytesProduced]));
      },
      cancel() {
        surplusCancelled = true;
      },
    }, { highWaterMark: 0 }), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-1/100' },
    }),
  });
  await assert.rejects(
    () => surplusSource.readRange(0, 2),
    (error) => error instanceof RangeSourceError && error.code === 'body-length',
  );
  assert.equal(surplusCancelled, true);
  assert.equal(surplusBytesProduced, 3, 'the reader must cancel after one surplus byte');
});

test('HttpRangeByteSource rejects visible non-identity representations', async () => {
  const encodedHead = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => init.method === 'HEAD'
      ? new Response(null, {
          status: 200,
          headers: { 'Content-Length': '100', 'Content-Encoding': 'gzip' },
        })
      : makeResponse(206, [1], { 'Content-Length': '1' }),
  });
  await assert.rejects(
    () => encodedHead.readRange(0, 1),
    (error) => error instanceof RangeSourceError && error.code === 'representation',
  );

  const encodedRange = new HttpRangeByteSource('https://example.test/data', {
    rangeValidation: 'head-fallback',
    fetch: async (_input, init) => init.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'Content-Length': '100' } })
      : makeResponse(206, [1], {
          'Content-Length': '1',
          'Content-Encoding': 'br',
        }),
  });
  await assert.rejects(
    () => encodedRange.readRange(0, 1),
    (error) => error instanceof RangeSourceError && error.code === 'representation',
  );
});

test('HttpRangeByteSource enforces a 64 MiB per-request ceiling before network access', async () => {
  let fetchCount = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => {
      fetchCount += 1;
      return makeResponse(206, [1], { 'Content-Range': 'bytes 0-0/1' });
    },
  });

  await assert.rejects(
    () => source.readRanges([
      { offset: 0, length: 1 },
      { offset: 1, length: 64 * 1024 * 1024 + 1 },
    ]),
    (error) => error instanceof RangeSourceError && error.code === 'range-too-large',
  );
  assert.equal(fetchCount, 0);
});

test('HttpRangeByteSource reports network failures structurally', async () => {
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => {
      throw new Error('connection reset');
    },
  });

  await assert.rejects(
    () => source.readRange(0, 3),
    (error) => error instanceof RangeSourceError && error.code === 'network',
  );
});

test('HttpRangeByteSource keeps far disjoint reads separate and concurrent', async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      const range = init.headers.get('Range');
      calls.push(range);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      return makeResponse(
        206,
        Array.from({ length: end - start + 1 }, (_, index) => start + index),
        { 'Content-Range': `bytes ${range.slice('bytes='.length)}/1000000` },
      );
    },
  });

  const result = await source.readRanges([
    { offset: 0, length: 2 },
    { offset: 20_000, length: 3 },
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [[0, 1], [32, 33, 34]]);
  assert.deepEqual(calls, ['bytes=0-1', 'bytes=20000-20002']);
  assert.equal(maximumActive, 2);
});

test('HttpRangeByteSource bounds active disjoint range fetches and starts queued work as slots free', async () => {
  const pendingResponses = [];
  let active = 0;
  let maximumActive = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range') ?? '');
      assert.ok(match);
      const offset = Number(match[1]);
      const end = Number(match[2]);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise((resolve) => {
        pendingResponses.push(() => {
          active -= 1;
          resolve(makeResponse(206, [offset % 256], {
            'Content-Range': `bytes ${offset}-${end}/1000000`,
          }));
        });
      });
    },
  });

  const reads = Array.from({ length: 6 }, (_value, index) =>
    source.readRange(index * 10_000, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingResponses.length, 4);
  assert.equal(maximumActive, 4);

  pendingResponses[0]();
  assert.deepEqual([...await reads[0]], [0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingResponses.length, 5, 'a queued fetch starts when one slot is released');

  for (let index = 1; index < reads.length; index += 1) {
    pendingResponses[index]();
    await reads[index];
  }
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
});

test('HttpRangeByteSource skips a queued group when its last caller cancels', async () => {
  const pendingResponses = [];
  let fetchCount = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('Range') ?? '');
      assert.ok(match);
      const offset = Number(match[1]);
      const end = Number(match[2]);
      fetchCount += 1;
      return new Promise((resolve) => {
        pendingResponses.push(() => resolve(makeResponse(206, [offset % 256], {
          'Content-Range': `bytes ${offset}-${end}/1000000`,
        })));
      });
    },
  });

  const activeReads = Array.from({ length: 4 }, (_value, index) =>
    source.readRange(index * 10_000, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 4);

  const queuedController = new AbortController();
  const queuedRead = source.readRange(100_000, 1, { signal: queuedController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  queuedController.abort('no longer needed');
  await assert.rejects(
    () => queuedRead,
    (error) => error instanceof RangeSourceError && error.code === 'aborted',
  );

  pendingResponses[0]();
  assert.deepEqual([...await activeReads[0]], [0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCount, 4, 'a cancelled queued group must not start a fetch');

  for (let index = 1; index < activeReads.length; index += 1) {
    pendingResponses[index]();
    await activeReads[index];
  }
});

test('HttpRangeByteSource coalesces overlapping and adjacent direct reads into exact slices', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  const result = await Promise.all([
    source.readRange(10, 5),
    source.readRange(12, 4),
    source.readRange(16, 2),
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [
    [10, 11, 12, 13, 14],
    [12, 13, 14, 15],
    [16, 17],
  ]);
  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 10, length: 8 },
  ]);
});

test('HttpRangeByteSource returns independent buffers for duplicate full-span reads', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  const [first, second] = await Promise.all([
    source.readRange(10, 4),
    source.readRange(10, 4),
  ]);

  assert.deepEqual([...first], [10, 11, 12, 13]);
  assert.deepEqual([...second], [10, 11, 12, 13]);
  assert.notEqual(first.buffer, second.buffer);
  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 10, length: 4 },
  ]);
});

test('HttpRangeByteSource coalesces a gap at the configured 4 KiB limit', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  const result = await source.readRanges([
    { offset: 0, length: 3 },
    { offset: 4099, length: 2 },
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [[0, 1, 2], [3, 4]]);
  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 4101 },
  ]);
});

test('HttpRangeByteSource keeps a gap above the configured limit separate', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  const result = await source.readRanges([
    { offset: 0, length: 1 },
    { offset: 4098, length: 1 },
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [[0], [2]]);
  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 1 },
    { offset: 4098, length: 1 },
  ]);
});

test('HttpRangeByteSource keeps a merged span above 1 MiB separate', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  await source.readRanges([
    { offset: 0, length: 600_000 },
    { offset: 600_000, length: 448_577 },
  ]);

  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 600_000 },
    { offset: 600_000, length: 448_577 },
  ]);
});

test('HttpRangeByteSource sorts ranges for fetching and preserves duplicate result order', async () => {
  const calls = [];
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: createIndexedRangeFetch(calls),
  });

  const result = await source.readRanges([
    { offset: 8, length: 2 },
    { offset: 0, length: 2 },
    { offset: 4, length: 4 },
    { offset: 0, length: 2 },
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [
    [8, 9],
    [0, 1],
    [4, 5, 6, 7],
    [0, 1],
  ]);
  assert.notEqual(result[1].buffer, result[3].buffer);
  assert.deepEqual(calls.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 10 },
  ]);
});

test('HttpRangeByteSource rejects invalid multi-range input before network access', async () => {
  let callCount = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => {
      callCount += 1;
      return makeResponse(206, [0], { 'Content-Range': 'bytes 0-0/1' });
    },
  });

  await assert.rejects(
    () => source.readRanges([
      { offset: 0, length: 1 },
      { offset: Number.MAX_SAFE_INTEGER, length: 2 },
    ]),
    (error) => error instanceof RangeSourceError && error.code === 'invalid-range',
  );
  assert.equal(callCount, 0);
});

test('HttpRangeByteSource preserves original-range errors for malformed merged responses', async () => {
  for (const response of [
    makeResponse(206, [1, 2, 3], { 'Content-Range': 'bytes 1-3/100' }),
    makeResponse(206, [1, 2], { 'Content-Range': 'bytes 0-2/100' }),
  ]) {
    const source = new HttpRangeByteSource('https://example.test/data', {
      fetch: async () => response,
    });
    await assert.rejects(
      () => source.readRanges([
        { offset: 0, length: 2 },
        { offset: 2, length: 1 },
      ]),
      (error) => error instanceof RangeSourceError
        && error.offset === 0
        && error.length === 2
        && ['content-range', 'body-length'].includes(error.code),
    );
  }
});

test('HttpRangeByteSource keeps a merged fetch alive until every caller cancels', async () => {
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  let mergedSignal;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => {
      mergedSignal = init.signal;
      resolveStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = source.readRange(10, 2, { signal: firstController.signal });
  const second = source.readRange(12, 2, { signal: secondController.signal });
  await started;

  firstController.abort();
  await assert.rejects(first, (error) => error instanceof RangeSourceError && error.code === 'aborted');
  assert.equal(mergedSignal.aborted, false);

  secondController.abort();
  await assert.rejects(second, (error) => error instanceof RangeSourceError && error.code === 'aborted');
  assert.equal(mergedSignal.aborted, true);
});

test('HttpRangeByteSource removes reads cancelled before the fetch batch starts', async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => {
      fetchCount += 1;
      return makeResponse(206, [1], { 'Content-Range': 'bytes 0-0/1' });
    },
  });

  const pending = source.readRange(0, 1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof RangeSourceError && error.code === 'aborted',
  );
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(fetchCount, 0);
});

test('HttpRangeByteSource maps AbortSignal cancellation', async () => {
  const controller = new AbortController();
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    }),
  });

  const pending = source.readRange(0, 1, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    () => pending,
    (error) => error instanceof RangeSourceError && error.code === 'aborted',
  );
});

test('InMemoryByteSource provides the same bounded random-access semantics', async () => {
  const source = new InMemoryByteSource([0, 1, 2, 3, 4, 5]);

  assert.equal(await source.size(), 6);
  assert.deepEqual(
    (await source.readRanges([
      { offset: 1, length: 2 },
      { offset: 4, length: 2 },
    ])).map((bytes) => [...bytes]),
    [[1, 2], [4, 5]],
  );
  await assert.rejects(
    () => source.readRange(5, 2),
    (error) => error instanceof RangeSourceError && error.code === 'out-of-bounds',
  );
});

test('InMemoryByteSource reads arbitrary sections of the Autzen COPC sample', async (t) => {
  if (!existsSync(samplePath)) {
    t.skip('Autzen sample is downloaded by the integration environment');
    return;
  }

  const bytes = await readFile(samplePath);
  const source = new InMemoryByteSource(bytes, samplePath);
  const [header, tail] = await source.readRanges([
    { offset: 0, length: 32 },
    { offset: bytes.byteLength - 32, length: 32 },
  ]);

  assert.equal(header.byteLength, 32);
  assert.equal(tail.byteLength, 32);
  assert.deepEqual([...header.slice(0, 4)], [76, 65, 83, 70]);
});

test('HttpRangeByteSource coalesces nearby Autzen metadata without downloading the file', async (t) => {
  if (!existsSync(samplePath)) {
    t.skip('Autzen sample is downloaded by the integration environment');
    return;
  }

  const bytes = await readFile(samplePath);
  const requests = [];
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) {
      response.writeHead(416);
      response.end();
      return;
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    requests.push({ start, end });
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
      'Content-Length': end - start + 1,
    });
    response.end(bytes.subarray(start, end + 1));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    const source = new HttpRangeByteSource(`http://127.0.0.1:${address.port}/autzen.copc.laz`);
    const [header, info] = await source.readRanges([
      { offset: 0, length: 32 },
      { offset: 375, length: 24 },
    ]);

    assert.deepEqual([...header.slice(0, 4)], [76, 65, 83, 70]);
    assert.equal(info.byteLength, 24);
    assert.deepEqual(requests, [{ start: 0, end: 398 }]);
    assert.ok(399 < bytes.byteLength);
  } finally {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
