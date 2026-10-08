import { access, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateDirectory = path.join(repositoryDirectory, '.ci-artifacts/playground-package');
const playgroundDirectory = path.join(repositoryDirectory, 'apps/playground');

function run(command, args, cwd = repositoryDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'no status'}.`));
    });
  });
}

await access(path.join(playgroundDirectory, 'node_modules'));
await rm(candidateDirectory, { recursive: true, force: true });
await mkdir(candidateDirectory, { recursive: true });

await run('npm', ['--prefix', 'apps/viewer-web', 'run', 'prepare-copc-wasm']);
await run('npm', ['--prefix', 'apps/viewer-web', 'run', 'build:library:ci']);
await run('npm', [
  'pack', './apps/viewer-web', '--ignore-scripts', '--pack-destination', candidateDirectory,
]);

const candidates = (await readdir(candidateDirectory)).filter((filename) => filename.endsWith('.tgz'));
if (candidates.length !== 1) {
  throw new Error(`Expected one packed adapter candidate, found ${candidates.length}.`);
}

await run('npm', [
  'install', '--no-save', '--ignore-scripts', '--package-lock=false',
  path.join(candidateDirectory, candidates[0]),
], playgroundDirectory);

console.log(`Installed packed adapter candidate into ${path.relative(repositoryDirectory, playgroundDirectory)}.`);
