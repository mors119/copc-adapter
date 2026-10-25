import { expect, test } from "@playwright/test";

test("uses the same schema controls and default Workbench tabs as Playground", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator(".workbench-provenance")).toHaveText(
    /^local \d+\.\d+\.\d+ \/ Dev Viewer$/,
  );
  const tabs = page.getByRole("tablist", { name: "Workbench details" });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Code",
    "Source",
    "Health",
    "Data",
  ]);
  await expect(tabs.getByRole("tab", { name: "Code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#workbench-panel-code")).toBeVisible();
  const desktopLayout = await page.evaluate(() => ({
    viewportWidth: document.querySelector("#viewport-panel")!.getBoundingClientRect().width,
    windowWidth: window.innerWidth,
  }));
  expect(desktopLayout.viewportWidth).toBeGreaterThanOrEqual(
    desktopLayout.windowWidth * 0.5,
  );

  await expect(page.getByRole("radiogroup", { name: "Renderer", exact: true })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "COPC backend" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Color mode" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Point size" })).toBeVisible();
  await expect(
    page.locator('.schema-control-section[data-section="streaming"] summary'),
  ).toHaveText("Streaming");
  await expect(
    page.locator(".dev-control-section").filter({
      has: page.getByText("Camera presets", { exact: true }),
    }),
  ).not.toHaveAttribute("open", "");
  await expect(
    page.locator(".dev-control-section").filter({
      has: page.getByText("Terrain and height alignment", { exact: true }),
    }),
  ).not.toHaveAttribute("open", "");

  const toggle = page.locator("#controls-toggle");
  await expect(toggle).toHaveAccessibleName("Collapse configuration panel");
  await toggle.click();
  await expect(page.locator("#controls-panel")).toBeHidden();
  await expect(toggle).toHaveAccessibleName("Expand configuration panel");
  await toggle.click();
  await expect(page.locator("#controls-panel")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLayout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.querySelector("#cesium-container")!.getBoundingClientRect().width,
  }));
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(narrowLayout.viewportWidth).toBeGreaterThan(0);
});
