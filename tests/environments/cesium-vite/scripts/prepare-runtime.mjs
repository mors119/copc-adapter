import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const environmentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(environmentDirectory, '../../..');
const adapterDirectory = resolve(repositoryDirectory, 'apps/viewer-web');
const runtimePublicDirectory = resolve(environmentDirectory, 'public');
const packageOutputDirectory = resolve(environmentDirectory, '.package');

function runNpm(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`npm ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function downloadSample(source, destination) {
  const response = await fetch(source);

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download COPC sample: ${response.status} ${response.statusText}`);
  }

  const temporaryDestination = `${destination}.part`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(temporaryDestination, { force: true });

  const output = createWriteStream(temporaryDestination);
  Readable.fromWeb(response.body).pipe(output);

  try {
    await finished(output);
    await rename(temporaryDestination, destination);
  } catch (error) {
    await rm(temporaryDestination, { force: true });
    throw error;
  }
}

async function stageFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });

  try {
    await link(source, destination);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      throw error;
    }
    await copyFile(source, destination);
  }
}

async function prepareSample() {
  const registry = JSON.parse(
    await readFile(resolve(repositoryDirectory, 'samples/datasets.json'), 'utf8'),
  );
  const sample = registry.datasets.find((dataset) => dataset.id === 'autzen');

  if (!sample) {
    throw new Error('The autzen dataset is missing from samples/datasets.json');
  }

  const localSample = resolve(repositoryDirectory, 'samples/local', sample.filename);
  if (!(await exists(localSample))) {
    console.log(`Downloading registered COPC sample to ${localSample}`);
    await downloadSample(sample.url, localSample);
  }

  await stageFile(
    localSample,
    resolve(runtimePublicDirectory, 'samples', sample.filename),
  );
}

console.log('Preparing the local @mors119/copc-cesium package...');
await runNpm(['install', '--ignore-scripts'], adapterDirectory);
await runNpm(['run', 'build:library'], adapterDirectory);
await rm(packageOutputDirectory, { recursive: true, force: true });
await mkdir(packageOutputDirectory, { recursive: true });
await runNpm(['pack', '--pack-destination', packageOutputDirectory], adapterDirectory);

const packageTarball = (await readdir(packageOutputDirectory))
  .find((entry) => entry.endsWith('.tgz'));

if (!packageTarball) {
  throw new Error('npm pack did not produce an adapter tarball');
}

const packagePath = resolve(packageOutputDirectory, packageTarball);
await runNpm(
  ['install', '--ignore-scripts', '--package-lock=false', '--no-save', packagePath],
  environmentDirectory,
);

const installedPackageDirectory = resolve(
  environmentDirectory,
  'node_modules/@mors119/copc-cesium',
);

if (!(await exists(resolve(installedPackageDirectory, 'dist/index.js')))) {
  throw new Error('The packed adapter was not installed into the consumer');
}

if (!(await exists(resolve(installedPackageDirectory, 'dist/wasm/copc_wasm.wasm')))) {
  throw new Error('The packed adapter is missing its COPC WASM asset');
}

await prepareSample();

console.log('COPC manual-test runtime is ready.');
