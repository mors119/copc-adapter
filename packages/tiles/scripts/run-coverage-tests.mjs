import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coverageDirectory = join(packageDirectory, 'coverage');
const rawPath = join(coverageDirectory, 'lcov.raw.info');
const reportPath = join(coverageDirectory, 'lcov.info');

export function normalizeTilesLcov(report, sourceRoot) {
  const records = [];
  for (const candidate of report.split(/end_of_record\s*(?:\r?\n|$)/)) {
    const record = candidate.trim();
    const originalSource = record.match(/^SF:(.+)$/m)?.[1]?.trim();
    if (!originalSource) continue;

    const sourcePath = originalSource.startsWith('file://')
      ? fileURLToPath(originalSource)
      : originalSource;
    const path = relative(sourceRoot, resolve(sourceRoot, sourcePath)).split(sep).join('/');
    if (path.startsWith('../') || path === '..' || isAbsolute(path)) continue;
    if (!path.startsWith('src/') || !/\.(?:[cm]?js|tsx?)$/.test(path)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) continue;
    records.push(record.replace(/^SF:.*$/m, 'SF:packages/tiles/' + path) + '\nend_of_record');
  }
  if (!records.length) throw new Error('No Tiles source records found in LCOV output.');
  return records.join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = readdirSync(join(packageDirectory, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => 'test/' + name);
  if (!files.length) throw new Error('No Tiles unit test files found.');

  mkdirSync(coverageDirectory, { recursive: true });
  rmSync(rawPath, { force: true });
  rmSync(reportPath, { force: true });
  const args = [
    '--import', 'tsx', '--test', '--experimental-test-coverage',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=lcov', '--test-reporter-destination=' + rawPath,
    ...files,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: packageDirectory,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const report = normalizeTilesLcov(readFileSync(rawPath, 'utf8'), packageDirectory);
  writeFileSync(reportPath, report);
  console.log('Tiles LCOV ready: ' + reportPath);
}
