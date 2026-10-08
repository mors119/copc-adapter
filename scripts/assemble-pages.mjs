import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagesDirectory = path.join(repositoryDirectory, '.ci-artifacts/pages-dist');
const docsDirectory = path.join(repositoryDirectory, 'docs/.vitepress/dist');
const playgroundDirectory = path.join(repositoryDirectory, 'apps/playground/dist');

await rm(pagesDirectory, { recursive: true, force: true });
await mkdir(pagesDirectory, { recursive: true });
await cp(docsDirectory, pagesDirectory, { recursive: true });
await cp(playgroundDirectory, path.join(pagesDirectory, 'playground'), { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn('node', ['scripts/assert-pages-layout.mjs', pagesDirectory], {
    cwd: repositoryDirectory,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Pages artifact validation exited with ${code ?? 'no status'}.`));
  });
});

console.log(`Complete GitHub Pages artifact assembled at ${path.relative(repositoryDirectory, pagesDirectory)}.`);
