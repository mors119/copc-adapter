import { expect, test } from "@playwright/test";

type PlaygroundTestHooks = {
  useCameraResetLayerMock(): void;
  delayNextLoad(): void;
  failNextLoad(): void;
  releaseDelayedLoad(): void;
  getMockLoadCount(): number;
  getMockLayerCreateCount(): number;
  getAppliedConfig(): { maxDepth?: number } | undefined;
  getMockRefinementAlgorithm(): string | undefined;
  getMockFocusUpdateCount(): number;
  getMockRefinementFocus():
    | {
        type: "screen-circle";
        center: { x: number; y: number };
        radius: number;
        detailBias: number;
      }
    | undefined;
  getSnapshot():
    | {
        refinementAlgorithm?: string;
        refinementFocusEnabled?: boolean;
        focusCandidateCount?: number;
        focusInfluencedRefinementCount?: number;
        selectedNodeKeys?: readonly string[];
      }
    | undefined;
  getCameraView(): {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  setCameraView(view: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  }): void;
  getCameraInputsEnabled(): boolean | undefined;
};

async function useMockLayer(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    const hooks = (
      window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    hooks.useCameraResetLayerMock();
  });
}

async function openLodOptions(
  page: import("@playwright/test").Page,
): Promise<void> {
  const section = page.locator('details[data-section="lod"]');
  if (!(await section.evaluate((element: HTMLDetailsElement) => element.open))) {
    await section.locator("summary").click();
  }
}

async function selectRefinementAlgorithm(
  page: import("@playwright/test").Page,
  value: "foveated" | "screen-projection",
): Promise<void> {
  await page
    .getByRole("radiogroup", { name: "Refinement Algorithm" })
    .getByRole("radio", {
      name: value === "foveated" ? "Foveated" : "Screen Projection",
    })
    .click();
}

async function expectRefinementAlgorithm(
  page: import("@playwright/test").Page,
  value: "foveated" | "screen-projection",
): Promise<void> {
  await expect(
    page
      .getByRole("radiogroup", { name: "Refinement Algorithm" })
      .getByRole("radio", {
        name: value === "foveated" ? "Foveated" : "Screen Projection",
      }),
  ).toHaveAttribute("aria-checked", "true");
}

async function loadFile(
  page: import("@playwright/test").Page,
  name = "focus-test.copc.laz",
): Promise<void> {
  await page.locator("#copc-file").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from("test source"),
  });
  await expect(page.locator("#source-status")).toHaveText(`Loaded ${name}`);
}

test("algorithm selection applies the actual constructor option and survives URL/code generation", async ({
  page,
}) => {
  await page.goto("./");
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page, "algorithm.copc.laz");

  const initialCreates = await page.evaluate(
    () =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount() ?? 0,
  );
  await selectRefinementAlgorithm(page, "screen-projection");
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeEnabled();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#source-status")).toHaveText(
    "Loaded algorithm.copc.laz",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementAlgorithm(),
      ),
    )
    .toBe("screen-projection");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount(),
      ),
    )
    .toBe(initialCreates + 1);
  await expect(page.locator("#integration-example")).toContainText(
    "refinementAlgorithm: 'screen-projection'",
  );
  await expect(page).toHaveURL(/refinementAlgorithm=screen-projection/);

  await selectRefinementAlgorithm(page, "foveated");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementAlgorithm(),
      ),
    )
    .toBe("foveated");
  await expect(page).toHaveURL(/refinementAlgorithm=foveated/);
});

test("failed constructor changes keep the last successfully applied API example", async ({
  page,
}) => {
  await page.goto("./");
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page, "failed-apply.copc.laz");
  await page.getByRole("button", { name: "Explicit" }).click();

  const appliedExample = await page.locator("#integration-example").textContent();
  expect(appliedExample).toContain("refinementAlgorithm: 'foveated'");

  await page.evaluate(() => {
    const hooks = (
      window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    hooks.failNextLoad();
  });
  await selectRefinementAlgorithm(page, "screen-projection");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#source-status")).toHaveAttribute(
    "data-status",
    "error",
  );
  await expect(page.locator("#integration-example")).toHaveText(appliedExample!);
  await expect(page).toHaveURL(/refinementAlgorithm=screen-projection/);
});

test("superseded constructor reloads cannot replace the applied API example", async ({
  page,
}) => {
  await page.goto("./");
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page, "superseded-apply.copc.laz");
  await page.getByRole("button", { name: "Explicit" }).click();

  await page.evaluate(() => {
    const hooks = (
      window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    hooks.delayNextLoad();
  });
  await selectRefinementAlgorithm(page, "screen-projection");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#source-status")).toContainText("Loading");

  await selectRefinementAlgorithm(page, "foveated");
  await expect(page.locator("#source-status")).toHaveText(
    "Loaded superseded-apply.copc.laz",
  );
  await expect(page.locator("#integration-example")).toContainText(
    "refinementAlgorithm: 'foveated'",
  );

  await page.evaluate(() => {
    const hooks = (
      window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
    ).__COPC_PLAYGROUND_TEST__;
    hooks?.releaseDelayedLoad();
  });
  await expect(page.locator("#integration-example")).toContainText(
    "refinementAlgorithm: 'foveated'",
  );
});

test("follow-pointer movement does not cancel a pending constructor replacement", async ({ page }) => {
  await page.goto("./");
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page, "follow-pointer-replacement.copc.laz");
  await page.locator("#focus-mode").selectOption("follow-pointer");
  await page.evaluate(() => {
    const hooks = (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    hooks.delayNextLoad();
  });
  await page.locator("#max-depth-value").fill("7");
  await page.locator("#max-depth-value").dispatchEvent("change");
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#source-status")).toContainText("Loading");

  const pointer = await page.evaluate(async () => {
    const host = [...document.querySelectorAll<HTMLElement>(".runtime-host")]
      .find((item) => getComputedStyle(item).visibility === "visible");
    const canvas = host?.querySelector("canvas");
    if (!canvas) throw new Error("Visible Cesium canvas is unavailable");
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * 0.65;
    const y = rect.top + rect.height * 0.35;
    canvas.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true,
      clientX: x,
      clientY: y,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
  });
  await expect(page.locator("#source-status")).toContainText("Loading");
  await page.evaluate(() => {
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.releaseDelayedLoad();
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded follow-pointer-replacement.copc.laz");
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getAppliedConfig()?.maxDepth,
  )).toBe(7);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
  )).toBeCloseTo(pointer.x, 1);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks })
      .__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.y,
  )).toBeCloseTo(pointer.y, 1);
});

test("focus modes update the active Cesium layer without recreating it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("./");
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page);
  const initialLoads = await page.evaluate(
    () =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLoadCount() ?? 0,
  );
  const initialCreates = await page.evaluate(
    () =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount() ?? 0,
  );

  await page.locator("#focus-mode").selectOption("center-boost");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus(),
      ),
    )
    .toMatchObject({
      type: "screen-circle",
      center: { x: 0.5, y: 0.5 },
    });
  const updateCountBeforeGuide = await page.evaluate(
    () =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockFocusUpdateCount() ?? 0,
  );
  await page.locator("#focus-show-guide").uncheck();
  await expect(page.locator("#focus-guide")).toBeHidden();
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockFocusUpdateCount(),
    ),
  ).toBe(updateCountBeforeGuide);

  await page.locator("#focus-radius").evaluate((element: HTMLInputElement) => {
    element.value = "26";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#focus-bias").evaluate((element: HTMLInputElement) => {
    element.value = "2";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.radius,
      ),
    )
    .toBe(0.26);

  await page.locator("#focus-enabled").uncheck();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus(),
      ),
    )
    .toBeUndefined();
  await page.locator("#focus-enabled").check();
  await page.locator("#focus-mode").selectOption("follow-pointer");

  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
  await page.mouse.move(
    canvasBounds.left + canvasBounds.width * 0.73,
    canvasBounds.top + canvasBounds.height * 0.31,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
      ),
    )
    .toBeCloseTo(0.73, 2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.y,
      ),
    )
    .toBeCloseTo(0.31, 2);
  await page.mouse.move(
    canvasBounds.left + canvasBounds.width * 0.22,
    canvasBounds.top + canvasBounds.height * 0.72,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
      ),
    )
    .toBeCloseTo(0.22, 2);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.y,
      ),
    )
    .toBeCloseTo(0.72, 2);
  await expect(page).toHaveURL(/focusMode=follow-pointer/);
  await expect(page).toHaveURL(/focusX=0.5000/);

  await page.locator("#focus-mode").selectOption("pinned");
  await page.locator("#focus-show-guide").check();
  await expect(page.locator("#focus-guide")).toBeVisible();
  await page.locator("#focus-x").fill("0.61");
  await page.locator("#focus-x").dispatchEvent("change");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
      ),
    )
    .toBe(0.61);

  const previousLoads = await page.evaluate(
    () =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLoadCount() ?? 0,
  );
  const handle = page.locator("#focus-guide .focus-guide-handle");
  await handle.scrollIntoViewIfNeeded();
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error("Focus handle is not visible.");
  const handlePoint = {
    x: handleBounds.x + handleBounds.width / 2,
    y: handleBounds.y + handleBounds.height / 2,
  };
  const pointerTarget = await page.evaluate((point) => {
    const target = document.elementFromPoint(point.x, point.y);
    const handleElement = document.querySelector<HTMLElement>(
      "#focus-guide-handle",
    );
    return {
      targetTag: target?.tagName,
      targetId: target?.id,
      targetClass: target?.className,
      handlePointerEvents: handleElement
        ? getComputedStyle(handleElement).pointerEvents
        : undefined,
      handleHidden: handleElement
        ?.closest("#focus-guide")
        ?.hasAttribute("hidden"),
    };
  }, handlePoint);
  expect(pointerTarget).toMatchObject({
    targetTag: "BUTTON",
    targetId: "focus-guide-handle",
    handlePointerEvents: "auto",
    handleHidden: false,
  });
  await page.mouse.move(handlePoint.x, handlePoint.y);
  await page.mouse.down();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getCameraInputsEnabled(),
      ),
    )
    .toBe(false);
  await page.mouse.move(handlePoint.x + 140, handlePoint.y + 25);
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getCameraInputsEnabled(),
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
      ),
    )
    .toBeGreaterThan(0.75);
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLoadCount(),
    ),
  ).toBe(previousLoads);

  await page.locator("#focus-guide-handle").focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks;
            }
          ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus()?.center.x,
      ),
    )
    .toBeGreaterThan(0.75);

  await page.locator("#focus-mode").selectOption("auto-center");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus(),
      ),
    )
    .toBeUndefined();
  await expect(page).toHaveURL(/refinementAlgorithm=foveated/);
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLoadCount(),
    ),
  ).toBe(initialLoads);
  expect(
    await page.evaluate(() =>
      (
        window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
      ).__COPC_PLAYGROUND_TEST__?.getMockLayerCreateCount(),
    ),
  ).toBe(initialCreates);
});

test("URL focus settings restore the guide, radius, bias, and public API snippet", async ({
  page,
}) => {
  await page.goto(
    "./?refinementAlgorithm=screen-projection&focusMode=pinned&focusEnabled=true&showFocusGuide=false&focusX=0.7&focusY=0.3&focusRadius=0.22&focusBias=1.8",
  );
  await openLodOptions(page);
  await useMockLayer(page);
  await loadFile(page, "shared-focus.copc.laz");

  await expectRefinementAlgorithm(page, "screen-projection");
  await expect(page.locator("#focus-mode")).toHaveValue("pinned");
  await expect(page.locator("#focus-enabled")).toBeChecked();
  await expect(page.locator("#focus-show-guide")).not.toBeChecked();
  await expect(page.locator("#focus-radius")).toHaveValue("22");
  await expect(page.locator("#focus-bias")).toHaveValue("1.8");
  await expect(page.locator("#integration-example")).toContainText(
    "refinementAlgorithm: 'screen-projection'",
  );
  await expect(page.locator("#integration-example")).toContainText(
    "layer.setRefinementFocus",
  );
  await expect(page.locator("#integration-example")).toContainText(
    "center: { x: 0.7, y: 0.3 }",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __COPC_PLAYGROUND_TEST__?: PlaygroundTestHooks }
        ).__COPC_PLAYGROUND_TEST__?.getMockRefinementFocus(),
      ),
    )
    .toMatchObject({
      center: { x: 0.7, y: 0.3 },
      radius: 0.22,
      detailBias: 1.8,
    });

  await page.reload();
  await openLodOptions(page);
  await expectRefinementAlgorithm(page, "screen-projection");
  await expect(page.locator("#focus-mode")).toHaveValue("pinned");
  await expect(page.locator("#focus-radius")).toHaveValue("22");
});

test("unknown algorithm query values are reported instead of silently accepted", async ({
  page,
}) => {
  await page.goto("./?refinementAlgorithm=unknown-next-algorithm");
  await openLodOptions(page);
  await expectRefinementAlgorithm(page, "foveated");
  await expect(page.locator("#focus-config-warning")).toContainText(
    "Unknown refinement algorithm",
  );
});
