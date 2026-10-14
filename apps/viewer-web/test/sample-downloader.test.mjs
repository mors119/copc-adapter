import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { downloadDataset } from '../../../scripts/lib/downloader.ts';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('validates configured dataset size and SHA-256 before retaining a download', async (t) => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copc-sample-'));
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from('small checked COPC fixture');
  const wrongBytes = Buffer.from(bytes);
  wrongBytes[0] ^= 1;
  let servedBytes = bytes;
  let fetchCount = 0;
  const dataset = {
    id: 'fixture',
    name: 'Checked fixture',
    description: 'A small downloader test fixture.',
    filename: 'fixture.copc.laz',
    url: 'https://example.invalid/fixture.copc.laz',
    size: `${bytes.length} B`,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    category: 'test',
    recommended: false,
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(outputDir, { recursive: true, force: true });
  });
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(servedBytes, {
      headers: { 'content-length': String(servedBytes.length) },
    });
  };

  const destination = await downloadDataset(dataset, { outputDir });
  assert.equal(await fs.readFile(destination, 'utf8'), bytes.toString('utf8'));
  await downloadDataset(dataset, { outputDir });
  assert.equal(fetchCount, 1, 'a valid cached file should avoid another network request');

  await fs.writeFile(destination, wrongBytes);
  await downloadDataset(dataset, { outputDir });
  assert.equal(await fs.readFile(destination, 'utf8'), bytes.toString('utf8'));
  assert.equal(fetchCount, 2, 'an invalid cached checksum should be downloaded again');

  servedBytes = wrongBytes;
  await fs.rm(destination);
  await assert.rejects(
    downloadDataset(dataset, { outputDir }),
    /Downloaded SHA-256 mismatch/,
  );
  await assert.rejects(fs.access(destination));
});
