import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryDirectory,
    stdio: 'inherit',
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
  if (result.error || result.status !== 0) {
    throw new Error(`Could not run ${command} ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

async function main() {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  }

  console.log(`Using Node.js ${process.versions.node}.`);
  const installedTargets = commandOutput('rustup', ['target', 'list', '--installed']);
  if (!installedTargets.split(/\r?\n/).includes('wasm32-unknown-unknown')) {
    run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  }

  run('npm', ['ci']);
  run('npm', ['ci', '--prefix', 'packages/copc-adapter']);
  run('npm', ['ci', '--prefix', 'apps/dev-viewer']);
  run('npm', ['--prefix', 'apps/dev-viewer', 'run', 'prepare-assets']);
  run('npm', ['run', 'download-samples', '--', 'autzen']);
  run(process.execPath, [
    path.join(repositoryDirectory, 'apps/dev-viewer/node_modules/playwright/cli.js'),
    'install',
    'chromium',
  ]);
  console.log('Validation setup is ready. Start the viewer with npm run dev.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
