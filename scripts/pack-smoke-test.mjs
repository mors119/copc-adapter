import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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
    'package/README.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/wasm/copc_wasm.wasm',
    'package/dist/laz-perf.wasm',
  ]) {
    assertIncluded(entries, requiredEntry);
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

  if ([...entries].some((entry) => /\.copc\.laz$/i.test(entry))) {
    throw new Error('Packed adapter contains a COPC sample dataset');
  }

  console.log(`Pack contents passed: ${path.basename(packagePath)}`);

  await cp(consumerTemplateDirectory, consumerDirectory, { recursive: true });
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
  if (!installedEntries.includes('index.js')) {
    throw new Error('Clean consumer did not install the packed package by name');
  }

  console.log('Building the clean consumer production bundle...');
  await run(npmCommand(), ['run', 'build'], {
    cwd: consumerDirectory,
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
    await run(npmCommand(), ['exec', '--', 'playwright', 'install', 'chromium'], {
      cwd: consumerDirectory,
      stdio: 'inherit',
    });
  }
  await run(npmCommand(), ['run', 'test:e2e'], {
    cwd: consumerDirectory,
    stdio: 'inherit',
  });

  console.log(`Packed consumer validation passed: ${path.basename(packagePath)}`);
} finally {
  await rm(packageOutputDirectory, { recursive: true, force: true });
  await rm(consumerDirectory, { recursive: true, force: true });
}
