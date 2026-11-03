import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const [tilesManifest, repositoryLock] = await Promise.all([
  readFile(join(packageRoot, 'package.json'), 'utf8').then(JSON.parse),
  readFile(join(repositoryRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
]);

export const cesiumTestVersion = tilesManifest.devDependencies?.cesium;
if (typeof cesiumTestVersion !== 'string') {
  throw new Error('Tiles declares a Cesium development dependency for renderer tests.');
}

export const cesiumTestOverrides = Object.fromEntries(
  ['@cesium/core', '@cesium/engine', '@cesium/widgets'].map((name) => {
    const version = repositoryLock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== 'string') {
      throw new Error(`The repository lockfile pins ${name} for Cesium renderer tests.`);
    }
    return [name, version];
  }),
);
