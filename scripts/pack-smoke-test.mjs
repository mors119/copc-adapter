import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '..');
const packageDirectory = path.resolve(repositoryDirectory, 'apps/viewer-web');
const packageOutputDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'copc-adapter-pack-'),
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
  console.log('Building the library package...');
  await run(npmCommand(), ['run', 'build:library'], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });

  const packResult = await run(
    npmCommand(),
    ['pack', '--pack-destination', packageOutputDirectory, '--json'],
    { cwd: packageDirectory },
  );
  const packMetadata = JSON.parse(packResult.stdout);
  const packedFilename =
    packMetadata[0]?.filename ??
    (await readdir(packageOutputDirectory)).find((entry) => entry.endsWith('.tgz'));

  if (!packedFilename) {
    throw new Error('npm pack did not produce an adapter tarball');
  }
  const packagePath = path.resolve(packageOutputDirectory, packedFilename);

  const tarResult = await run('tar', ['-tzf', packagePath]);
  const entries = new Set(tarResult.stdout.trim().split('\n').filter(Boolean));

  for (const requiredEntry of [
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/wasm/copc_wasm.wasm',
    'package/dist/laz-perf.wasm',
  ]) {
    assertIncluded(entries, requiredEntry);
  }

  for (const forbiddenPrefix of ['package/target/', 'package/test/', 'package/samples/']) {
    if ([...entries].some((entry) => entry.startsWith(forbiddenPrefix))) {
      throw new Error(`Packed adapter contains an unintended path: ${forbiddenPrefix}`);
    }
  }

  console.log(`Pack smoke test passed: ${path.basename(packagePath)}`);
} finally {
  await rm(packageOutputDirectory, { recursive: true, force: true });
}
