import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = Number(process.env.COPC_TILES_BROWSER_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: root + '/test/browser',
  testMatch: '**/*.spec.mjs',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    viewport: { width: 640, height: 480 },
    launchOptions: {
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `vite --config test/browser/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    url: `${baseURL}/test/browser/cesium.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
