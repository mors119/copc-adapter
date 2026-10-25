import { expect, test } from "@playwright/test";

test("diagnostics show unavailable values honestly and follow the replacement layer", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Health" }).click();
  await expect(page.locator("#diagnostic-points")).toHaveText("Not available");
  await expect(page.locator("#diagnostic-render-interval")).toHaveText(
    "Not available",
  );
  await page
    .locator('[data-diagnostic-section="playground-health-processing"] summary')
    .click();
  await expect(
    page.getByText("Observed render interval", { exact: true }),
  ).toBeVisible();

  await page.evaluate(() => {
    (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          useCameraResetLayerMock(): void;
        };
      }
    ).__COPC_PLAYGROUND_TEST__?.useCameraResetLayerMock();
  });
  await page.locator("#copc-file").setInputFiles({
    name: "first-diagnostics.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("mock source"),
  });
  await expect(page.locator("#source-status")).toContainText(
    "Loaded first-diagnostics.copc.laz",
  );
  await expect(page.locator("#diagnostic-context")).toContainText(
    "first-diagnostics.copc.laz",
  );
  await expect(page.locator("#diagnostic-points")).toHaveText("0");
  await expect(page.locator("#diagnostic-worker")).toHaveText(
    "Not applicable for this backend",
  );
  await expect(page.locator("#diagnostic-cache-bytes")).toHaveText("0 B");

  await page.locator("#copc-file").setInputFiles({
    name: "replacement-diagnostics.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("replacement source"),
  });
  await expect(page.locator("#source-status")).toContainText(
    "Loaded replacement-diagnostics.copc.laz",
  );
  await expect(page.locator("#diagnostic-context")).toContainText(
    "replacement-diagnostics.copc.laz",
  );
  await expect(page.locator("#diagnostic-context")).not.toContainText(
    "first-diagnostics.copc.laz",
  );
});

test("keeps Long Task observation active when source selection changes", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("tab", { name: "Health" }).click();
  const supportsLongTasks = await page.evaluate(() =>
    PerformanceObserver.supportedEntryTypes.includes("longtask"),
  );
  test.skip(!supportsLongTasks, "Long Task API is not available in this browser");

  await page.evaluate(() => {
    (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          useCameraResetLayerMock(): void;
        };
      }
    ).__COPC_PLAYGROUND_TEST__?.useCameraResetLayerMock();
  });
  await page.locator("#copc-file").setInputFiles({
    name: "long-task-observer.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("mock source"),
  });
  await expect(page.locator("#source-status")).toContainText(
    "Loaded long-task-observer.copc.laz",
  );

  await page.locator("#remote-source").selectOption("chicago");
  await page.evaluate(() => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 120) {
      // Deliberately produce a browser-observed Long Task for this lifecycle test.
    }
  });

  await page.locator(
    '[data-diagnostic-section="playground-health-processing"] summary',
  ).click();
  await expect(page.locator("#diagnostic-long-task")).not.toHaveText(
    "Not available",
    { timeout: 3_000 },
  );
});
