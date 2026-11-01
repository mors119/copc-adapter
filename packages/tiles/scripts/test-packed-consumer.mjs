import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRequire = createRequire(import.meta.url);
const viteCli = join(await findPackageDirectory('vite'), 'bin/vite.js');
const typescriptCli = join(await findPackageDirectory('typescript'), 'bin/tsc');
const tempRoot = await mkdtemp(join(tmpdir(), 'copc-tiles-packed-consumer-'));
const packDirectory = join(tempRoot, 'packs');
const consumerDirectory = join(tempRoot, 'renderers');
const candidateConsumerDirectory = join(tempRoot, 'adapter-0.8-candidate');
const coreOnlyDirectory = join(tempRoot, 'core-only');
const engineOnlyDirectory = join(tempRoot, 'engine-only');
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : 'npm';
const npmPrefix = npmCli ? [npmCli] : [];

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runNpm(args, cwd, label) {
  run(npmCommand, [...npmPrefix, ...args], cwd, label);
}

async function makeConsumer(directory, dependencies, fixtures) {
  await mkdir(directory);
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'copc-tiles-packed-consumer',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2));
  for (const fixture of fixtures) {
    await cp(join(root, 'test/packed-consumer', fixture), join(directory, fixture));
  }
  runNpm(['install', '--no-audit', '--no-fund'], directory, `clean consumer install (${directory})`);
}

async function installBytes(directory) {
  let total = 0;
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) total += (await stat(entryPath)).size;
    }
  };
  await visit(join(directory, 'node_modules'));
  return total;
}

async function writeBundleFixture(directory, entryName, entrySource) {
  await writeFile(join(directory, 'index.html'), `<script type="module" src="/${entryName}"></script>`);
  await writeFile(join(directory, entryName), entrySource);
  await writeFile(join(directory, 'vite.config.mjs'), `export default {
  publicDir: false,
  build: { sourcemap: true, outDir: 'bundle-dist' },
};\n`);
}

async function bundleSources(directory) {
  run(process.execPath, [viteCli, 'build', '--config', 'vite.config.mjs'], directory, 'packed consumer Vite bundle');
  const sources = [];
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.js.map')) {
        const sourceMap = JSON.parse(await readFile(entryPath, 'utf8'));
        sources.push(...sourceMap.sources);
      }
    }
  };
  await visit(join(directory, 'bundle-dist'));
  return sources;
}

try {
  await mkdir(packDirectory);
  runNpm(['pack', '--pack-destination', packDirectory], root, 'Tiles npm pack');
  const packedNames = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
  assert.equal(packedNames.length, 1, 'npm pack produced one Tiles tarball');
  const packedTilesName = packedNames[0];
  if (!packedTilesName) throw new Error('Tiles npm pack did not produce a tarball.');
  const packedTiles = `file:${join(packDirectory, packedTilesName)}`;
  const packedTilesPath = join(packDirectory, packedTilesName);
  const packedTilesEntries = spawnSync('tar', ['-tzf', packedTilesPath], { encoding: 'utf8' });
  if (packedTilesEntries.error) throw packedTilesEntries.error;
  assert.equal(packedTilesEntries.status, 0, 'Tiles tarball can be inspected');
  const tileFiles = packedTilesEntries.stdout.trim().split('\n').filter(Boolean);
  for (const required of [
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/adapter/copcCoreAdapter.js',
    'package/dist/resources/index.js',
    'package/dist/tileset/explicitTileset.js',
    'package/dist/tileset/implicitOctreeTileset.js',
  ]) {
    assert.ok(tileFiles.includes(required), `Tiles tarball includes ${required}`);
  }
  for (const excludedPrefix of ['package/src/', 'package/test/', 'package/scripts/', 'package/bench/']) {
    assert.equal(tileFiles.some((file) => file.startsWith(excludedPrefix)), false, `Tiles tarball excludes ${excludedPrefix}`);
  }
  assert.equal(tileFiles.some((file) => file.endsWith('.copc.laz')), false, 'Tiles tarball excludes COPC datasets');
  assert.equal(tileFiles.some((file) => file.includes('/node_modules/')), false, 'Tiles tarball excludes node_modules');

  const adapterWorkspace = resolve(process.env.COPC_ADAPTER_WORKSPACE_ROOT ?? resolve(root, '../adapter'));
  runNpm(['pack', '--pack-destination', packDirectory], adapterWorkspace, 'Adapter 0.8.0 candidate npm pack');
  const packedAdapterName = (await readdir(packDirectory)).find((name) => name.startsWith('frillab-copc-adapter-0.8.0.') && name.endsWith('.tgz'));
  if (!packedAdapterName) throw new Error('Adapter 0.8.0 candidate npm pack did not produce a tarball.');
  const packedAdapter = `file:${join(packDirectory, packedAdapterName)}`;

  await makeConsumer(consumerDirectory, {
    '@frillab/copc-adapter': '0.7.1',
    '@frillab/copc-tiles': packedTiles,
    '@types/three': '0.186.0',
    cesium: '1.146.0',
    three: '0.186.1',
    typescript: '5.9.3',
  }, ['api.ts', 'tsconfig.nodenext.json', 'tsconfig.bundler.json', 'runtime.mjs']);

  const installedAdapterPath = join(consumerDirectory, 'node_modules/@frillab/copc-adapter');
  const installedAdapter = JSON.parse(await readFile(join(installedAdapterPath, 'package.json'), 'utf8'));
  assert.equal(installedAdapter.version, '0.7.1', 'consumer uses the exact Registry Adapter release');
  assert.equal((await lstat(installedAdapterPath)).isSymbolicLink(), false, 'packed Tiles consumer does not resolve the workspace Adapter symlink');
  const consumerLock = JSON.parse(await readFile(join(consumerDirectory, 'package-lock.json'), 'utf8'));
  const adapterLockEntry = consumerLock.packages?.['node_modules/@frillab/copc-adapter'];
  assert.equal(adapterLockEntry?.link, undefined, 'packed consumer lock does not contain a workspace link');
  assert.match(adapterLockEntry?.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//u, 'packed consumer resolves Adapter from the npm Registry');
  const compiler = join(consumerDirectory, 'node_modules/typescript/bin/tsc');
  run(process.execPath, [compiler, '--project', 'tsconfig.nodenext.json'], consumerDirectory, 'strict NodeNext packed consumer typecheck');
  run(process.execPath, [compiler, '--project', 'tsconfig.bundler.json'], consumerDirectory, 'strict Bundler packed consumer typecheck');
  run(process.execPath, ['runtime.mjs'], consumerDirectory, 'packed consumer ESM imports');
  console.log(`Renderer consumer installed file bytes: ${await installBytes(consumerDirectory)}`);
  for (const renderer of ['cesium', 'three']) {
    await writeBundleFixture(
      consumerDirectory,
      `bundle-${renderer}.js`,
      `import * as direct from '@frillab/copc-adapter/${renderer}';\nconsole.log(Object.keys(direct).length);\n`,
    );
    const directSources = await bundleSources(consumerDirectory);
    assert.ok(directSources.some((source) => source.includes('@frillab/copc-adapter') && source.includes(renderer)));
    assert.equal(directSources.some((source) => source.includes('@frillab/copc-tiles')), false, `Adapter /${renderer} bundle has no Tiles modules`);
    console.log(`Adapter /${renderer} consumer bundle has no Tiles source modules.`);
  }

  await makeConsumer(candidateConsumerDirectory, {
    '@frillab/copc-adapter': packedAdapter,
    '@frillab/copc-tiles': packedTiles,
    '@types/three': '0.186.0',
    cesium: '1.146.0',
    three: '0.186.1',
    typescript: '5.9.3',
  }, ['api.ts', 'tsconfig.nodenext.json', 'tsconfig.bundler.json', 'runtime.mjs']);
  const candidateAdapterPath = join(candidateConsumerDirectory, 'node_modules/@frillab/copc-adapter');
  const candidateAdapter = JSON.parse(await readFile(join(candidateAdapterPath, 'package.json'), 'utf8'));
  assert.equal(candidateAdapter.version, '0.8.0', 'second consumer uses the packed Adapter 0.8.0 candidate');
  assert.equal((await lstat(candidateAdapterPath)).isSymbolicLink(), false, 'Adapter 0.8.0 consumer does not resolve a workspace symlink');
  const candidateTiles = JSON.parse(await readFile(join(candidateConsumerDirectory, 'node_modules/@frillab/copc-tiles/package.json'), 'utf8'));
  assert.equal(candidateTiles.peerDependencies?.['@frillab/copc-adapter'], '^0.7.1 || ^0.8.0');
  const candidateCompiler = join(candidateConsumerDirectory, 'node_modules/typescript/bin/tsc');
  run(process.execPath, [candidateCompiler, '--project', 'tsconfig.nodenext.json'], candidateConsumerDirectory, 'Adapter 0.8 candidate strict NodeNext packed consumer typecheck');
  run(process.execPath, [candidateCompiler, '--project', 'tsconfig.bundler.json'], candidateConsumerDirectory, 'Adapter 0.8 candidate strict Bundler packed consumer typecheck');
  run(process.execPath, ['runtime.mjs'], candidateConsumerDirectory, 'Adapter 0.8 candidate packed consumer ESM imports');
  console.log(`Adapter 0.8 candidate consumer installed file bytes: ${await installBytes(candidateConsumerDirectory)}`);

  await makeConsumer(coreOnlyDirectory, {
    '@frillab/copc-adapter': '0.7.1',
    '@frillab/copc-tiles': packedTiles,
  }, ['core-only.mjs']);
  const installedRendererPackages = await Promise.all(['cesium', 'three'].map(async (name) => {
    try {
      await readFile(join(coreOnlyDirectory, 'node_modules', name, 'package.json'));
      return name;
    } catch {
      return undefined;
    }
  }));
  assert.deepEqual(installedRendererPackages.filter(Boolean), [], 'Core-only consumer has no renderer packages installed');
  run(process.execPath, ['core-only.mjs'], coreOnlyDirectory, 'renderer-free Core ESM consumer');
  await writeBundleFixture(
    coreOnlyDirectory,
    'bundle.js',
    "import { CopcContext, createCopcContext } from '@frillab/copc-adapter/core';\nconsole.log(CopcContext.name, typeof createCopcContext);\n",
  );
  const coreSources = await bundleSources(coreOnlyDirectory);
  assert.ok(coreSources.some((source) => source.includes('@frillab/copc-adapter')));
  assert.equal(coreSources.some((source) => source.includes('@frillab/copc-tiles')), false, 'Adapter Core bundle has no Tiles modules');
  assert.equal(coreSources.some((source) => source.includes('/cesium') || source.includes('/three')), false, 'Adapter Core bundle has no renderer subpaths');
  console.log(`Adapter Core consumer installed file bytes: ${await installBytes(coreOnlyDirectory)}`);

  await makeConsumer(engineOnlyDirectory, {
    '@frillab/copc-tiles': packedTiles,
  }, ['engine-only.mjs', 'engine-only.ts', 'tsconfig.engine-only.json']);
  for (const name of ['@frillab/copc-adapter', 'cesium', 'three']) {
    let installed = false;
    try {
      await readFile(join(engineOnlyDirectory, 'node_modules', name, 'package.json'));
      installed = true;
    } catch {}
    assert.equal(installed, false, `Engine-only consumer does not install ${name}`);
  }
  run(process.execPath, ['engine-only.mjs'], engineOnlyDirectory, 'Adapter-free Tiles Engine consumer');
  run(process.execPath, [typescriptCli, '--project', 'tsconfig.engine-only.json'], engineOnlyDirectory, 'Adapter-free strict NodeNext Tiles Engine typecheck');
  await writeBundleFixture(
    engineOnlyDirectory,
    'bundle.js',
    "import { TileNodeReader, encodePointCloudGlb } from '@frillab/copc-tiles';\nconsole.log(TileNodeReader.name, typeof encodePointCloudGlb);\n",
  );
  const engineSources = await bundleSources(engineOnlyDirectory);
  assert.ok(engineSources.some((source) => source.includes('@frillab/copc-tiles')));
  assert.equal(engineSources.some((source) => source.includes('@frillab/copc-adapter')), false, 'Tiles Engine bundle has no Adapter modules');
  assert.equal(engineSources.some((source) => source.includes('/cesium') || source.includes('/three')), false, 'Tiles Engine bundle has no renderer modules');
  console.log(`Tiles Engine consumer installed file bytes: ${await installBytes(engineOnlyDirectory)}`);
  console.log(`Packed Tiles tarball: ${packedTilesName}`);
  console.log(`Packed Adapter candidate tarball: ${packedAdapterName}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function findPackageDirectory(packageName) {
  let directory = dirname(packageRequire.resolve(packageName));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === packageName) return directory;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not locate the installed ${packageName} package from this package or its workspace ancestors.`);
}
