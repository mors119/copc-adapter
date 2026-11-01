import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const packagePrefix = `${packageRoot.slice(repositoryRoot.length + 1)}${sep}`;

if (process.argv.includes('--preflight')) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`git ls-files failed with exit code ${listed.status}.`);
  const trackedFiles = listed.stdout.split('\0');
  assert.ok(trackedFiles.includes(`${packagePrefix}package.json`), 'tracked Tiles package manifest is present');
  assert.ok(
    trackedFiles.includes(`${packagePrefix}scripts/test-migration-staging.mjs`),
    'tracked staging script is present',
  );

  const repositoryLock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
  for (const workspace of ['packages/adapter', 'packages/tiles']) {
    const actual = JSON.parse(await readFile(join(repositoryRoot, workspace, 'package.json'), 'utf8'));
    const locked = repositoryLock.packages?.[workspace];
    assert.equal(locked?.name, actual.name, `${workspace} name matches root lockfile`);
    assert.equal(locked?.version, actual.version, `${workspace} version matches root lockfile`);
  }

  const tilesManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lockedTiles = repositoryLock.packages?.['packages/tiles'];
  assert.deepEqual(lockedTiles?.peerDependencies, tilesManifest.peerDependencies, 'Tiles peer dependencies match the root lockfile');
  assert.deepEqual(
    lockedTiles?.peerDependenciesMeta,
    tilesManifest.peerDependenciesMeta,
    'Tiles peer dependency metadata matches the root lockfile',
  );
  console.log('Fast workspace manifest/lockfile preflight passed; dependency installation and browser tests are deferred.');
  process.exit(0);
}

const semver = (await import('semver')).default;
const adapterArtifactDirectory = join(repositoryRoot, 'ci-artifacts');
const adapterArtifacts = await readdir(adapterArtifactDirectory).catch((error) => {
  if (error?.code === 'ENOENT') return [];
  throw error;
});
const adapterCandidates = adapterArtifacts.filter((file) =>
  file.startsWith('frillab-copc-adapter-0.8.0.') && file.endsWith('.tgz'));
assert.ok(adapterCandidates.length <= 1, 'at most one verified Adapter 0.8.0 package candidate is staged');
const adapterCandidatePath = adapterCandidates[0] === undefined
  ? undefined
  : resolve(adapterArtifactDirectory, adapterCandidates[0]);
const stagingRoot = await mkdtemp(join(tmpdir(), 'copc-tiles-workspace-staging-'));
const stagedPackageRoot = join(stagingRoot, 'packages', 'tiles');
const preflightOnly = process.argv.includes('--preflight');
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : 'npm';
const npmPrefix = npmCli ? [npmCli] : [];

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(adapterCandidatePath === undefined
        ? { COPC_ADAPTER_WORKSPACE_ROOT: resolve(repositoryRoot, 'packages/adapter') }
        : { COPC_ADAPTER_PACKED_CANDIDATE: adapterCandidatePath }),
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
  assertAdapterPeerRange(manifest.peerDependencies?.['@frillab/copc-adapter'], 'staged package manifest');
  assert.equal(manifest.peerDependenciesMeta?.['@frillab/copc-adapter']?.optional, true);
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      assert.equal(typeof version, 'string');
      assert.equal(version.startsWith('workspace:'), false, `${section}.${name} is not workspace-only metadata`);
    }
  }

  // Reuse the very same manifest assertions before installing npm packages.
  // This avoids discovering stale peer/version expectations after expensive browser jobs.
  const repositoryLock = JSON.parse(await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'));
  for (const workspace of ['packages/adapter', 'packages/tiles']) {
    const actual = JSON.parse(await readFile(join(repositoryRoot, workspace, 'package.json'), 'utf8'));
    const locked = repositoryLock.packages?.[workspace];
    assert.equal(locked?.name, actual.name, `${workspace} name matches root lockfile`);
    assert.equal(locked?.version, actual.version, `${workspace} version matches root lockfile`);
  }
  assert.deepEqual(
    repositoryLock.packages?.['packages/tiles']?.peerDependencies,
    manifest.peerDependencies,
    'Tiles peer dependencies match the root lockfile',
  );

  if (preflightOnly) {
    console.log('Fast workspace manifest/lockfile preflight passed; expensive installs and browser tests skipped.');
  } else {
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
  assertAdapterPeerRange(
    stagedLock.packages?.['packages/tiles']?.peerDependencies?.['@frillab/copc-adapter'],
    'staged package lockfile',
  );
  console.log('Staged npm Workspace package checks and external packed consumers passed.');
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function assertAdapterPeerRange(range, source) {
  assert.equal(typeof range, 'string', `${source} declares the optional Adapter peer range`);
  assert.notEqual(semver.validRange(range), null, `${source} declares a valid semver range`);
  for (const version of ['0.7.1', '0.7.99', '0.8.0', '0.8.99']) {
    assert.equal(semver.satisfies(version, range), true, `${source} accepts Adapter ${version}`);
  }
  for (const version of ['0.7.0', '0.9.0', '1.0.0', '0.8.0-next.1']) {
    assert.equal(semver.satisfies(version, range), false, `${source} rejects Adapter ${version}`);
  }
}
