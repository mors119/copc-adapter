import { defineConfig } from "@playwright/test";
import fs from "node:fs";

const port = Number(process.env.IMAGERY_RESEARCH_PORT ?? 4176);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("IMAGERY_RESEARCH_PORT must be an integer from 1 to 65535");
}
const url = `http://127.0.0.1:${port}`;
const systemChromium =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "imagery-projection-research.spec.js",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: url,
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
        (fs.existsSync(systemChromium) ? systemChromium : undefined),
      args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-gl=swiftshader"],
    },
  },
  webServer: {
    command: `npm run dev -- --config vite.imagery-research.config.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${url}/imagery-research/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
