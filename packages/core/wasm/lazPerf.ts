import createLazPerfModule from 'laz-perf/lib/web/laz-perf.js';

type LazPerfModule = Awaited<ReturnType<typeof createLazPerfModule>>;

let lazPerfWasmUrlPromise: Promise<URL> | undefined;

async function getLazPerfWasmUrl(): Promise<URL> {
  if (!lazPerfWasmUrlPromise) {
    lazPerfWasmUrlPromise = import('./laz-perf.wasm?url&no-inline').then(
      ({ default: assetUrl }) => new URL(assetUrl, import.meta.url),
    );
  }
  return lazPerfWasmUrlPromise;
}

/** Browser LAZ decoder factory with its WASM binary resolved from this package. */
async function createLazPerf(
  options: Parameters<typeof createLazPerfModule>[0] = undefined,
): Promise<LazPerfModule> {
  const response = await fetch(await getLazPerfWasmUrl());

  if (!response.ok) {
    throw new Error(`Failed to fetch LAZ decoder WASM: ${response.status}`);
  }

  return createLazPerfModule(
    {
      ...(options as object | undefined),
      wasmBinary: await response.arrayBuffer(),
    } as Parameters<typeof createLazPerfModule>[0],
  );
}

// copc is published as CommonJS and reads these named exports from its
// laz-perf dependency rather than using the default export.
export { createLazPerf };
export const create = createLazPerf;
export const LazPerf = { create: createLazPerf };
export default createLazPerf;
