import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type { Dataset } from "./dataset.js";
import { info, success, warning } from "./logger.js";

interface DownloadOptions {
  outputDir: string;
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function downloadDataset(
  dataset: Dataset,
  options: DownloadOptions,
) {
  const destination = path.join(options.outputDir, dataset.filename);

  if (dataset.sha256 && !/^[a-f\d]{64}$/i.test(dataset.sha256)) {
    throw new Error(
      `Invalid SHA-256 checksum in the registry for ${dataset.id}`,
    );
  }
  if (
    dataset.sizeBytes !== undefined &&
    (!Number.isSafeInteger(dataset.sizeBytes) || dataset.sizeBytes <= 0)
  ) {
    throw new Error(`Invalid expected size in the registry for ${dataset.id}`);
  }

  await fs.promises.mkdir(options.outputDir, { recursive: true });

  if (
    dataset.sizeBytes !== undefined &&
    dataset.sha256 &&
    fs.existsSync(destination)
  ) {
    const existing = await fs.promises.stat(destination);
    const checksumMatches =
      (await sha256File(destination)).toLowerCase() ===
      dataset.sha256.toLowerCase();
    if (existing.size === dataset.sizeBytes && checksumMatches) {
      warning(
        `Skipping ${dataset.id}; cached file matches the configured size and checksum.`,
      );
      return destination;
    }
    warning(
      `Replacing cached ${dataset.id}; its configured size or SHA-256 checksum does not match.`,
    );
    await fs.promises.rm(destination, { force: true });
  }

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

  const expectedLengthHeader = response.headers.get("content-length");
  const expectedLength = expectedLengthHeader
    ? Number.parseInt(expectedLengthHeader, 10)
    : null;
  const expectedSize = dataset.sizeBytes ?? expectedLength;

  if (fs.existsSync(destination)) {
    const existing = await fs.promises.stat(destination);
    const sizeMatches = expectedSize === null || existing.size === expectedSize;
    const checksumMatches =
      !dataset.sha256 ||
      (await sha256File(destination)).toLowerCase() ===
        dataset.sha256.toLowerCase();

    if (
      sizeMatches &&
      checksumMatches &&
      (expectedSize !== null || dataset.sha256)
    ) {
      warning(
        `Skipping ${dataset.id}; cached file matches the configured size and checksum.`,
      );
      return destination;
    }

    if (sizeMatches && !checksumMatches) {
      warning(
        `Replacing cached ${dataset.id}; its SHA-256 checksum does not match the registry.`,
      );
    }
  }

  const fileStream = fs.createWriteStream(destination);
  const bodyStream = Readable.fromWeb(
    response.body as globalThis.ReadableStream,
  );

  try {
    bodyStream.pipe(fileStream);
    await finished(fileStream);
  } catch (error) {
    await fs.promises.rm(destination, { force: true });
    throw error;
  }

  const downloaded = await fs.promises.stat(destination);

  if (expectedSize !== null && downloaded.size !== expectedSize) {
    await fs.promises.rm(destination, { force: true });
    throw new Error(
      `Downloaded size mismatch for ${dataset.id}: expected ${expectedSize}, received ${downloaded.size}`,
    );
  }

  if (dataset.sha256) {
    const actualSha256 = await sha256File(destination);
    if (actualSha256.toLowerCase() !== dataset.sha256.toLowerCase()) {
      await fs.promises.rm(destination, { force: true });
      throw new Error(
        `Downloaded SHA-256 mismatch for ${dataset.id}: expected ${dataset.sha256}, received ${actualSha256}`,
      );
    }
  }

  success(`Saved ${dataset.filename} (${downloaded.size} bytes)`);

  return destination;
}
