import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { Dataset } from './dataset.js';
import { info, success, warning } from './logger.js';

interface DownloadOptions {
  outputDir: string;
}

export async function downloadDataset(
  dataset: Dataset,
  options: DownloadOptions,
) {
  const destination = path.join(options.outputDir, dataset.filename);

  await fs.promises.mkdir(options.outputDir, { recursive: true });

  info(`Downloading ${dataset.name}`);
  info(`Source: ${dataset.url}`);
  info(`Destination: ${destination}`);

  const response = await fetch(dataset.url);

  if (!response.ok) {
    throw new Error(
      `Failed to download ${dataset.id}: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error(`No response body received for ${dataset.id}`);
  }

  const expectedLengthHeader = response.headers.get('content-length');
  const expectedLength = expectedLengthHeader
    ? Number.parseInt(expectedLengthHeader, 10)
    : null;

  if (fs.existsSync(destination) && expectedLength !== null) {
    const existing = await fs.promises.stat(destination);

    if (existing.size === expectedLength) {
      warning(
        `Skipping ${dataset.id}; file already exists and matches expected size.`,
      );
      return destination;
    }
  }

  const fileStream = fs.createWriteStream(destination);
  const bodyStream = Readable.fromWeb(response.body as globalThis.ReadableStream);

  try {
    bodyStream.pipe(fileStream);
    await finished(fileStream);
  } catch (error) {
    await fs.promises.rm(destination, { force: true });
    throw error;
  }

  const downloaded = await fs.promises.stat(destination);

  if (expectedLength !== null && downloaded.size !== expectedLength) {
    await fs.promises.rm(destination, { force: true });
    throw new Error(
      `Downloaded size mismatch for ${dataset.id}: expected ${expectedLength}, received ${downloaded.size}`,
    );
  }

  success(`Saved ${dataset.filename} (${downloaded.size} bytes)`);

  return destination;
}
