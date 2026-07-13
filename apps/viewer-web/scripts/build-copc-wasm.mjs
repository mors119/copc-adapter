import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, '..');
const workspaceDirectory = path.resolve(appDirectory, '..', '..');
const wasmOutputPath = path.resolve(
  workspaceDirectory,
  'target/wasm32-unknown-unknown/release/copc_wasm.wasm',
);
const publicWasmDirectory = path.resolve(appDirectory, 'public/wasm');
const publicWasmPath = path.resolve(publicWasmDirectory, 'copc_wasm.wasm');

function runCargoBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cargo',
      ['build', '-p', 'copc-wasm', '--target', 'wasm32-unknown-unknown', '--release'],
      {
        cwd: workspaceDirectory,
        stdio: 'inherit',
      },
    );

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`cargo build failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

await runCargoBuild();
await mkdir(publicWasmDirectory, { recursive: true });
await copyFile(wasmOutputPath, publicWasmPath);
