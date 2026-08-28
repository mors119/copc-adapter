import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const systemChromium = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const consumerPort = process.env.CONSUMER_PORT ?? '4174';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: `http://127.0.0.1:${consumerPort}`,
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ?? (fs.existsSync(systemChromium) ? systemChromium : undefined),
      args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=swiftshader'],
    },
  },
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${consumerPort}`,
    url: `http://127.0.0.1:${consumerPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
