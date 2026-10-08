import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export const PLAYGROUND_BASE = '/copc-adapter/playground/';

export default defineConfig({
  base: PLAYGROUND_BASE,
  plugins: [cesium({ rebuildCesium: true })],
  build: {
    assetsInlineLimit: 0,
  },
});
