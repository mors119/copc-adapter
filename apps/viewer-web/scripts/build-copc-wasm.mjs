import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
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
const libraryWasmPath = path.resolve(appDirectory, 'src/wasm/copc_wasm.wasm');

function runCargoBuild() {
  return new Promise((resolve, reject) => {
    const homeDirectory = path.resolve(os.homedir());
    const rustFlags = [
      process.env.RUSTFLAGS,
      `--remap-path-prefix=${homeDirectory}=.`,
    ].filter(Boolean).join(' ');
    const child = spawn(
      'cargo',
      ['build', '-p', 'copc-wasm', '--target', 'wasm32-unknown-unknown', '--release'],
      {
        cwd: workspaceDirectory,
        env: { ...process.env, RUSTFLAGS: rustFlags },
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

function readUnsignedLeb128(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * 2 ** shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
    shift += 7;
    if (shift > 35) {
      throw new Error('Invalid WebAssembly unsigned LEB128 value');
    }
  }
  throw new Error('Truncated WebAssembly unsigned LEB128 value');
}

/** Remove compiler-only function/source names from the shipped WASM asset. */
function stripWasmNameSection(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
      bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('Invalid WebAssembly module');
  }

  const sections = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset < bytes.length) {
    const sectionStart = offset;
    const sectionId = bytes[offset];
    offset += 1;
    const payload = readUnsignedLeb128(bytes, offset);
    offset = payload.offset;
    const sectionEnd = offset + payload.value;
    if (sectionEnd > bytes.length) {
      throw new Error('Truncated WebAssembly section');
    }

    let isNameSection = false;
    if (sectionId === 0) {
      const nameLength = readUnsignedLeb128(bytes, offset);
      const nameEnd = nameLength.offset + nameLength.value;
      isNameSection = nameEnd <= sectionEnd &&
        new TextDecoder().decode(bytes.subarray(nameLength.offset, nameEnd)) === 'name';
    }
    if (!isNameSection) {
      sections.push(bytes.subarray(sectionStart, sectionEnd));
    }
    offset = sectionEnd;
  }

  return Buffer.concat(sections.map((section) => Buffer.from(section)));
}

await runCargoBuild();
const wasmBytes = await readFile(wasmOutputPath);
await writeFile(wasmOutputPath, stripWasmNameSection(wasmBytes));
await mkdir(publicWasmDirectory, { recursive: true });
await Promise.all([
  copyFile(wasmOutputPath, publicWasmPath),
  copyFile(wasmOutputPath, libraryWasmPath),
]);
