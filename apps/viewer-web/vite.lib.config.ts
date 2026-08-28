import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Keep asset URLs relative to the package entry when it is imported by a
  // separate Vite application.
  base: './',
  // The application public directory may contain a downloaded sample. It is
  // never part of the reusable library package.
  publicDir: false,
  build: {
    // Keep decoder binaries as package assets so a packed consumer exercises
    // the same URL resolution path as a published installation.
    assetsInlineLimit: 0,
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
