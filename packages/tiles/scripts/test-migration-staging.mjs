import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packagePrefix = `${packageRoot.slice(repositoryRoot.length + 1)}${sep}`;
const stagingRoot = await mkdtemp(join(tmpdir(), 'copc-tiles-workspace-staging-'));
const stagedPackageRoot = join(stagingRoot, 'packages', 'tiles');
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : 'npm';
const npmPrefix = npmCli ? [npmCli] : [];

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      SHARP_IGNORE_GLOBAL_LIBVIPS: process.env.SHARP_IGNORE_GLOBAL_LIBVIPS ?? '1',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runNpm(args, cwd, label) {
  run(npmCommand, [...npmPrefix, ...args], cwd, label);
}

try {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`git ls-files failed with exit code ${listed.status}.`);
  const trackedFiles = listed.stdout
    .split('\0')
    .filter((file) => file.startsWith(packagePrefix))
    .map((file) => file.slice(packagePrefix.length));
  assert.ok(trackedFiles.includes('package.json'), 'tracked package manifest is present');
  assert.ok(trackedFiles.includes('scripts/test-migration-staging.mjs'), 'staging script is tracked before staging');

  for (const file of trackedFiles) {
    const source = resolve(packageRoot, file);
    const destination = resolve(stagedPackageRoot, file);
    assert.ok(destination === stagedPackageRoot || destination.startsWith(`${stagedPackageRoot}${sep}`), `tracked path stays inside staged package: ${file}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  const manifest = JSON.parse(await readFile(join(stagedPackageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@frillab/copc-tiles');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.peerDependencies?.['@frillab/copc-adapter'], '0.7.1');
  assert.equal(manifest.peerDependenciesMeta?.['@frillab/copc-adapter']?.optional, true);
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      assert.equal(typeof version, 'string');
      assert.equal(version.startsWith('workspace:'), false, `${section}.${name} is not workspace-only metadata`);
    }
  }

  await writeFile(join(stagingRoot, 'package.json'), `${JSON.stringify({
    name: 'copc-tiles-migration-staging',
    version: '1.0.0',
    private: true,
    workspaces: ['packages/tiles'],
    allowScripts: {
      'better-sqlite3@11.10.0': true,
      'esbuild@0.28.2': true,
      'fsevents@2.3.3': true,
      'sharp@0.32.6': true,
    },
  }, null, 2)}\n`);

  console.log(`Staged ${trackedFiles.length} tracked package files under packages/tiles with Node ${process.version}.`);
  runNpm(['install', '--no-audit', '--no-fund'], stagingRoot, 'clean npm Workspace install');

  const checks = [
    'typecheck',
    'typecheck:adapter-core',
    'build',
    'test',
  ];
  if (Number(process.versions.node.split('.')[0]) < 20) {
    console.log('Node 18 run: explicitly skipping browser and packed-bundle checks because pinned Vite 7 requires Node 20+. Run npm run verify on Node 22 for those gates.');
    checks.push('bench:engine');
  } else {
    checks.push('test:browser', 'test:packed-consumer', 'bench:engine');
  }

  for (const script of checks) {
    runNpm(['run', `--workspace=${manifest.name}`, script], stagingRoot, `staged ${script}`);
  }

  const stagedLock = JSON.parse(await readFile(join(stagingRoot, 'package-lock.json'), 'utf8'));
  assert.equal(stagedLock.packages?.['packages/tiles']?.name, '@frillab/copc-tiles');
  assert.equal(stagedLock.packages?.['packages/tiles']?.version, '0.1.0');
  assert.equal(stagedLock.packages?.['packages/tiles']?.peerDependencies?.['@frillab/copc-adapter'], '0.7.1');
  console.log('Staged npm Workspace package checks and external packed consumers passed.');
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
