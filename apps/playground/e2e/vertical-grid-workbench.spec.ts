import { expect, test } from "@playwright/test";

test("Playground exposes the explicit NGA profile and rejects the wrong local file", async ({ page }) => {
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

test("Playground verifies the exact local NGA grid as pending and removes it without sharing its path", async ({
  page,
}) => {
  const gridPath = process.env.COPC_NGA_EGM2008_FILE;
  test.skip(!gridPath, "Set COPC_NGA_EGM2008_FILE to an authorized local NGA grid copy");
  test.setTimeout(180_000);
  await page.goto("./");
  await page.locator("#vertical-grid-file").setInputFiles(gridPath!);
  await expect(page.locator(".vertical-grid-control__status")).toContainText(
    "verified and pending",
    { timeout: 150_000 },
  );
  const metadata = page.locator(".vertical-grid-control__metadata");
  await expect(metadata).toContainText("EPSG:3855");
  await expect(metadata).toContainText("EPSG:4979");
  await expect(metadata).toContainText("ab6f8b94076f78707d1cdae7b066b93a786a0c64b52449e20cf1a1a2f4e74daf");
  await expect(metadata).toContainText("does not state redistribution terms");
  expect(page.url()).not.toContain("Und_min2.5");
  await page.getByRole("button", { name: "Remove vertical grid" }).click();
  await expect(page.locator(".vertical-grid-control__status")).toContainText(
    "No vertical grid is applied",
  );
});
