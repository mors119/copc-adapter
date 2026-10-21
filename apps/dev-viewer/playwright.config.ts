import { defineConfig } from "@playwright/test";
import fs from "node:fs";

const systemChromium =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const benchmarkProduction = process.env.COPC_BENCHMARK_PRODUCTION === "1";
const benchmarkHardware = process.env.COPC_BENCHMARK_HARDWARE === "1";
const testPort = Number(process.env.PLAYWRIGHT_TEST_PORT ?? 4173);
if (!Number.isSafeInteger(testPort) || testPort < 1 || testPort > 65_535) {
  throw new Error("PLAYWRIGHT_TEST_PORT must be an integer from 1 to 65535");
}
const testUrl = `http://127.0.0.1:${testPort}`;
export default defineConfig({
  testDir: "./e2e",
  // Split independent scenarios across isolated CI runners instead of keeping
  // every test from one large spec file on the same runner.
  fullyParallel: true,
  // Each scenario streams and renders a large real COPC sample. Running
  // several Chromium/WebGL instances concurrently makes the validation gate
  // contend for CPU and memory and turns deterministic checks into timeouts.
  workers: 1,
  reporter: process.env.CI
    ? [["dot"], ["json", { outputFile: "test-results/results.json" }]]
    : undefined,
  timeout: 120000,
  expect: {
    timeout: 60000,
  },
  use: {
    baseURL: testUrl,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (fs.existsSync(systemChromium) ? systemChromium : undefined),
      args: [
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        ...(benchmarkHardware ? [] : ["--use-gl=swiftshader"]),
      ],
    },
  },
  webServer: {
    command: `npm run ${benchmarkProduction ? "preview" : process.env.COPC_ADAPTER_WASM_PREPARED === "1" ? "dev:ci" : "dev"} -- --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: testUrl,
    reuseExistingServer:
      process.env.PLAYWRIGHT_REUSE_SERVER === "1" && !process.env.CI,
    timeout: 120000,
  },
});
