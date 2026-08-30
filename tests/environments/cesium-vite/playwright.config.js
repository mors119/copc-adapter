import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const systemChromium = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const consumerMode = process.env.CONSUMER_MODE ?? 'production';
const consumerPort = process.env.CONSUMER_PORT ?? (consumerMode === 'dev' ? '4175' : '4174');
const serverCommand = consumerMode === 'dev'
  ? `npm run dev -- --host 127.0.0.1 --port ${consumerPort} --force`
  : `npm run preview -- --host 127.0.0.1 --port ${consumerPort}`;

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
    command: serverCommand,
    url: `http://127.0.0.1:${consumerPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
