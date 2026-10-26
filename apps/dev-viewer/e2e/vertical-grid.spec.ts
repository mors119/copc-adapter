import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";

import { expect, test } from "./ci-diagnostic-fixtures";

declare global {
  interface Window {
    __VERTICAL_GRID_BROWSER_SMOKE__?: () => Promise<{
      centerUndulationMeters: number;
      correctedHeightMeters: number;
      noDataCode: string;
    }>;
    __NGA_EGM2008_BROWSER_SMOKE__?: (
      url: string,
      inputMode: "blob" | "array-buffer",
    ) => Promise<{
      sha256: string;
      encodedByteLength: number;
      decodedByteLength: number;
      width: number;
      height: number;
      loadDurationMs: number;
      interpolation250kMs: number;
      sanFranciscoMeters: number;
      longTasks: Array<{ startTimeMs: number; durationMs: number }>;
      rowTaskDurationsMs: number[];
      maximumFrameGapMs: number;
      maximumTimerDelayMs: number;
      fetchDurationMs: number;
      sourceReadDurationMs: number;
      loaderDurationMs: number;
      userAgentMemoryBytes?: number;
    }>;
  }
}

test("browser loads a local GTX Blob with Web Crypto and fails on NoData", async ({
  page,
}) => {
  await page.goto("/?debugPanel=off");
  await page.addScriptTag({
    url: "/e2e/vertical-grid-browser-harness.ts",
    type: "module",
  });
  const result = await page.evaluate(async () => {
    if (!window.__VERTICAL_GRID_BROWSER_SMOKE__) {
      throw new Error("Vertical grid browser smoke harness was not loaded");
    }
    return window.__VERTICAL_GRID_BROWSER_SMOKE__();
  });
  expect(result.centerUndulationMeters).toBe(25);
  expect(result.correctedHeightMeters).toBe(125);
  expect(result.noDataCode).toBe("grid-nodata");
});

test("browser loads and samples the pinned NGA EGM2008 grid from Blob and ArrayBuffer", async ({
  browser,
}) => {
  const gridPath = process.env.COPC_NGA_EGM2008_FILE;
  test.skip(!gridPath, "Set COPC_NGA_EGM2008_FILE to the locally extracted NGA grid");
  test.setTimeout(600_000);
  const gridByteLength = (await stat(gridPath!)).size;
  const gridServer = createServer((request, response) => {
    if (request.url !== "/egm2008-grid.raw") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Length": String(gridByteLength),
      "Content-Type": "application/octet-stream",
    });
    createReadStream(gridPath!).pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    gridServer.once("error", reject);
    gridServer.listen(0, "127.0.0.1", resolve);
  });
  const address = gridServer.address();
  if (!address || typeof address === "string") throw new Error("EGM2008 fixture server failed to bind");
  const gridUrl = `http://127.0.0.1:${address.port}/egm2008-grid.raw`;
  const modes = ["blob", "array-buffer"] as const;

  try {
    for (const mode of modes) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto("/e2e/fixtures/vertical-grid-loader.html");
        const result = await page.evaluate(async ({ inputMode, url }) => {
          if (!window.__NGA_EGM2008_BROWSER_SMOKE__) {
            throw new Error("NGA EGM2008 browser harness was not loaded");
          }
          return window.__NGA_EGM2008_BROWSER_SMOKE__(url, inputMode);
        }, { inputMode: mode, url: gridUrl });

        expect(result.sha256).toBe(
          "ab6f8b94076f78707d1cdae7b066b93a786a0c64b52449e20cf1a1a2f4e74daf",
        );
        expect(result.encodedByteLength).toBe(149_368_328);
        expect(result.decodedByteLength).toBe(149_333_760);
        expect(result.width).toBe(8_640);
        expect(result.height).toBe(4_321);
        expect(result.sanFranciscoMeters).toBeCloseTo(-32.16355837237304, 5);
        const { rowTaskDurationsMs, ...metrics } = result;
        console.log(`[EGM2008 browser metrics] ${mode} ${JSON.stringify({
          ...metrics,
          rowTaskCount: rowTaskDurationsMs.length,
          maximumRowTaskMs: Math.max(...rowTaskDurationsMs),
        })}`);
        await test.info().attach(`egm2008-browser-${mode}.json`, {
          body: JSON.stringify(result, null, 2),
          contentType: "application/json",
        });
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await new Promise<void>((resolve) => gridServer.close(() => resolve()));
  }
});
