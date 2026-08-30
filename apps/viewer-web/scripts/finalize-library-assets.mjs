import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, '..');
const distDirectory = path.resolve(appDirectory, 'dist');
const assetModule = 'copcWasmAsset.js';

const distEntries = await readdir(distDirectory);
const assetEntries = await readdir(path.resolve(distDirectory, 'assets'));
const generatedAssetModules = distEntries.filter((entry) => /^copc_wasm-[\w-]+\.js$/u.test(entry));
if (generatedAssetModules.length !== 1) {
  throw new Error(`Expected one generated COPC WASM URL module, found ${generatedAssetModules.length}`);
}
const generatedLazModules = distEntries.filter((entry) => /^laz-perf-[\w-]+\.js$/u.test(entry));
if (generatedLazModules.length !== 1) {
  throw new Error(`Expected one generated LAZ WASM URL module, found ${generatedLazModules.length}`);
}

const generatedAssetModule = generatedAssetModules[0];
const generatedLazModule = generatedLazModules[0];
const generatedWorkerModules = assetEntries.filter((entry) => entry.startsWith('rustCopcDecodeWorker-') && entry.endsWith('.js'));
if (generatedWorkerModules.length !== 1) {
  throw new Error(`Expected one generated Rust decode worker, found ${generatedWorkerModules.length}`);
}
const generatedWorkerModule = generatedWorkerModules[0];
const workerPath = path.resolve(distDirectory, 'assets', generatedWorkerModule);
const workerSource = await readFile(workerPath, 'utf8');
const workerDataUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
const generatedFactoryModules = distEntries.filter((entry) => /^rustCopcWorkerFactory-[\w-]+\.js$/u.test(entry));
if (generatedFactoryModules.length !== 1) {
  throw new Error(`Expected one generated Rust worker factory, found ${generatedFactoryModules.length}`);
}
const generatedFactoryModule = generatedFactoryModules[0];
const factoryPath = path.resolve(distDirectory, generatedFactoryModule);
let factorySource = await readFile(factoryPath, 'utf8');
const indexPath = path.resolve(distDirectory, 'index.js');
let indexSource = await readFile(indexPath, 'utf8');
const generatedImport = `./${generatedAssetModule}`;
if (!indexSource.includes(generatedImport)) {
  throw new Error(`Library entry does not reference ${generatedAssetModule}`);
}
indexSource = indexSource.replaceAll(generatedImport, `./${assetModule}`);
const lazImport = `./${generatedLazModule}`;
if (!indexSource.includes(lazImport)) {
  throw new Error(`Library entry does not reference ${generatedLazModule}`);
}
indexSource = indexSource.replaceAll(lazImport, './lazPerfAsset.js');
const workerConstructor = new RegExp(
  `new Worker\\("" \\+ new URL\\("assets/${generatedWorkerModule}", import\\.meta\\.url\\)\\.href, \\{ name: e\\?\\.name \\}\\)`,
);
if (!workerConstructor.test(factorySource)) {
  throw new Error(`Worker factory does not reference ${generatedWorkerModule}`);
}
factorySource = factorySource.replace(workerConstructor, `new Worker(${JSON.stringify(workerDataUrl)}, { name: e?.name })`);
const factoryImport = `./${generatedFactoryModule}`;
if (!indexSource.includes(factoryImport)) {
  throw new Error(`Library entry does not reference ${generatedFactoryModule}`);
}
indexSource = indexSource.replaceAll(factoryImport, './rustCopcWorkerFactory.js');
await writeFile(indexPath, indexSource);
await rm(path.resolve(distDirectory, generatedAssetModule));
await rm(path.resolve(distDirectory, generatedLazModule));
await rm(workerPath);
await rm(factoryPath);
await writeFile(
  path.resolve(distDirectory, assetModule),
  "import wasmAssetUrl from './copc_wasm.wasm?url&no-inline';\nexport default wasmAssetUrl;\n",
);
await writeFile(
  path.resolve(distDirectory, 'lazPerfAsset.js'),
  "import wasmAssetUrl from './laz-perf.wasm?url&no-inline';\nexport default wasmAssetUrl;\n",
);
await writeFile(path.resolve(distDirectory, 'rustCopcWorkerFactory.js'), factorySource);
await copyFile(
  path.resolve(appDirectory, 'src/wasm/laz-perf.wasm'),
  path.resolve(distDirectory, 'laz-perf.wasm'),
);
