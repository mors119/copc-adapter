import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryDirectory, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? 'no status'}.`));
    });
  });
}

await run('npm', ['run', 'docs:build']);
await run('node', ['scripts/package-playground-adapter.mjs']);
await run('npm', ['--prefix', 'apps/playground', 'run', 'typecheck']);
await run('npm', ['--prefix', 'apps/playground', 'run', 'build']);
await run('node', ['scripts/assemble-pages.mjs']);
