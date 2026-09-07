import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '..');
const packageDirectory = path.resolve(repositoryDirectory, 'apps/viewer-web');
const consumerTemplateDirectory = path.resolve(
  repositoryDirectory,
  'tests/environments/three-vite',
);
const packageOutputDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'copc-adapter-three-pack-'),
);
const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'copc-adapter-three-consumer-'),
);

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: { ...process.env, ...options.env },
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})\n${stderr}`,
        ),
      );
    });
  });
}

function assertIncluded(entries, entry) {
  if (!entries.has(entry)) {
    throw new Error(`Packed adapter is missing ${entry}`);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

try {
  console.log('Building the library package with the Three entrypoint...');
  await run(npmCommand(), ['run', 'build:library'], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });

  console.log('Packing the Three-enabled library artifact...');
  await run(
    npmCommand(),
    ['pack', '--ignore-scripts', '--pack-destination', packageOutputDirectory],
    { cwd: packageDirectory },
  );
  const packedFilename = (await readdir(packageOutputDirectory)).find((entry) =>
    entry.endsWith('.tgz'),
  );
  if (!packedFilename) {
    throw new Error('npm pack did not produce an adapter tarball');
  }
  const packagePath = path.resolve(packageOutputDirectory, packedFilename);

  const tarResult = await run('tar', ['-tzf', packagePath]);
  const entries = new Set(tarResult.stdout.trim().split('\n').filter(Boolean));
  for (const requiredEntry of [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cesium.js',
    'package/dist/cesium.d.ts',
    'package/dist/three.js',
    'package/dist/three.d.ts',
    'package/dist/copc_wasm.wasm',
    'package/dist/laz-perf.wasm',
    'package/dist/copcWasmAsset.js',
    'package/dist/lazPerfAsset.js',
    'package/dist/rustCopcWorkerFactory.js',
  ]) {
    assertIncluded(entries, requiredEntry);
  }
  if ([...entries].some((entry) => entry.startsWith('package/dist/assets/'))) {
    throw new Error('Packed adapter contains an external Rust decode worker chunk');
  }
  if ([...entries].some((entry) => /\.copc\.laz$/iu.test(entry))) {
    throw new Error('Packed adapter contains a COPC sample dataset');
  }

  await cp(consumerTemplateDirectory, consumerDirectory, { recursive: true });
  console.log('Installing the packed artifact in a clean Three.js consumer...');
  await run(npmCommand(), ['install', '--no-audit', '--no-fund'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  await run(
    npmCommand(),
    ['install', '--no-save', '--no-audit', '--no-fund', packagePath],
    { cwd: consumerDirectory, stdio: 'inherit' },
  );

  const installedPackageDirectory = path.resolve(
    consumerDirectory,
    'node_modules/@frillab/copc-adapter',
  );
  const installedPackage = JSON.parse(
    await readFile(path.resolve(installedPackageDirectory, 'package.json'), 'utf8'),
  );
  if (!installedPackage.exports?.['.']) {
    throw new Error('Clean consumer package is missing the root export');
  }
  if (!installedPackage.exports?.['./cesium']) {
    throw new Error('Clean consumer package is missing the ./cesium export');
  }
  if (!installedPackage.exports?.['./three']) {
    throw new Error('Clean consumer package is missing the ./three export');
  }
  if (!installedPackage.peerDependenciesMeta?.cesium?.optional) {
    throw new Error('Cesium peer must be optional for the subpath package boundary');
  }
  if (!installedPackage.peerDependenciesMeta?.three?.optional) {
    throw new Error('Three.js peer must be optional at the combined package boundary');
  }
  if (existsSync(path.resolve(consumerDirectory, 'node_modules/cesium'))) {
    throw new Error('Three-only consumer unexpectedly installed Cesium');
  }

  console.log('Building the clean Three.js/Vite consumer...');
  await run(npmCommand(), ['run', 'build'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });
  const consumerAssetEntries = await readdir(path.resolve(consumerDirectory, 'dist/assets'));
  if (!consumerAssetEntries.some((entry) => entry.startsWith('copc_wasm-') && entry.endsWith('.wasm'))) {
    throw new Error('Three consumer production build did not emit the Rust WASM asset');
  }
  if (!consumerAssetEntries.some((entry) => entry.startsWith('laz-perf-') && entry.endsWith('.wasm'))) {
    throw new Error('Three consumer production build did not emit the LAZ runtime asset');
  }

  const consumerJavaScript = await Promise.all(
    (await listFiles(path.resolve(consumerDirectory, 'dist')))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFile(file, 'utf8')),
  );
  if (consumerJavaScript.some((source) => /cesium/iu.test(source))) {
    throw new Error('Three consumer bundle contains a Cesium module reference');
  }
  console.log(`Packed Three consumer validation passed: ${path.basename(packagePath)}`);
} finally {
  await rm(packageOutputDirectory, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
}
