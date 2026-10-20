import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __VERTICAL_GRID_BROWSER_SMOKE__?: () => Promise<{
      centerUndulationMeters: number;
      correctedHeightMeters: number;
      noDataCode: string;
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
