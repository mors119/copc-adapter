import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

const systemChromium = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const isFunctionalOnlyRun = process.argv.some((argument) =>
  argument.endsWith('functional-validation.spec.ts'));
const devServerCommand = isFunctionalOnlyRun
  ? 'npm run dev:validation'
  : process.env.COPC_WASM_PREPARED === '1'
  ? 'npm run dev:ci'
  : 'npm run dev';

export default defineConfig({
  testDir: './e2e',
  // Each scenario streams and renders a large real COPC sample. Running
  // several Chromium/WebGL instances concurrently makes the validation gate
  // contend for CPU and memory and turns deterministic checks into timeouts.
  workers: 1,
  timeout: 120000,
  expect: {
    timeout: 60000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4177',
    browserName: 'chromium',
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
        ?? (fs.existsSync(systemChromium) ? systemChromium : undefined),
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=swiftshader',
      ],
    },
  },
  webServer: {
    command: `${devServerCommand} -- --host 127.0.0.1 --port 4177 --strictPort`,
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
