import { expect, test } from "@playwright/test";

const preferenceKey = "copc-adapter-playground.quick-start-dismissed.v1";

test("first visit explains remote Probe/Load and the local-file exception", async ({ page }) => {
  await page.goto("./");

  const guide = page.locator("#quick-start-content");
  await expect(guide).toBeVisible();
  await expect(page.getByRole("button", { name: "Quick start" })).toHaveAttribute("aria-expanded", "true");
  await expect(guide).toContainText("Choose a source");
  await expect(guide).toContainText("Probe source");
  await expect(guide).toContainText("Load source");
  await expect(guide).toContainText("no HTTP Probe needed");
  await expect(guide).toContainText("Apply changes");

  await expect(page.getByRole("button", { name: "Probe source" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Load source" })).toBeDisabled();
});

test("dismissal persists without blocking manual reopening or Escape", async ({ page }) => {
  await page.goto("./");

  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.locator("#quick-start-content")).toBeHidden();
  await expect(page.getByRole("button", { name: "Quick start" })).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe("1");

  await page.reload();
  await expect(page.locator("#quick-start-content")).toBeHidden();
  const toggle = page.getByRole("button", { name: "Quick start" });
  await toggle.click();
  await expect(page.locator("#quick-start-content")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#quick-start-content")).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.reload();
  await expect(page.locator("#quick-start-content")).toBeHidden();
});

test("unchecked opt-out lets the guide appear again on the next visit", async ({ page }) => {
  await page.goto("./");

  await page.locator("#quick-start-hide").uncheck();
  await page.getByRole("button", { name: "Close quick start guide" }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();

  await page.reload();
  await expect(page.locator("#quick-start-content")).toBeVisible();
});

test("guide stays within the narrow Source panel without obscuring controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");

  await expect(page.locator("#quick-start-content")).toBeVisible();
  const width = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport);

  await page.getByRole("button", { name: "Probe source" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Probe source" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Load source" })).toBeDisabled();
});
