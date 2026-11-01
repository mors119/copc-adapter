import { expect, test } from "@playwright/test";

test("Playground exposes only the pinned EGM2008 profiles and rejects an unrelated local file", async ({ page }) => {
  await page.goto("./");
  const gridInput = page.locator("#vertical-grid-file");
  await expect(gridInput).toHaveCount(1);
  await expect(page.locator('[data-option-id="coordinates.verticalTransform"]')).toBeVisible();
  await gridInput.setInputFiles({
    name: "wrong-grid.SE",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("not an NGA grid"),
  });
  await expect(page.getByRole("alert").filter({ hasText: /149,368,328 bytes/u })).toBeVisible();
  await expect(page.locator(".vertical-grid-control__metadata")).toHaveCount(0);
  await expect(gridInput).toBeEnabled();
});

test("Playground verifies the exact local OSGeo EGM2008 GTX and removes it without sharing its path", async ({
  page,
}) => {
  const gridPath = process.env.COPC_WORKBENCH_EGM2008_FILE;
  test.skip(!gridPath, "Set COPC_WORKBENCH_EGM2008_FILE to the verified OSGeo EGM2008 GTX");
  test.setTimeout(180_000);
  await page.goto("./");
  await page.locator("#vertical-grid-file").setInputFiles(gridPath!);
  await expect(page.locator(".vertical-grid-control__status")).toContainText(
    "verified and pending",
    { timeout: 150_000 },
  );
  await expect(page.locator(".vertical-grid-control__status")).toContainText(
    "OSGeo PROJ-DATUMGRID-WORLD",
  );
  const metadata = page.locator(".vertical-grid-control__metadata");
  await expect(metadata).toContainText("EPSG:3855");
  await expect(metadata).toContainText("EPSG:4979");
  await expect(metadata).toContainText("c18f20d1fe88616e3497a3eff993227371e1d9acc76f96253e8d84b475bbe6bf");
  await expect(metadata).toContainText("Public Domain");
  expect(page.url()).not.toContain("Und_min2.5");
  await page.getByRole("button", { name: "Remove vertical grid" }).click();
  await expect(page.locator(".vertical-grid-control__status")).toContainText(
    "No vertical grid is applied",
  );
});
