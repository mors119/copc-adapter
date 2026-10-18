import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYGROUND_TEST_PORT ?? 5180);
const baseURL = `http://127.0.0.1:${port}/copc-adapter/playground/`;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=swiftshader'],
    },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
