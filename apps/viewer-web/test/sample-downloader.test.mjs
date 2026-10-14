import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { downloadDataset } from '../../../scripts/lib/downloader.ts';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function serveBytes(bytes) {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Sample test server did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/sample.copc.laz`,
    get requestCount() { return requestCount; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

test('replaces same-size cached sample data and skips a verified checksum on the next run', async () => {
  const bytes = Buffer.from('verified COPC sample bytes');
  const server = await serveBytes(bytes);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copc-sample-'));
  const dataset = {
    id: 'test',
    name: 'Test COPC',
    filename: 'sample.copc.laz',
    url: server.url,
    sizeBytes: bytes.length,
    sha256: digest(bytes),
  };
  const destination = path.join(outputDir, dataset.filename);

  try {
    await fs.writeFile(destination, Buffer.alloc(bytes.length, 0x78));
    assert.equal((await fs.stat(destination)).size, bytes.length);

    await downloadDataset(dataset, { outputDir });
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.equal(server.requestCount, 1);

    await downloadDataset(dataset, { outputDir });
    assert.equal(server.requestCount, 1);
    await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
  } finally {
    await server.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('removes a partial download when its checksum does not match', async () => {
  const bytes = Buffer.from('different payload');
  const server = await serveBytes(bytes);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copc-sample-'));
  const dataset = {
    id: 'test',
    name: 'Test COPC',
    filename: 'sample.copc.laz',
    url: server.url,
    sizeBytes: bytes.length,
    sha256: '0'.repeat(64),
  };
  const destination = path.join(outputDir, dataset.filename);

  try {
    await assert.rejects(
      downloadDataset(dataset, { outputDir }),
      /Downloaded SHA-256 mismatch/,
    );
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
  } finally {
    await server.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
