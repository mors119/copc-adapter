import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { probeCopcSource } from '../src/index.ts';

const FIXTURE_SIZE = 8192;

function makeLasFixture({ copc = true } = {}) {
  const bytes = new Uint8Array(FIXTURE_SIZE);
  bytes.set([76, 65, 83, 70]); // LASF
  const view = new DataView(bytes.buffer);
  view.setUint16(94, 375, true);
  view.setUint32(96, copc ? 589 : 375, true);
  view.setUint32(100, copc ? 1 : 0, true);
  bytes[104] = 7;
  view.setUint16(105, 36, true);

  if (copc) {
    const vlrOffset = 375;
    new TextEncoder().encodeInto('copc', bytes.subarray(vlrOffset + 2, vlrOffset + 18));
    view.setUint16(vlrOffset + 18, 1, true);
    view.setUint16(vlrOffset + 20, 160, true);
  }

  return bytes;
}

function rangeFromRequest(request) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  return match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
}

async function withFixture(mode, callback) {
  const bytes = makeLasFixture({ copc: mode !== 'las' });
  const requests = [];
  let bytesSent = 0;
  const server = createServer((request, response) => {
    const range = rangeFromRequest(request);
    requests.push({ mode, range });

    if (mode === 'network') {
      request.socket.destroy();
      return;
    }
    if (mode === '404') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (mode === '416') {
      response.writeHead(416, { 'Content-Range': `bytes */${bytes.byteLength}` });
      response.end();
      return;
    }
    if (!range) {
      response.writeHead(400);
      response.end();
      return;
    }

    const requested = bytes.subarray(range.start, Math.min(range.end + 1, bytes.length));
    if (mode === '200') {
      response.writeHead(200, { 'Content-Length': bytes.byteLength });
      response.end(bytes);
      bytesSent += bytes.byteLength;
      return;
    }

    const body = mode === 'short' ? requested.subarray(0, Math.max(0, requested.length - 1)) : requested;
    const contentRange = mode === 'invalid'
      ? 'not-a-content-range'
      : mode === 'mismatch'
        ? `bytes ${range.start + 1}-${range.end + 1}/${bytes.byteLength}`
        : mode === 'unknown-total'
          ? `bytes ${range.start}-${range.end}/*`
          : `bytes ${range.start}-${range.end}/${bytes.byteLength}`;
    const headers = {
      'Content-Length': body.byteLength,
      ...(mode === 'missing' ? {} : { 'Content-Range': contentRange }),
    };
    response.writeHead(206, headers);
    response.end(body);
    bytesSent += body.byteLength;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await callback({
      url: `http://127.0.0.1:${address.port}/fixture.copc.laz`,
      requests,
      get bytesSent() {
        return bytesSent;
      },
      fixtureSize: bytes.byteLength,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('probe reports a valid partial response and COPC metadata without fetching the file', async () => {
  await withFixture('valid', async ({ url, requests, bytesSent, fixtureSize }) => {
    const result = await probeCopcSource(url);

    assert.equal(result.reachable, true);
    assert.equal(result.rangeSupported, true);
    assert.equal(result.status, 206);
    assert.equal(result.partialStatus, 206);
    assert.deepEqual(result.requestedRange, { offset: 0, length: 1024 });
    assert.deepEqual(result.returnedRange, { offset: 0, length: 1024 });
    assert.equal(result.contentLength, fixtureSize);
    assert.equal(result.corsReadable, true);
    assert.equal(result.copcDetected, true);
    assert.equal(result.pointFormat, 7);
    assert.equal(result.warnings.length, 0);
    assert.deepEqual(requests.map(({ range }) => range), [{ start: 0, end: 1023 }]);
    assert.ok(bytesSent < fixtureSize, 'the happy path must not fetch the whole fixture');
  });
});

test('probe detects a server that ignores Range and reads only a bounded prefix', async () => {
  await withFixture('200', async ({ url }) => {
    const result = await probeCopcSource(url);

    assert.equal(result.reachable, true);
    assert.equal(result.rangeSupported, false);
    assert.equal(result.status, 200);
    assert.equal(result.copcDetected, true);
    assert.match(result.warnings.join(' '), /appears to ignore Range requests/);
  });
});

test('probe reports invalid, mismatched, missing, unknown-total, and short partial responses', async () => {
  for (const mode of ['invalid', 'mismatch', 'missing', 'unknown-total', 'short']) {
    await withFixture(mode, async ({ url }) => {
      const result = await probeCopcSource(url);

      assert.equal(result.reachable, true, mode);
      assert.equal(result.rangeSupported, mode === 'unknown-total', mode);
      assert.equal(result.status, 206, mode);
      if (mode !== 'unknown-total') {
        assert.ok(result.warnings.length > 0, mode);
      }
      if (['invalid', 'missing', 'unknown-total'].includes(mode)) {
        assert.equal(result.contentLength, undefined, mode);
      }
      if (mode === 'missing') {
        assert.match(result.warnings.join(' '), /Content-Range/);
      }
      if (mode === 'mismatch') {
        assert.match(result.warnings.join(' '), /does not match/);
        assert.deepEqual(result.returnedRange, { offset: 1, length: 1024 });
      }
      if (mode === 'short') {
        assert.match(result.warnings.join(' '), /expected exactly 1024/);
      }
    });
  }
});

test('probe marks a failed metadata range as unsupported', async () => {
  for (const mode of ['200', 'invalid', 'short', 'network']) {
    const prefix = new Uint8Array(1200);
    prefix.set([76, 65, 83, 70]); // LASF
    const view = new DataView(prefix.buffer);
    view.setUint16(94, 375, true);
    view.setUint32(96, 1200, true);
    view.setUint32(100, 0, true);
    prefix[104] = 7;
    const requests = [];
    const fetch = async (_source, init) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(init.headers.get('Range'));
      requests.push({ start: Number(range[1]), end: Number(range[2]) });
      if (requests.length === 1) {
        return new Response(prefix.subarray(0, 1024), {
          status: 206,
          headers: {
            'Content-Length': '1024',
            'Content-Range': 'bytes 0-1023/1200',
          },
        });
      }
      if (mode === 'network') {
        throw new TypeError('Failed to fetch');
      }
      const extension = prefix.subarray(1024);
      if (mode === '200') {
        return new Response(extension, {
          status: 200,
          headers: { 'Content-Length': String(extension.byteLength) },
        });
      }
      return new Response(mode === 'short' ? extension.subarray(0, extension.byteLength - 1) : extension, {
        status: 206,
        headers: {
          'Content-Length': String(mode === 'short' ? extension.byteLength - 1 : extension.byteLength),
          'Content-Range': mode === 'invalid' ? 'not-a-content-range' : 'bytes 1024-1199/1200',
        },
      });
    };

    const result = await probeCopcSource('https://example.test/large-metadata.copc.laz', { fetch });

    assert.equal(result.rangeSupported, false, mode);
    assert.deepEqual(requests, [
      { start: 0, end: 1023 },
      { start: 1024, end: 1199 },
    ], mode);
  }
});

test('probe reports HTTP 404 and 416 as reachable but unusable sources', async () => {
  for (const mode of ['404', '416']) {
    await withFixture(mode, async ({ url }) => {
      const result = await probeCopcSource(url);

      assert.equal(result.reachable, true, mode);
      assert.equal(result.rangeSupported, false, mode);
      assert.equal(result.status, mode === '404' ? 404 : 416, mode);
      assert.equal(result.copcDetected, 'unknown', mode);
      assert.match(result.warnings.join(' '), new RegExp(`HTTP ${mode}`));
    });
  }
});

test('probe keeps browser network/CORS failures uncertain', async () => {
  const result = await probeCopcSource('https://example.test/missing.copc.laz', {
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
  });

  assert.equal(result.reachable, false);
  assert.equal(result.rangeSupported, 'unknown');
  assert.equal(result.corsReadable, 'unknown');
  assert.equal(result.copcDetected, 'unknown');
  assert.match(result.warnings.join(' '), /network availability and CORS policy/);
});

test('probe distinguishes readable LAS from COPC', async () => {
  await withFixture('las', async ({ url }) => {
    const result = await probeCopcSource(url);

    assert.equal(result.reachable, true);
    assert.equal(result.rangeSupported, true);
    assert.equal(result.copcDetected, false);
    assert.equal(result.pointFormat, 7);
    assert.match(result.warnings.join(' '), /COPC/);
  });
});
