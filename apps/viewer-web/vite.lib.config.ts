import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['cesium'],
    },
  },
  resolve: {
    alias: [
      // copc's browser LAZ decoder discovers its WASM beside the generated
      // script. This wrapper supplies the package-local asset URL so a
      // consumer does not need to copy laz-perf.wasm into its web root.
      {
        find: /^laz-perf$/,
        replacement: path.resolve(appDirectory, 'src/wasm/lazPerf.ts'),
      },
    ],
  },
});
