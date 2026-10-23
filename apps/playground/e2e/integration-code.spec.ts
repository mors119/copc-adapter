import { expect, test } from "@playwright/test";

type RefinementConfig = {
  algorithm: "foveated" | "screen-projection";
  focusMode: "auto-center" | "center-boost" | "follow-pointer" | "pinned";
  focusEnabled: boolean;
  showGuide: boolean;
  center: { x: number; y: number };
  radius: number;
  detailBias: number;
};

const config = (renderer: "cesium" | "three" = "cesium") => ({
  renderer,
  backend: "copc-js" as const,
  colorMode: "elevation" as const,
  pointSize: 3,
  maxNodes: 24,
  maxRenderedPoints: 250_000,
  refinementAlgorithm: "foveated" as const,
  refinementConfig: {
    algorithm: "foveated" as const,
    focusMode: "auto-center" as const,
    focusEnabled: false,
    showGuide: true,
    center: { x: 0.5, y: 0.5 },
    radius: 0.15,
    detailBias: 1.5,
  },
});

function makeCopcProbeBody(): Buffer {
  const bytes = Buffer.alloc(1024);
  bytes.write("LASF", 0, "ascii");
  bytes.writeUInt16LE(375, 94);
  bytes.writeUInt32LE(589, 96);
  bytes.writeUInt32LE(1, 100);
  bytes.write("copc", 377, "ascii");
  bytes.writeUInt16LE(1, 393);
  bytes.writeUInt16LE(160, 395);
  return bytes;
}

async function generatedCode(
  page: import("@playwright/test").Page,
  options: Record<string, unknown>,
): Promise<string> {
  return page.evaluate((input) => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          generateIntegrationCode(options: Record<string, unknown>): string;
        };
      }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    return hooks.generateIntegrationCode(input);
  }, options);
}

test("generates deterministic public Cesium and Three.js snippets with defaults and style state", async ({ page }) => {
  await page.goto("./");

  const cesiumCode = await generatedCode(page, {
    config: { ...config(), colorMode: "classification", backend: "rust", maxNodes: 32 },
    adapterVersion: "0.6.0",
    mode: "explicit",
  });
  expect(cesiumCode).toContain("@frillab/copc-adapter/cesium");
  expect(cesiumCode).toContain("backend: 'rust'");
  expect(cesiumCode).toContain("colorMode: 'classification'");
  expect(cesiumCode).toContain("maxPointCacheBytes: 268435456");
  expect(cesiumCode).toContain("maxDepth: 6");
  expect(cesiumCode).not.toMatch(/packages\/(?:core|cesium|three)\//u);
  expect(cesiumCode).toBe(
    await generatedCode(page, {
      config: { ...config(), colorMode: "classification", backend: "rust", maxNodes: 32 },
      adapterVersion: "0.6.0",
      mode: "explicit",
    }),
  );

  const threeCode = await generatedCode(page, {
    config: { ...config("three"), backend: "rust", maxDepth: 7, maxScreenSpaceError: 6, maxRenderDistanceMeters: 20_000 },
    adapterVersion: "0.6.0",
    mode: "minimal",
  });
  expect(threeCode).toContain("@frillab/copc-adapter/three");
  expect(threeCode).toContain("OrbitControls");
  expect(threeCode).toContain("await layer.update()");
  expect(threeCode).toContain("maxDepth: 7");
  expect(threeCode).toContain("maxScreenSpaceError: 6");
  expect(threeCode).toContain("maxRenderDistanceMeters: 20000");
  expect(threeCode).not.toContain("setStyle");
  expect(threeCode).not.toMatch(/packages\/(?:core|cesium|three)\//u);

  const minimalDefaults = await generatedCode(page, {
    config: config(),
    adapterVersion: "0.6.0",
    mode: "minimal",
  });
  expect(minimalDefaults).not.toContain("pointSize:");
  expect(minimalDefaults).not.toContain("maxPointCacheBytes:");
  expect(minimalDefaults).toContain("colorMode: 'elevation'");

  for (const colorMode of ["fixed", "rgb", "elevation", "intensity", "classification"] as const) {
    const code = await generatedCode(page, {
      config: { ...config(), colorMode },
      adapterVersion: "0.6.0",
      mode: "explicit",
    });
    expect(code).toContain(`colorMode: '${colorMode}'`);
  }
});

test("generates Cesium classification include, exclude, and clear calls after attachment", async ({ page }) => {
  await page.goto("./");
  for (const [filter, expected] of [
    [{ include: [2, 6] }, 'classificationFilter: {"include":[2,6]}'],
    [{ exclude: [7] }, 'classificationFilter: {"exclude":[7]}'],
    [null, "classificationFilter: null"],
  ] as const) {
    const code = await generatedCode(page, {
      config: { ...config(), classificationFilter: filter },
      adapterVersion: "0.6.0",
    });
    expect(code).toContain("layer.setStyle({");
    expect(code.indexOf("layer.attachTo(viewer)")).toBeLessThan(code.indexOf("layer.setStyle({"));
    expect(code).toContain(expected);
  }

  await expect(
    generatedCode(page, {
      config: { ...config("three"), classificationFilter: { include: [2] } },
      adapterVersion: "0.6.0",
    }),
  ).rejects.toThrow(/no public classification style setter/u);
});

test("escapes URL strings and protects sensitive URLs; files use a file input pattern", async ({ page }) => {
  await page.goto("./");
  const source = "https://example.com/a\\b?token=one'\nsecond";
  const placeholder = await generatedCode(page, {
    config: config(),
    source,
    adapterVersion: "0.6.0",
  });
  expect(placeholder).toContain("https://example.com/data.copc.laz");
  expect(placeholder).not.toContain("token=one");

  const exact = await generatedCode(page, {
    config: config(),
    source,
    includeExactSource: true,
    adapterVersion: "0.6.0",
  });
  expect(exact).toContain("token=one\\'\\nsecond");

  const fileCode = await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          generateIntegrationCode(options: Record<string, unknown>): string;
        };
      }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    return hooks.generateIntegrationCode({
      config: {
        renderer: "cesium",
        backend: "copc-js",
        colorMode: "elevation",
        pointSize: 3,
        maxNodes: 24,
        maxRenderedPoints: 250_000,
        refinementAlgorithm: "foveated",
        refinementConfig: {
          algorithm: "foveated",
          focusMode: "auto-center",
          focusEnabled: false,
          showGuide: true,
          center: { x: 0.5, y: 0.5 },
          radius: 0.15,
          detailBias: 1.5,
        },
      },
      source: new File(["local bytes"], "area.copc.laz"),
      adapterVersion: "0.6.0",
    });
  });
  expect(fileCode).toContain("document.querySelector<HTMLInputElement>('#copc-file-input')");
  expect(fileCode).toContain("url: sourceFile");
  expect(fileCode).not.toContain("area.copc.laz");
});

test("normalizes share configuration, omits unsafe sources, and copies the visible code", async ({ page }) => {
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { copied = value; } },
    });
    (window as Window & { __getCopiedText?: () => string }).__getCopiedText = () => copied;
  });
  await page.goto("./");

  const normalized = await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          readUrlConfig(query: string): { config: Record<string, unknown>; sourceUrl?: string };
          writeUrlConfig(config: Record<string, unknown>, refinement: RefinementConfig, source?: string): string;
        };
      }
    ).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable");
    const parsed = hooks.readUrlConfig("renderer=bad&backend=rust&colorMode=intensity&pointSize=7&maxNodes=32&maxRenderedPoints=500000&sourceUrl=https%3A%2F%2Fexample.com%2Fdata.copc.laz%3Ftoken%3Dsecret");
    const safeSource = "https://example.com/public/data.copc.laz";
    const settings = {
      renderer: "three",
      backend: "rust",
      colorMode: "intensity",
      pointSize: 7,
      maxNodes: 32,
      maxRenderedPoints: 500_000,
      refinementAlgorithm: "foveated",
    };
    const refinement = {
      algorithm: "foveated",
      focusMode: "auto-center",
      focusEnabled: false,
      showGuide: true,
      center: { x: 0.5, y: 0.5 },
      radius: 0.15,
      detailBias: 1.5,
    };
    const written = hooks.writeUrlConfig(
      settings,
      refinement,
      "https://example.com/data.copc.laz?token=secret",
    );
    const repeatedWrite = hooks.writeUrlConfig(settings, refinement);
    const safeWrite = hooks.writeUrlConfig(settings, refinement, safeSource);
    const safeParse = hooks.readUrlConfig(safeWrite);
    return { parsed, written, repeatedWrite, safeWrite, safeParse };
  });
  expect(normalized.parsed.config.renderer).toBe("cesium");
  expect(normalized.parsed.sourceUrl).toBeUndefined();
  expect(normalized.parsed.warning).toContain("ignored for privacy");
  expect(normalized.written).not.toContain("token");
  expect(normalized.repeatedWrite).toBe(normalized.written);
  expect(normalized.safeWrite).toContain("sourceUrl=https%3A%2F%2Fexample.com%2Fpublic%2Fdata.copc.laz");
  expect(normalized.safeParse.config.renderer).toBe("three");
  expect(normalized.safeParse.sourceUrl).toBe("https://example.com/public/data.copc.laz");

  await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: { useCameraResetLayerMock(): void };
      }
    ).__COPC_PLAYGROUND_TEST__;
    hooks?.useCameraResetLayerMock();
  });
  await page.locator("#copc-file").setInputFiles({
    name: "copy-test.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("local test source"),
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded copy-test.copc.laz");
  await page.getByRole("button", { name: "Explicit" }).click();
  const visibleCode = await page.locator("#integration-example").textContent();
  expect(visibleCode).toContain("url: sourceFile");
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe(visibleCode);
  const installText = await page.locator("#install-command").textContent();
  expect(installText).toBe("npm install @frillab/copc-adapter cesium");
  await page.locator("#copy-install").click();
  await expect(page.locator("#copy-install")).toHaveText("Copied");
  expect(await page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.())).toBe(installText);
  await expect(page.locator("#include-share-source")).toBeDisabled();
  await page.getByRole("button", { name: "Copy share link" }).click();
  await expect(page.locator("#copy-share-link")).toHaveText("Copied");
  const shareLink = await page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.());
  expect(shareLink).not.toContain("sourceUrl=");
  expect(shareLink).toContain("renderer=cesium");

  await page.getByRole("radiogroup", { name: "COPC backend" }).getByRole("radio", { name: "Rust / WASM" }).click();
  await expect(page.locator("#source-status")).toHaveText("Loaded copy-test.copc.laz");
  await page.locator("#point-size").evaluate((element: HTMLInputElement) => {
    element.value = "7";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded copy-test.copc.laz");
  await page.locator("#copy-share-link").click();
  const configuredShareLink = await page.evaluate(() => (window as Window & { __getCopiedText?: () => string }).__getCopiedText?.());
  expect(configuredShareLink).toContain("backend=rust");
  expect(configuredShareLink).toContain("pointSize=7");

  await page.goto(configuredShareLink!);
  await expect(page.getByRole("radiogroup", { name: "COPC backend" }).getByRole("radio", { name: "Rust / WASM" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("slider", { name: "Point size" })).toHaveValue("7");
  await expect(page.locator("#source-status")).toHaveText("Waiting for a source");
});

test("generated code follows successful applies and ignores slider previews", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: { useCameraResetLayerMock(): void };
      }
    ).__COPC_PLAYGROUND_TEST__;
    hooks?.useCameraResetLayerMock();
  });
  await page.locator("#copc-file").setInputFiles({
    name: "active-config.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("local test source"),
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded active-config.copc.laz");
  await page.getByRole("button", { name: "Explicit" }).click();
  const initialCode = await page.locator("#integration-example").textContent();

  await page.locator("#point-size").evaluate((element: HTMLInputElement) => {
    element.value = "7";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#integration-example")).toHaveText(initialCode!);

  await page.locator("#point-size").evaluate((element: HTMLInputElement) => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded active-config.copc.laz");
  await expect(page.locator("#integration-example")).toContainText("pointSize: 7");
});

test("warns before copying a sensitive active URL and excludes it from share links", async ({ page }) => {
  let copied = "";
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __copiedText?: string }).__copiedText = value;
        },
      },
    });
  });
  await page.route("https://example.com/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "Range",
          "access-control-expose-headers": "Content-Range, Content-Length",
        },
      });
      return;
    }
    await route.fulfill({
      status: 206,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "Range",
        "access-control-expose-headers": "Content-Range, Content-Length",
        "content-range": "bytes 0-1023/8192",
        "content-length": "1024",
      },
      body: makeCopcProbeBody(),
    });
  });
  await page.goto("./");
  await page.evaluate(() => {
    const hooks = (
      window as Window & {
        __COPC_PLAYGROUND_TEST__?: { useCameraResetLayerMock(): void };
      }
    ).__COPC_PLAYGROUND_TEST__;
    hooks?.useCameraResetLayerMock();
  });
  await page.locator("#remote-source").selectOption("custom");
  await page.locator("#custom-url").fill("https://example.com/data.copc.laz?token=secret");
  await page.getByRole("button", { name: "Probe and load URL" }).click();
  await expect(page.locator("#source-status")).toHaveText("Loaded Custom URL");
  await expect(page.locator("#source-code-warning")).toContainText("may contain credentials or tokens");
  await expect(page.locator("#integration-example")).not.toContainText("token=secret");
  await expect(page.locator("#include-share-source")).toBeDisabled();

  await page.locator("#include-exact-source").check();
  await expect(page.locator("#integration-example")).toContainText("token=secret");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.locator("#share-status")).toContainText("Copy cancelled");
  copied = await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText ?? "");
  expect(copied).toBe("");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.locator("#copy-code")).toHaveText("Copied");
  copied = await page.evaluate(() => (window as Window & { __copiedText?: string }).__copiedText ?? "");
  expect(copied).toContain("token=secret");
});
