import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDirectory = path.resolve(appDirectory, 'dist');
const packageDirectory = path.resolve(appDirectory, 'node_modules/@frillab/copc-adapter');
const basePath = '/copc-adapter/playground/';

async function requireFile(filename, message = filename) {
  try {
    await access(filename);
  } catch {
    throw new Error(`Playground production build is missing ${message}.`);
  }
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filename) : [filename];
  }));
  return files.flat();
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

await requireFile(path.join(distDirectory, 'index.html'), 'index.html');
await requireFile(path.join(distDirectory, 'cesium/Widgets/widgets.css'), 'Cesium widgets CSS');
await requireFile(path.join(distDirectory, 'cesium/Assets'), 'Cesium static assets');
await requireFile(path.join(distDirectory, 'cesium/Workers'), 'Cesium Worker directory');
const html = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
const htmlResources = [...html.matchAll(/\b(?:src|href)="([^"]+)"/gu)].map((match) => match[1]);
if (!htmlResources.some((url) => url.endsWith('.js')) || !htmlResources.some((url) => url.endsWith('.css'))) {
  throw new Error('Playground HTML must reference its production JavaScript and CSS bundles.');
}
if (!htmlResources.includes(`${basePath}cesium/Widgets/widgets.css`)) {
  throw new Error('Cesium widgets CSS is not referenced under the Playground base path.');
}
for (const url of htmlResources) {
  if (url.startsWith('/') && !url.startsWith(basePath)) {
    throw new Error(`Playground HTML resource escapes its nested base path: ${url}`);
  }
}

const packageJson = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
if (packageJson.name !== '@frillab/copc-adapter' || !packageJson.exports?.['./cesium']) {
  throw new Error('Playground must use the packed adapter package and its public Cesium entrypoint.');
}
for (const filename of [
  'dist/cesium.js',
  'dist/copc_wasm.wasm',
  'dist/laz-perf.wasm',
  'dist/copcWasmAsset.js',
  'dist/lazPerfAsset.js',
  'dist/rustCopcWorkerFactory.js',
]) {
  await requireFile(path.join(packageDirectory, filename), `packed adapter ${filename}`);
}

const outputFiles = await filesUnder(distDirectory);
const cssFiles = outputFiles.filter((filename) => filename.endsWith('.css'));
const javascriptFiles = outputFiles.filter((filename) => filename.endsWith('.js'));
const cesiumWorkers = outputFiles.filter((filename) =>
  filename.includes(`${path.sep}cesium${path.sep}Workers${path.sep}`) && filename.endsWith('.js'));
const wasmFiles = outputFiles.filter((filename) => filename.endsWith('.wasm'));
const bundledJavaScript = (await Promise.all(javascriptFiles.map((filename) => readFile(filename, 'utf8')))).join('\n');

if (cssFiles.length === 0 || javascriptFiles.length === 0) {
  throw new Error('Playground production output is missing CSS or JavaScript bundles.');
}
if (cesiumWorkers.length === 0) {
  throw new Error('Cesium static Web Worker assets were not copied into the Playground build.');
}
const adapterWasmFiles = wasmFiles.filter((filename) =>
  /^(?:copc_wasm|laz-perf)(?:-[\w-]+)?\.wasm$/u.test(path.basename(filename)));
if (!adapterWasmFiles.some((filename) => /^copc_wasm/u.test(path.basename(filename))) ||
    !adapterWasmFiles.some((filename) => /^laz-perf/u.test(path.basename(filename)))) {
  throw new Error('The Playground build must emit both adapter WASM runtime assets.');
}
if (!bundledJavaScript.includes(`${basePath}cesium/`)) {
  throw new Error('Cesium runtime assets are not rooted at the Playground production base path.');
}
if (!bundledJavaScript.includes('data:text/javascript;base64,')) {
  throw new Error('The packed adapter Rust Worker module was not included in the Playground bundle.');
}
for (const filename of adapterWasmFiles) {
  const basename = path.basename(filename);
  if (!bundledJavaScript.includes(`${basePath}assets/${basename}`)) {
    throw new Error(`Adapter runtime asset is not referenced under the Playground base: ${basename}`);
  }
}

for (const filename of cssFiles) {
  const source = await readFile(filename, 'utf8');
  const cssUrls = [...source.matchAll(/url\((?:["']?)([^"')]+)(?:["']?)\)/gu)].map((match) => match[1]);
  for (const url of cssUrls) {
    if (/^(?:data:|https?:|\/\/|#)/iu.test(url)) continue;
    const resourcePath = url.startsWith('/')
      ? url.startsWith(basePath)
        ? path.join(distDirectory, url.slice(basePath.length).split(/[?#]/u)[0])
        : undefined
      : path.resolve(path.dirname(filename), url.split(/[?#]/u)[0]);
    if (!resourcePath || !await isFile(resourcePath)) {
      throw new Error(`Generated Playground CSS resource is missing or escapes ${basePath}: ${url}`);
    }
  }
}

for (const filename of outputFiles.filter((entry) => entry.endsWith('.js'))) {
  const relativeDirectory = path.relative(distDirectory, filename).split(path.sep)[0];
  if (relativeDirectory !== 'assets' && !filename.includes(`${path.sep}cesium${path.sep}Workers${path.sep}`)) continue;
  const source = await readFile(filename, 'utf8');
  const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)].map((match) => match[1]);
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(filename), specifier.split(/[?#]/u)[0]);
    if (!await isFile(target)) {
      throw new Error(`Generated Playground JavaScript chunk is missing relative import ${specifier}.`);
    }
  }
}

console.log(`Playground production assets verified under ${basePath}.`);
