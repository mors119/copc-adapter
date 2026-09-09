import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
  'tests/environments/cesium-vite',
);
const packageOutputDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'copc-adapter-pack-'),
);
const consumerDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'copc-adapter-packed-consumer-'),
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

try {
  let packagePath;
  if (process.argv[2]) {
    packagePath = path.resolve(process.argv[2]);
    if (!existsSync(packagePath)) {
      throw new Error(`Supplied adapter tarball does not exist: ${packagePath}`);
    }
    console.log(`Using supplied adapter tarball: ${path.basename(packagePath)}`);
  } else {
    console.log('Building Rust/WASM and the library package...');
    await run(npmCommand(), ['run', 'build:library'], {
      cwd: packageDirectory,
      stdio: 'inherit',
    });

    console.log('Packing the freshly built library package...');
    await run(
      npmCommand(),
      ['pack', '--ignore-scripts', '--pack-destination', packageOutputDirectory],
      { cwd: packageDirectory },
    );
    const packedFilenames = (await readdir(packageOutputDirectory)).filter((entry) =>
      entry.endsWith('.tgz'),
    );

    if (packedFilenames.length !== 1) {
      throw new Error(
        `Expected npm pack to produce one adapter tarball, found ${packedFilenames.length}`,
      );
    }
    packagePath = path.resolve(packageOutputDirectory, packedFilenames[0]);
  }

  const tarResult = await run('tar', ['-tzf', packagePath]);
  const entries = new Set(tarResult.stdout.trim().split('\n').filter(Boolean));

  for (const requiredEntry of [
    'package/README.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cesium.js',
    'package/dist/cesium.d.ts',
    'package/dist/copc_wasm.wasm',
    'package/dist/laz-perf.wasm',
    'package/dist/copcWasmAsset.js',
    'package/dist/lazPerfAsset.js',
  ]) {
    assertIncluded(entries, requiredEntry);
  }
  if ([...entries].some((entry) => entry.startsWith('package/dist/assets/rustCopcDecodeWorker-'))) {
    throw new Error('Packed adapter contains the retired external Rust decode worker chunk');
  }
  if (!entries.has('package/dist/copcWasmAsset.js')) {
    throw new Error('Packed adapter is missing the main-thread Rust WASM asset module');
  }
  if (entries.has('package/dist/wasm/copc_wasm.wasm')) {
    throw new Error('Packed adapter contains the retired duplicate dist/wasm asset');
  }

  for (const forbiddenPrefix of [
    'package/target/',
    'package/test/',
    'package/samples/',
    'package/dist/samples/',
    'package/public/',
    'package/node_modules/',
    'package/.git/',
    'package/src/',
  ]) {
    if ([...entries].some((entry) => entry.startsWith(forbiddenPrefix))) {
      throw new Error(`Packed adapter contains an unintended path: ${forbiddenPrefix}`);
    }
  }

  for (const entry of entries) {
    if (
      entry !== 'package/README.md'
      && entry !== 'package/LICENSE'
      && entry !== 'package/package.json'
      && !entry.startsWith('package/dist/')
    ) {
      throw new Error(`Packed adapter contains an unrelated path: ${entry}`);
    }
  }

  const wasmEntries = [...entries].filter((entry) => entry.endsWith('.wasm'));
  const expectedWasmEntries = new Set([
    'package/dist/copc_wasm.wasm',
    'package/dist/laz-perf.wasm',
  ]);
  if (wasmEntries.length !== expectedWasmEntries.size
    || wasmEntries.some((entry) => !expectedWasmEntries.has(entry))) {
    throw new Error(`Packed adapter has an unexpected WASM asset graph: ${wasmEntries.join(', ')}`);
  }

  if ([...entries].some((entry) => /\.copc\.laz$/i.test(entry))) {
    throw new Error('Packed adapter contains a COPC sample dataset');
  }

  console.log(`Pack contents passed: ${path.basename(packagePath)}`);

  await cp(consumerTemplateDirectory, consumerDirectory, { recursive: true });
  const consumerViteConfig = await readFile(
    path.resolve(consumerDirectory, 'vite.config.js'),
    'utf8',
  );
  if (/optimizeDeps|exclude\s*:/u.test(consumerViteConfig)) {
    throw new Error('Packed consumer must exercise default Vite dependency optimization');
  }
  await mkdir(path.resolve(consumerDirectory, 'public/samples'), { recursive: true });
  await cp(
    path.resolve(repositoryDirectory, 'samples/local/autzen.copc.laz'),
    path.resolve(consumerDirectory, 'public/samples/autzen.copc.laz'),
  );

  console.log('Installing the generated tarball in a clean external consumer...');
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
  const installedEntries = await readdir(path.resolve(installedPackageDirectory, 'dist'));
  for (const requiredEntry of [
    'index.js',
    'index.d.ts',
    'cesium.js',
    'cesium.d.ts',
    'three.js',
    'three.d.ts',
  ]) {
    if (!installedEntries.includes(requiredEntry)) {
      throw new Error(`Clean consumer did not install dist/${requiredEntry}`);
    }
  }

  const installedPackage = JSON.parse(
    await readFile(path.resolve(installedPackageDirectory, 'package.json'), 'utf8'),
  );
  for (const exportPath of ['.', './cesium', './three']) {
    if (!installedPackage.exports?.[exportPath]) {
      throw new Error(`Clean consumer package is missing the ${exportPath} export`);
    }
  }
  if (!installedPackage.peerDependenciesMeta?.cesium?.optional) {
    throw new Error('Cesium peer must be optional at the combined package boundary');
  }
  if (!installedPackage.peerDependenciesMeta?.three?.optional) {
    throw new Error('Three.js peer must be optional at the combined package boundary');
  }
  if (!installedPackage.keywords?.includes('cesiumjs')
    || !installedPackage.keywords?.includes('threejs')) {
    throw new Error('Packed metadata must name both CesiumJS and Three.js');
  }

  const cesiumDeclaration = await readFile(
    path.resolve(installedPackageDirectory, 'dist/cesium.d.ts'),
    'utf8',
  );
  if (/(?:from|import)\s+['"][^'"]*three/u.test(cesiumDeclaration)) {
    throw new Error('Cesium declarations contain a Three.js module reference');
  }
  const threeDeclaration = await readFile(
    path.resolve(installedPackageDirectory, 'dist/three.d.ts'),
    'utf8',
  );
  if (/(?:from|import)\s+['"][^'"]*cesium/u.test(threeDeclaration)) {
    throw new Error('Three declarations contain a Cesium module reference');
  }
  const cesiumEntrySource = await readFile(
    path.resolve(installedPackageDirectory, 'dist/cesium.js'),
    'utf8',
  );
  if (/three/iu.test(cesiumEntrySource)) {
    throw new Error('Cesium entry contains a Three.js module reference');
  }
  if (existsSync(path.resolve(consumerDirectory, 'node_modules/three'))) {
    throw new Error('Cesium-only consumer unexpectedly installed Three.js');
  }

  console.log('Building the clean root Cesium consumer production bundle...');
  await run(npmCommand(), ['run', 'build'], {
    cwd: consumerDirectory,
    env: { CONSUMER_ENTRY: 'root' },
    stdio: 'inherit',
  });
  const consumerAssetEntries = await readdir(path.resolve(consumerDirectory, 'dist/assets'));
  if (!consumerAssetEntries.some((entry) => entry.startsWith('copc_wasm-') && entry.endsWith('.wasm'))) {
    throw new Error('Consumer production build did not emit the Rust WASM asset');
  }
  if (!consumerAssetEntries.some((entry) => entry.startsWith('laz-perf-') && entry.endsWith('.wasm'))) {
    throw new Error('Consumer production build did not emit the LAZ runtime asset');
  }

  console.log('Serving the production bundle and running Chromium E2E...');
  const systemChromium = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined;
  if (!systemChromium || !existsSync(systemChromium)) {
    const playwrightCommand = path.resolve(
      consumerDirectory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
    );
    await run(playwrightCommand, ['install', 'chromium'], {
      cwd: consumerDirectory,
      stdio: 'inherit',
    });
  }
  await run(npmCommand(), ['run', 'test:e2e'], {
    cwd: consumerDirectory,
    env: {
      CONSUMER_ENTRY: 'root',
      CONSUMER_MODE: 'production',
      CONSUMER_PORT: '4174',
    },
    stdio: 'inherit',
  });

  console.log('Building and serving the explicit Cesium consumer entrypoint...');
  await run(npmCommand(), ['run', 'build'], {
    cwd: consumerDirectory,
    env: { CONSUMER_ENTRY: 'cesium' },
    stdio: 'inherit',
  });
  const explicitConsumerAssetEntries = await readdir(
    path.resolve(consumerDirectory, 'dist/assets'),
  );
  if (!explicitConsumerAssetEntries.some((entry) => entry.startsWith('copc_wasm-') && entry.endsWith('.wasm'))) {
    throw new Error('Explicit Cesium consumer build did not emit the Rust WASM asset');
  }
  if (!explicitConsumerAssetEntries.some((entry) => entry.startsWith('laz-perf-') && entry.endsWith('.wasm'))) {
    throw new Error('Explicit Cesium consumer build did not emit the LAZ runtime asset');
  }
  await run(npmCommand(), ['run', 'test:e2e'], {
    cwd: consumerDirectory,
    env: {
      CONSUMER_ENTRY: 'cesium',
      CONSUMER_MODE: 'production',
      CONSUMER_PORT: '4176',
    },
    stdio: 'inherit',
  });

  console.log('Serving the development bundle with Vite dependency optimization and running Chromium E2E...');
  await run(npmCommand(), ['run', 'test:e2e'], {
    cwd: consumerDirectory,
    env: {
      CONSUMER_ENTRY: 'root',
      CONSUMER_MODE: 'dev',
      CONSUMER_PORT: '4175',
    },
    stdio: 'inherit',
  });

  console.log(`Packed consumer validation passed: ${path.basename(packagePath)}`);
} finally {
  await rm(packageOutputDirectory, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
}
