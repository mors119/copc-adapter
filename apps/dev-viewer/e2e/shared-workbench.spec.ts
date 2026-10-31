import { expect, test } from "./ci-diagnostic-fixtures";

type DevViewerFocusTestApi = {
  getConfiguration(): { renderer: string };
  getSnapshot():
    | {
        lifecycle: string;
        performance: { refinementFocusEnabled?: boolean };
      }
    | undefined;
};

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerFocusTestApi;
  }
}

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
  const leftToggle = page.locator("#controls-toggle");
  const rightToggle = page.locator("#inspector-toggle");
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

test("assigns source, runtime health, and dataset analysis to separate tabs", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(
    page.locator("#workbench-panel-source [data-diagnostic-section='source-current'] summary"),
  ).toHaveText("Current source");
  await expect(
    page.locator("#workbench-panel-source [data-diagnostic-section='source-probe'] summary"),
  ).toHaveText("Range, CORS, and format validation");

  await page.getByRole("tab", { name: "Health" }).click();
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='health-runtime'] summary"),
  ).toHaveText("Runtime status");
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='health-cache'] summary"),
  ).toHaveText("Decoded CPU point cache");
  await expect(
    page.locator("#workbench-panel-health [data-diagnostic-section='data-hierarchy']"),
  ).toHaveCount(0);

  await page.getByRole("tab", { name: "Data" }).click();
  await expect(
    page.locator("#workbench-panel-data [data-diagnostic-section='data-hierarchy'] summary"),
  ).toHaveText("Hierarchy");
  await expect(
    page.locator("#workbench-panel-data [data-diagnostic-section='data-motion'] summary"),
  ).toHaveText("Motion Lookahead");
  await expect(page.locator("#workbench-panel-data .point-popover")).toHaveCount(0);
});

test("generates shared Code tab output from applied workspace configuration", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  const code = page.locator("#integration-example");
  const codeSummary = page.locator("#workbench-panel-code .summary-state");
  await expect(code).toContainText("local workspace source; unpublished");
  await expect(code).toContainText("CopcCesiumLayer");
  await expect(codeSummary).toContainText("up to date");
  const terrainRecipe = page.locator("#include-terrain-alignment-recipe");
  await expect(terrainRecipe).toBeVisible();
  await expect(code).not.toContainText("estimateAndApproveTerrainPlacement");
  await terrainRecipe.check();
  await expect(code).toContainText("estimateAndApproveTerrainPlacement");
  await expect(code).toContainText("window.confirm");
  await terrainRecipe.uncheck();
  await expect(code).not.toContainText("estimateAndApproveTerrainPlacement");
  const initialCode = await code.textContent();

  const pointSize = page.locator("#point-size-value");
  await pointSize.fill("7");
  await pointSize.dispatchEvent("change");
  await page.locator('.schema-control-section[data-section="performance"] summary').click();
  const maxPoints = page.locator("#max-points-value");
  await maxPoints.fill("50000");
  await maxPoints.dispatchEvent("change");

  await page.locator('.schema-control-section[data-section="streaming"] summary').click();
  const maxNodes = page.locator("#max-nodes-value");
  await maxNodes.fill("8");
  await maxNodes.dispatchEvent("change");
  await expect(code).toHaveText(initialCode ?? "");
  await expect(codeSummary).toContainText("pending edits");

  await page.locator("#apply-settings").click();
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");
  await expect(code).toContainText("maxNodes: 8");
  await expect(code).toContainText("pointSize: 7");
  await expect(code).toContainText("maxRenderedPoints: 50000");
  await expect(codeSummary).toContainText("up to date");
  await expect(page.locator("#copy-code")).toBeVisible();
  await expect(page.locator("#copy-share-link")).toBeVisible();
  await expect(page.locator("#install-guidance-label")).toBeHidden();

  await page.evaluate(() => {
    const target = window as Window & { __copiedText?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { target.__copiedText = value; } },
    });
  });
  await page.locator("#copy-share-link").click();
  await expect(page.locator("#share-status")).toHaveText("Share link copied.");
  const shareLink = await page.evaluate(
    () => (window as Window & { __copiedText?: string }).__copiedText,
  );
  expect(shareLink).toMatch(/^https?:\/\//u);
  expect(pageErrors).toEqual([]);
  expect(shareLink).toContain("backend=copc-js");
  expect(shareLink).toContain("pointSize=7");
  expect(shareLink).toContain("maxNodes=8");
  expect(shareLink).toContain("maxRenderedPoints=50000");
  expect(shareLink).not.toContain("source=");

  await page.goto(shareLink ?? "/");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");
  await expect(page.locator("#point-size-value")).toHaveValue("7");
  await expect(page.locator("#max-nodes-value")).toHaveValue("8");
  await expect(page.locator("#max-points-value")).toHaveValue("50000");
  await expect(page.locator("#integration-example")).toContainText("maxRenderedPoints: 50000");

  const rendererGroup = page.getByRole("radiogroup", { name: "Renderer", exact: true });
  await rendererGroup.getByRole("radio", { name: "Three.js" }).click();
  await expect(codeSummary).toContainText("pending edits");
  await expect(code).toContainText("CopcCesiumLayer");
  await page.locator("#apply-settings").click();
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer))
    .toBe("three");
  await expect(code).toContainText("CopcThreeLayer");
  await expect(code).not.toContainText("CopcCesiumLayer");
  await expect(codeSummary).toContainText("up to date");
  expect(pageErrors).toEqual([]);
});

test("shares Advanced attribute and coordinate-cache policies", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const params = new URLSearchParams({
    backend: "copc-js",
    colorMode: "rgb",
    pointSize: "7",
    maxNodes: "8",
    maxRenderedPoints: "50000",
    attributeLoading: "required",
    coordinateCacheLayout: "E",
    retainSourceCoordinatesForQueries: "true",
  });
  params.set("pointFields", JSON.stringify(["intensity"]));
  await page.goto("/?" + params.toString());
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  const code = page.locator("#integration-example");
  await expect(page.locator("#point-size-value")).toHaveValue("7");
  await expect(page.locator("#max-nodes-value")).toHaveValue("8");
  await expect(page.locator("#max-points-value")).toHaveValue("50000");
  await expect(code).toContainText("attributeLoading: 'required'");
  await expect(code).toContainText("colorMode: 'rgb'");
  await expect(code).toContainText("pointFields: new Set(['intensity'] as const)");
  await expect(code).not.toContainText("coordinateCacheLayout");
  await page.locator("#code-mode-explicit").click();
  await expect(code).toContainText("coordinateCacheLayout: 'E'");
  await expect(code).toContainText("retainSourceCoordinatesForQueries: true");

  await page.locator('.schema-control-section[data-section="attributes"] summary').click();
  await expect(page.locator("#schema-attribute-loading")).toHaveValue("required");
  await expect(page.locator("#schema-point-field-intensity")).toBeChecked();
  await expect(page.locator(".schema-special-attribute-loading .schema-option__hint"))
    .toContainText("Pending style and filter fields: Position, RGB");
  await expect(page.locator(".schema-special-attribute-loading .schema-option__hint"))
    .toContainText("Pick metadata can include: Position, RGB, Intensity");
  await page.locator('.schema-control-section[data-section="cache"] summary').click();
  await expect(page.locator('[data-option-id="cache.coordinateCacheLayout"] select'))
    .toHaveValue("E");
  await expect(page.locator('[data-option-id="cache.retainSourceCoordinatesForQueries"] input[type="checkbox"]'))
    .toBeChecked();

  await page.evaluate(() => {
    const target = window as Window & { __copiedText?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { target.__copiedText = value; } },
    });
  });
  await page.locator("#copy-share-link").click();
  await expect(page.locator("#share-status")).toHaveText("Share link copied.");
  const shareLink = await page.evaluate(
    () => (window as Window & { __copiedText?: string }).__copiedText,
  );
  expect(shareLink).toMatch(/^https?:\/\//u);
  expect(shareLink).toContain("attributeLoading=required");
  expect(new URL(shareLink!).searchParams.get("pointFields")).toBe('["intensity"]');
  expect(shareLink).toContain("coordinateCacheLayout=E");
  expect(shareLink).toContain("retainSourceCoordinatesForQueries=true");
  expect(shareLink).not.toContain("source=");
  expect(pageErrors).toEqual([]);
});

test("keeps the last successful snippet when applying an unreachable source fails", async ({
  page,
}) => {
  await page.route("https://failed.example/**", (route) => route.abort());
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  const code = page.locator("#integration-example");
  const previousCode = await code.textContent();
  const codeSummary = page.locator("#workbench-panel-code .summary-state");
  await page.locator("#source-selection").selectOption("custom");
  await page.locator("#custom-source-url").fill("https://failed.example/broken.copc.laz");
  await page.locator("#load-source").click();

  await expect(page.locator("#configuration-error")).toBeVisible();
  await expect(code).toHaveText(previousCode ?? "");
  await expect(codeSummary).toContainText("pending edits");
  await expect(page.locator("#copy-code")).toBeEnabled();
});

test("applies Focus Lens to the active Cesium session through its runtime operation", async ({
  page,
}) => {
  await page.goto("/?debugPanel=0");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  await page.locator('.schema-control-section[data-section="focus"] summary').click();
  await page.locator("#schema-focus-enabled").check();
  const applyButton = page.locator("#apply-settings");
  await expect(applyButton).toBeEnabled();
  await applyButton.click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__COPC_DEV_VIEWER__?.getSnapshot()?.performance.refinementFocusEnabled,
      ),
    )
    .toBe(true);
});

test("a rejected schema edit blocks Dev Viewer Apply until corrected", async ({ page }) => {
  await page.goto("/?debugPanel=0");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  const pointSize = page.locator("#point-size-value");
  await pointSize.fill("4");
  await pointSize.dispatchEvent("change");
  const applyButton = page.locator("#apply-settings");
  await expect(applyButton).toBeEnabled();

  await page.locator('.schema-control-section[data-section="streaming"] summary').click();
  const maxNodes = page.locator("#max-nodes-value");
  await maxNodes.fill("0");
  await maxNodes.dispatchEvent("change");
  await expect(maxNodes).toHaveAttribute("aria-invalid", "true");
  await expect(applyButton).toBeDisabled();

  await maxNodes.fill("32");
  await maxNodes.dispatchEvent("change");
  await expect(maxNodes).not.toHaveAttribute("aria-invalid", "true");
  await expect(applyButton).toBeEnabled();
});

test("refreshes Dev Viewer validation after a corrected cross-field value", async ({ page }) => {
  await page.goto("/?debugPanel=0");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.lifecycle))
    .toBe("ready");

  await page.locator("#point-size-mode").selectOption("attenuated");
  const minimumPointSize = page.locator("#min-point-size");
  const applyButton = page.locator("#apply-settings");
  await minimumPointSize.fill("13");
  await minimumPointSize.dispatchEvent("change");
  await expect(minimumPointSize).toHaveAttribute("aria-invalid", "true");
  await expect(applyButton).toBeDisabled();

  await minimumPointSize.fill("1");
  await minimumPointSize.dispatchEvent("change");
  await expect(minimumPointSize).not.toHaveAttribute("aria-invalid", "true");
  await expect(applyButton).toBeEnabled();
});
