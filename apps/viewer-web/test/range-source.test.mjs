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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const samplePath = path.resolve(
  __dirname,
  '../../../samples/local/autzen.copc.laz',
);

function makeResponse(status, bytes, headers = {}) {
  return new Response(Uint8Array.from(bytes), { status, headers });
}

test('HttpRangeByteSource constructs exact byte ranges and validates 206 bytes', async () => {
  const requests = [];
  const source = new HttpRangeByteSource('https://example.test/autzen.copc.laz', {
    fetch: async (input, init) => {
      requests.push({ input, init });
      return makeResponse(206, [3, 4, 5], {
        'Content-Range': 'bytes 12-14/100',
      });
    },
  });

  assert.deepEqual([...await source.readRange(12, 3)], [3, 4, 5]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.get('Range'), 'bytes=12-14');
  assert.equal(await source.size(), 100);
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
  const source = new HttpRangeByteSource('https://example.test/data', {
    fetch: async () => makeResponse(200, [1, 2, 3, 4]),
  });

  await assert.rejects(
    () => source.readRange(1, 2),
    (error) => error instanceof RangeSourceError
      && error.code === 'whole-file-response'
      && error.status === 200,
  );
});

test('HttpRangeByteSource rejects missing and malformed Content-Range headers', async () => {
  for (const headers of [{}, { 'Content-Range': 'bytes 1-3/100' }]) {
    const source = new HttpRangeByteSource('https://example.test/data', {
      fetch: async () => makeResponse(206, [1, 2, 3], headers),
    });

    await assert.rejects(
      () => source.readRange(0, 3),
      (error) => error instanceof RangeSourceError && error.code === 'content-range',
    );
  }
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

test('HttpRangeByteSource performs disjoint reads concurrently', async () => {
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
        { 'Content-Range': `bytes ${range.slice('bytes='.length)}/${end + 10}` },
      );
    },
  });

  const result = await source.readRanges([
    { offset: 0, length: 2 },
    { offset: 20, length: 3 },
  ]);

  assert.deepEqual(result.map((bytes) => [...bytes]), [[0, 1], [20, 21, 22]]);
  assert.deepEqual(calls, ['bytes=0-1', 'bytes=20-22']);
  assert.equal(maximumActive, 2);
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

test('HttpRangeByteSource reads disjoint Autzen sections without downloading the file', async (t) => {
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
    assert.deepEqual(requests, [
      { start: 0, end: 31 },
      { start: 375, end: 398 },
    ]);
    assert.ok(56 < bytes.byteLength);
  } finally {
    await new Promise((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
