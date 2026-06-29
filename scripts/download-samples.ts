import fs from 'node:fs';
import path from 'node:path';

import { downloadDataset } from './lib/downloader.js';
import type { DatasetRegistry } from './lib/dataset.js';
import { error, info, warning } from './lib/logger.js';

const registryPath = path.resolve('samples', 'datasets.json');
const outputDir = path.resolve('samples', 'local');

const registry = JSON.parse(
  fs.readFileSync(registryPath, 'utf8'),
) as DatasetRegistry;

async function main() {
  const requestedIds = process.argv.slice(2);

  const selectedDatasets =
    requestedIds.length > 0
      ? registry.datasets.filter((dataset) => requestedIds.includes(dataset.id))
      : registry.datasets.filter((dataset) => dataset.recommended);

  const unknownIds = requestedIds.filter(
    (id) => !registry.datasets.some((dataset) => dataset.id === id),
  );

  if (unknownIds.length > 0) {
    error(`Unknown dataset id(s): ${unknownIds.join(', ')}`);
    process.exit(1);
  }

  if (selectedDatasets.length === 0) {
    warning('No datasets selected.');
    process.exit(0);
  }

  info(`Registry: ${registryPath}`);
  info(`Output directory: ${outputDir}`);
  info(
    `Selected dataset(s): ${selectedDatasets
      .map((dataset) => dataset.id)
      .join(', ')}`,
  );

  for (const dataset of selectedDatasets) {
    await downloadDataset(dataset, { outputDir });
  }
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  error(message);
  process.exit(1);
});
