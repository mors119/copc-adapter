import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Dataset } from './dataset.js';
import { info, success, warning } from './logger.js';

interface DownloadOptions {
  outputDir: string;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function validateCachedFile(
  dataset: Dataset,
  filename: string,
): Promise<{ valid: boolean; reason?: string }> {
  const stat = await fs.promises.stat(filename);
  if (dataset.sizeBytes !== undefined && stat.size !== dataset.sizeBytes) {
    return {
      valid: false,
      reason: `size ${stat.size} bytes; expected ${dataset.sizeBytes}`,
    };
  }

  if (!dataset.sha256) {
    return { valid: false, reason: 'the registry has no SHA-256 checksum' };
  }

  const actualSha256 = await sha256File(filename);
  if (actualSha256.toLowerCase() !== dataset.sha256.toLowerCase()) {
    return {
      valid: false,
      reason: `SHA-256 ${actualSha256}; expected ${dataset.sha256}`,
    };
  }

  return { valid: true };
}

export async function downloadDataset(
  dataset: Dataset,
  options: DownloadOptions,
): Promise<string> {
  const destination = path.join(options.outputDir, dataset.filename);
  const temporary = `${destination}.part`;

  if (dataset.sha256 && !/^[a-f\d]{64}$/i.test(dataset.sha256)) {
    throw new Error(`Invalid SHA-256 checksum in the registry for ${dataset.id}`);
  }
  if (dataset.sizeBytes !== undefined
    && (!Number.isSafeInteger(dataset.sizeBytes) || dataset.sizeBytes <= 0)) {
    throw new Error(`Invalid expected size in the registry for ${dataset.id}`);
  }

  await fs.promises.mkdir(options.outputDir, { recursive: true });

  if (fs.existsSync(destination)) {
    const cached = await validateCachedFile(dataset, destination);
    if (cached.valid) {
      info(`Skipping ${dataset.id}; cached size and SHA-256 match the registry.`);
      return destination;
    }

    warning(`Replacing cached ${dataset.id}: ${cached.reason}.`);
    if (dataset.sha256) {
      await fs.promises.rm(destination, { force: true });
    }
  }

  await fs.promises.rm(temporary, { force: true });
  info(`Downloading ${dataset.name}`);
  info(`Source: ${dataset.url}`);
  info(`Destination: ${destination}`);

  try {
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
    const contentLength = expectedLengthHeader === null
      ? undefined
      : Number(expectedLengthHeader);
    const expectedSize = dataset.sizeBytes ?? (
      contentLength !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0
        ? contentLength
        : undefined
    );

    await pipeline(
      Readable.fromWeb(response.body as globalThis.ReadableStream<Uint8Array>),
      fs.createWriteStream(temporary, { flags: 'wx' }),
    );

    const downloaded = await fs.promises.stat(temporary);
    if (expectedSize !== undefined && downloaded.size !== expectedSize) {
      throw new Error(
        `Downloaded size mismatch for ${dataset.id}: expected ${expectedSize}, received ${downloaded.size}`,
      );
    }

    if (dataset.sha256) {
      const actualSha256 = await sha256File(temporary);
      if (actualSha256.toLowerCase() !== dataset.sha256.toLowerCase()) {
        throw new Error(
          `Downloaded SHA-256 mismatch for ${dataset.id}: expected ${dataset.sha256}, received ${actualSha256}`,
        );
      }
    }

    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
    const saved = await fs.promises.stat(destination);
    success(`Saved ${dataset.filename} (${saved.size} bytes)`);
    return destination;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}
