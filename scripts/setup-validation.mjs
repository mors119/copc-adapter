import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryDirectory,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function requireRustup() {
  const rustupVersion = commandOutput('rustup', ['--version']);
  const rustcVersion = commandOutput('rustc', ['--version']);
  const cargoVersion = commandOutput('cargo', ['--version']);
  if (!rustupVersion || !rustcVersion || !cargoVersion) {
    throw new Error(
      'Rust and rustup are required for the viewer WASM build. Install rustup from https://rustup.rs/, then rerun npm run setup.',
    );
  }

  const installedTargets = commandOutput('rustup', ['target', 'list', '--installed']);
  if (!installedTargets) {
    throw new Error('Could not read installed Rust targets with rustup. Check the rustup installation.');
  }
  if (!installedTargets.split(/\r?\n/).includes('wasm32-unknown-unknown')) {
    console.log('Adding the wasm32-unknown-unknown target to the installed Rust toolchain.');
    run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  }
  console.log(`Using ${rustcVersion}; ${cargoVersion}; ${rustupVersion}.`);
}

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  throw new Error(
    `Node.js 22 or newer is required (found ${process.versions.node}). Use nvm install 22 && nvm use 22, then rerun npm run setup.`,
  );
}

try {
  console.log(`Using Node.js ${process.versions.node}. CI uses Node 22; see .nvmrc.`);
  requireRustup();
  run('npm', ['ci']);
  run('npm', ['ci', '--prefix', 'apps/viewer-web']);
  run('npm', ['--prefix', 'apps/viewer-web', 'run', 'prepare-copc-wasm']);
  run('npm', ['run', 'download-samples', '--', 'autzen']);
  run(process.execPath, [
    path.join(repositoryDirectory, 'apps/viewer-web/node_modules/playwright/cli.js'),
    'install',
    'chromium',
  ]);
  console.log('Validation setup is ready. Start the viewer with npm run dev.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
