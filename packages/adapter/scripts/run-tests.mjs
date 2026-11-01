import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const testDirectory = path.join(packageDirectory, 'test');
const argumentsList = process.argv.slice(2);
const testPaths = [];
let collectCoverage = false;
let skipIntegration = false;
let requireSingleFile = false;

for (const argument of argumentsList) {
  if (argument === '--coverage') {
    collectCoverage = true;
  } else if (argument === '--skip-integration') {
    skipIntegration = true;
  } else if (argument === '--single') {
    requireSingleFile = true;
  } else if (argument !== '--') {
    testPaths.push(argument);
  }
}

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTestFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [entryPath] : [];
  });
}

function resolveTestFile(testPath) {
  const absolutePath = path.resolve(packageDirectory, testPath);
  const relativePath = path.relative(testDirectory, absolutePath);
  const isOutsideTestDirectory =
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);

  if (isOutsideTestDirectory) {
    throw new Error(`Test path must be inside ${testDirectory}: ${testPath}`);
  }
  if (!relativePath.endsWith('.test.mjs')) {
    throw new Error(`Expected a .test.mjs file: ${testPath}`);
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Test file does not exist: ${testPath}`);
  }

  return absolutePath;
}

if (requireSingleFile && testPaths.length !== 1) {
  throw new Error('Pass exactly one test file to the test:file script.');
}

const files = testPaths.length
  ? [...new Set(testPaths.map(resolveTestFile))]
  : findTestFiles(testDirectory).sort();

if (files.length === 0) {
  throw new Error(`No .test.mjs files found under ${testDirectory}`);
}

const nodeArguments = ['--import', 'tsx', '--test'];
if (collectCoverage) nodeArguments.push('--experimental-test-coverage');
nodeArguments.push(...files.map((file) => path.relative(packageDirectory, file)));

const environment = { ...process.env };
if (skipIntegration) environment.CONFORMANCE_SKIP_INTEGRATION = '1';

const result = spawnSync(process.execPath, nodeArguments, {
  cwd: packageDirectory,
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
