import createLazPerfModule from 'laz-perf/lib/web/laz-perf.js';

type LazPerfModule = Awaited<ReturnType<typeof createLazPerfModule>>;

const lazPerfWasmUrl = new URL('./laz-perf.wasm?no-inline', import.meta.url);

/** Browser LAZ decoder factory with its WASM binary resolved from this package. */
async function createLazPerf(
  options: Parameters<typeof createLazPerfModule>[0] = undefined,
): Promise<LazPerfModule> {
  const response = await fetch(lazPerfWasmUrl);

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
