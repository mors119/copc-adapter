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
    "npm release 0.7.1 / Playground",
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
  const colorModeGroup = page.getByRole("radiogroup", { name: "Color mode" });
  await page.evaluate(() => {
    document.querySelector(".workbench-three-column")?.setAttribute("style", "--workbench-left-track: minmax(0, 12rem)");
  });
  const colorModeLayout = await colorModeGroup.evaluate((group) => ({
    clientWidth: group.clientWidth,
    scrollWidth: group.scrollWidth,
    buttons: [...group.querySelectorAll("button[role=radio]")].map((button) => ({
      text: button.textContent?.trim(),
      width: button.getBoundingClientRect().width,
      clientWidth: button.clientWidth,
      scrollWidth: button.scrollWidth,
    })),
  }));
  expect(colorModeLayout.scrollWidth).toBeLessThanOrEqual(colorModeLayout.clientWidth);
  expect(colorModeLayout.buttons.every(({ text, width, clientWidth, scrollWidth }) =>
    Boolean(text) && width > 0 && scrollWidth <= clientWidth,
  )).toBe(true);
  const nextColorMode = await colorModeGroup.evaluate((group) => {
    const enabled = [...group.querySelectorAll<HTMLButtonElement>("button[role=radio]")]
      .filter((button) => !button.disabled);
    const selected = enabled.findIndex((button) => button.getAttribute("aria-checked") === "true");
    return enabled[(selected + 1 + enabled.length) % enabled.length]?.textContent?.trim() ?? "";
  });
  await colorModeGroup.locator('button[role="radio"][aria-checked="true"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect(colorModeGroup.getByRole("radio", { name: nextColorMode, exact: true })).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => document.querySelector(".workbench-three-column")?.removeAttribute("style"));
  await expect(
    page.getByRole("radiogroup", { name: "Color mode" }).getByRole("radio", { name: "Numeric Dimension" }),
  ).toHaveCount(0);
  await expect(page.locator('[data-option-id="style.dimension"]')).toHaveCount(0);
  await expect(page.locator('[data-option-id="style.dimensionFilter"]')).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Point size" })).toBeVisible();
  await expect(page.locator("#schema-opacity-slider")).toBeVisible();
  await page.locator('details[data-section="filtering"] > summary').click();
  await expect(page.locator("#schema-clipping-enabled")).toBeVisible();
  await expect(
    page.locator('.schema-control-section[data-section="streaming"] > summary'),
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

test("keeps source validation, runtime health, and dataset analysis in their own tabs", async ({
  page,
}) => {
  await page.goto("./");

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator("#source-status")).toBeVisible();

  await page.getByRole("tab", { name: "Health" }).click();
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='playground-health-runtime'] summary"),
  ).toHaveText("Runtime status");
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='playground-health-resources'] summary"),
  ).toHaveText("Cache and workers");
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='playground-data-hierarchy']"),
  ).toHaveCount(0);

  await page.getByRole("tab", { name: "Data" }).click();
  await expect(
    page.locator("#workbench-panel-data [data-diagnostic-section='playground-data-hierarchy'] summary"),
  ).toHaveText("Hierarchy and coverage");
  await expect(
    page.locator("#workbench-panel-data [data-diagnostic-section='playground-data-refinement'] summary"),
  ).toHaveText("Refinement and budget");
  await expect(page.locator("#workbench-panel-data .point-popover")).toHaveCount(0);
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

test("keeps options supported by the installed package profile across renderer changes", async ({
  page,
}) => {
  await page.goto("./");
  const rendererGroup = page.getByRole("radiogroup", { name: "Renderer" });
  const attributesSection = page.locator('details[data-section="attributes"]');
  if (!(await attributesSection.evaluate((element: HTMLDetailsElement) => element.open))) {
    await attributesSection.locator(":scope > summary").click();
  }
  const attributeLoading = page.locator("#schema-attribute-loading");
  await attributeLoading.selectOption("required");
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "attributes.attributeLoading"
    ],
  )).toBe("required");

  await rendererGroup.getByRole("radio", { name: "Three.js" }).click();
  await expect.poll(() => page.evaluate(() =>
    Object.hasOwn(
      window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues ?? {},
      "attributes.attributeLoading",
    ),
  )).toBe(false);

  await rendererGroup.getByRole("radio", { name: "Cesium" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "attributes.attributeLoading"
    ],
  )).toBe("required");
  await expect(attributeLoading).toHaveValue("required");

  const streamingSection = page.locator('details[data-section="streaming"]');
  if (!(await streamingSection.evaluate((element: HTMLDetailsElement) => element.open))) {
    await streamingSection.locator(":scope > summary").click();
  }

  const concurrentLoads = page.locator("#max-concurrent-node-loads");
  await concurrentLoads.fill("7");
  await concurrentLoads.dispatchEvent("change");
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "streaming.maxConcurrentNodeLoads"
    ],
  )).toBe(7);

  await rendererGroup.getByRole("radio", { name: "Cesium" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "streaming.maxConcurrentNodeLoads"
    ],
  )).toBe(7);
  await expect(page.locator("#config-validation")).not.toContainText("Concurrent Node Loads");
  await rendererGroup.getByRole("radio", { name: "Three.js" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "streaming.maxConcurrentNodeLoads"
    ],
  )).toBe(7);

  await rendererGroup.getByRole("radio", { name: "Cesium" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__COPC_PLAYGROUND_TEST__?.getPendingConfig().schemaOptionValues?.[
      "streaming.maxConcurrentNodeLoads"
    ],
  )).toBe(7);
  await expect(page.locator("#max-concurrent-node-loads")).toHaveValue("7");
});
