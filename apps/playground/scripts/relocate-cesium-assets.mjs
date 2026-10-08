import { access, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.join(appDirectory, 'dist');
const pluginOutputDirectory = path.join(distDirectory, 'copc-adapter/playground/cesium');
const cesiumDirectory = path.join(distDirectory, 'cesium');

try {
  await access(path.join(pluginOutputDirectory, 'Workers'));
} catch {
  throw new Error('Cesium plugin did not emit static assets at the configured Playground base.');
}

await rm(cesiumDirectory, { recursive: true, force: true });
await rename(pluginOutputDirectory, cesiumDirectory);
await rm(path.join(distDirectory, 'copc-adapter'), { recursive: true, force: true });
