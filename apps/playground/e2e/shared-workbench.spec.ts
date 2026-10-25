import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __COPC_PLAYGROUND_TEST__?: {
      getPendingConfig(): {
        renderer: string;
        schemaOptionValues?: Readonly<Record<string, unknown>>;
      };
    };
  }
}

test("uses the shared schema controls and four-tab Workbench shell", async ({
  page,
}) => {
  await page.goto("./");

  await expect(page.locator(".workbench-provenance")).toHaveText(
    /^npm release \d+\.\d+\.\d+ \/ Playground$/,
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
    viewportWidth: document.querySelector("#viewer-column")!.getBoundingClientRect().width,
    windowWidth: window.innerWidth,
  }));
  expect(desktopLayout.viewportWidth).toBeGreaterThanOrEqual(
    desktopLayout.windowWidth * 0.5,
  );

  await expect(page.getByRole("radiogroup", { name: "Renderer" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "COPC backend" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Color mode" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Point size" })).toBeVisible();
  await expect(
    page.locator('.schema-control-section[data-section="streaming"] summary'),
  ).toHaveText("Streaming");

  const toggle = page.locator("#workbench-left-toggle");
  await expect(toggle).toHaveAccessibleName("Collapse configuration panel");
  await toggle.click();
  await expect(page.locator("#workbench-controls")).toBeHidden();
  await expect(toggle).toHaveAccessibleName("Expand configuration panel");
  await toggle.click();
  await expect(page.locator("#workbench-controls")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const leftToggle = page.locator("#workbench-left-toggle");
  const rightToggle = page.locator("#workbench-right-toggle");
  await leftToggle.click();
  await rightToggle.click();
  const mobileCollapsed = await page.evaluate(() => ({
    leftHeight: document.querySelector(".workbench-panel-shell--left")!.getBoundingClientRect().height,
    rightHeight: document.querySelector(".workbench-panel-shell--right")!.getBoundingClientRect().height,
  }));
  expect(mobileCollapsed.leftHeight).toBeLessThanOrEqual(48);
  expect(mobileCollapsed.rightHeight).toBeLessThanOrEqual(48);

  await page.setViewportSize({ width: 768, height: 844 });
  const tabletCollapsedHeight = await page.locator(".workbench-panel-shell--right").evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(tabletCollapsedHeight).toBeLessThanOrEqual(48);
  await rightToggle.click();
  await expect.poll(() => page.locator(".workbench-panel-shell--right").evaluate(
    (element) => element.getBoundingClientRect().height,
  )).toBeGreaterThan(200);
  await rightToggle.click();
  await expect.poll(() => page.locator(".workbench-panel-shell--right").evaluate(
    (element) => element.getBoundingClientRect().height,
  )).toBeLessThanOrEqual(48);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrowLayout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.querySelector("#cesium-container")!.getBoundingClientRect().width,
  }));
  expect(narrowLayout.documentWidth).toBeLessThanOrEqual(390);
  expect(narrowLayout.viewportWidth).toBeGreaterThan(0);
});

test("retains Cesium-only schema options across renderer changes without applying them to Three.js", async ({
  page,
}) => {
  await page.goto("./");
  const pointSizeMode = page.locator("#point-size-mode");
  await pointSizeMode.selectOption("attenuated");
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "rendering.pointSizeMode"
    ],
  )).toBe("attenuated");

  const rendererGroup = page.getByRole("radiogroup", { name: "Renderer" });
  await rendererGroup.getByRole("radio", { name: "Three.js" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().renderer,
  )).toBe("three");
  await expect.poll(() => page.evaluate(() =>
    Object.hasOwn(
      window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues ?? {},
      "rendering.pointSizeMode",
    ),
  )).toBe(false);
  await expect(page.locator("#config-validation")).not.toContainText("Point Size Mode");

  await rendererGroup.getByRole("radio", { name: "Cesium" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "rendering.pointSizeMode"
    ],
  )).toBe("attenuated");
  await expect(pointSizeMode).toHaveValue("attenuated");
});
