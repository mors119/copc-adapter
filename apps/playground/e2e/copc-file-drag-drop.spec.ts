import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const autzenFixture = fileURLToPath(
  new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
);
const autzenFixtureAvailable = existsSync(autzenFixture);

type DragFile = string | {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
};

async function installFileTransfer(
  page: Page,
  files: DragFile | readonly DragFile[],
): Promise<void> {
  await page.evaluate(() => {
    document.querySelector("#copc-drag-test-input")?.remove();
    const input = document.createElement("input");
    input.id = "copc-drag-test-input";
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#copc-drag-test-input").setInputFiles(files as never);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#copc-drag-test-input");
    if (!input?.files?.length) throw new Error("The browser test file was not installed.");
    const transfer = new DataTransfer();
    for (const file of Array.from(input.files)) transfer.items.add(file);
    (window as Window & { __COPC_DRAG_TEST_TRANSFER__?: DataTransfer })
      .__COPC_DRAG_TEST_TRANSFER__ = transfer;
  });
}

async function dispatchDrag(
  page: Page,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  selector = "body",
  coordinates?: { readonly x: number; readonly y: number },
): Promise<boolean> {
  return page.evaluate(({ eventType, targetSelector, x, y }) => {
    const transfer = (window as Window & {
      __COPC_DRAG_TEST_TRANSFER__?: DataTransfer;
    }).__COPC_DRAG_TEST_TRANSFER__;
    const target = document.querySelector(targetSelector);
    if (!transfer || !target) throw new Error("The browser drag fixture is unavailable.");
    const event = new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, {
    eventType: type,
    targetSelector: selector,
    x: coordinates?.x ?? 20,
    y: coordinates?.y ?? 20,
  });
}

async function pagePointCount(page: Page): Promise<number> {
  return Number(
    (await page.locator("#diagnostic-points").textContent())?.replaceAll(",", "") ?? 0,
  );
}

test("local COPC drops load and render in Cesium and Three without uploads", async ({ page }) => {
  test.skip(!autzenFixtureAvailable, "Download the Autzen COPC fixture with npm run download-samples -- autzen.");
  test.setTimeout(240_000);
  const uploadRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT"].includes(request.method().toUpperCase())) {
      uploadRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto("./");
  const renderer = page.getByRole("radiogroup", { name: "Renderer" });
  await renderer.getByRole("radio", { name: "Three.js" }).click();
  await installFileTransfer(page, autzenFixture);
  await dispatchDrag(page, "dragenter", "#app");
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragover", "#source-panel");
  expect(await dispatchDrag(page, "drop", "#app")).toBe(true);
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
  await expect(page.locator("#source-status")).toHaveText(
    "Loaded autzen.copc.laz",
    { timeout: 120_000 },
  );
  await expect(page.locator("#metadata-point-count")).not.toHaveText("Not available");
  await expect(page.locator("#metadata-renderer")).toHaveText("Three.js");
  await page.getByRole("tab", { name: "Health" }).click();
  await expect.poll(() => pagePointCount(page), { timeout: 60_000 }).toBeGreaterThan(0);

  const ordinaryLaz = Buffer.alloc(1024);
  ordinaryLaz.write("LASF", 0, "ascii");
  ordinaryLaz.writeUInt16LE(375, 94);
  ordinaryLaz.writeUInt32LE(589, 96);
  ordinaryLaz.writeUInt32LE(1, 100);
  await installFileTransfer(page, {
    name: "ordinary-no-hierarchy.laz",
    mimeType: "application/octet-stream",
    buffer: ordinaryLaz,
  });
  await dispatchDrag(page, "dragenter", "#app");
  expect(await dispatchDrag(page, "drop", "#app")).toBe(true);
  await expect(page.locator("#source-status")).toContainText(
    "Could not load ordinary-no-hierarchy.laz",
  );
  await expect(page.locator("#source-status")).toContainText(
    "The previous layer is still active.",
  );
  await expect(page.locator("#metadata-point-count")).not.toHaveText("Not available");
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();

  await renderer.getByRole("radio", { name: "Cesium" }).click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.locator("#source-status")).toHaveText(
    "Loaded autzen.copc.laz",
    { timeout: 120_000 },
  );
  await expect(page.locator("#metadata-renderer")).toHaveText("Cesium");
  await page.getByRole("tab", { name: "Health" }).click();
  await expect.poll(() => pagePointCount(page), { timeout: 60_000 }).toBeGreaterThan(0);
  expect(uploadRequests).toEqual([]);
});

test("drop lifecycle handles nested and page-leave events without intercepting text or URL drags", async ({ page }) => {
  await page.goto("./");
  await installFileTransfer(page, {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a COPC"),
  });
  await dispatchDrag(page, "dragenter", "body");
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragenter", "#source-panel");
  await dispatchDrag(page, "dragleave", "body");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragleave", "#source-panel", { x: -1, y: 40 });
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();

  await dispatchDrag(page, "dragenter", "#app");
  expect(await dispatchDrag(page, "drop", "#app")).toBe(true);
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
  await expect(page.locator("#source-status")).toContainText("Unsupported file type");
  await expect(page.locator("#copc-file")).toBeAttached();

  const textAndUrlDefaults = await page.evaluate(() => {
    const results: boolean[] = [];
    for (const [type, value] of [
      ["text/plain", "selected text"],
      ["text/uri-list", "https://example.com/"],
    ]) {
      const transfer = new DataTransfer();
      transfer.setData(type, value);
      const event = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      document.body.dispatchEvent(event);
      results.push(event.defaultPrevented);
    }
    return results;
  });
  expect(textAndUrlDefaults).toEqual([false, false]);
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();

  await installFileTransfer(page, {
    name: "empty.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(0),
  });
  await dispatchDrag(page, "dragenter", "#app");
  await dispatchDrag(page, "drop", "#app");
  await expect(page.locator("#source-status")).toContainText("file is empty");

  await installFileTransfer(page, [
    { name: "one.copc.laz", mimeType: "application/octet-stream", buffer: Buffer.from("one") },
    { name: "two.copc.laz", mimeType: "application/octet-stream", buffer: Buffer.from("two") },
  ]);
  await dispatchDrag(page, "dragenter", "#app");
  await dispatchDrag(page, "drop", "#app");
  await expect(page.locator("#source-status")).toContainText("Drop one COPC file at a time");
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
});

test("the file picker and drop loader work after one another", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => {
    const hooks = (window as Window & {
      __COPC_PLAYGROUND_TEST__?: { useCameraResetLayerMock(): void };
    }).__COPC_PLAYGROUND_TEST__;
    if (!hooks) throw new Error("Playground test hooks are unavailable.");
    hooks.useCameraResetLayerMock();
  });

  await page.locator("#copc-file").setInputFiles({
    name: "picker-first.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("first local file"),
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded picker-first.copc.laz");

  await installFileTransfer(page, {
    name: "drop-after-picker.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("dropped local file"),
  });
  await dispatchDrag(page, "dragenter", "#app");
  expect(await dispatchDrag(page, "drop", "#app")).toBe(true);
  await expect(page.locator("#source-status")).toHaveText("Loaded drop-after-picker.copc.laz");

  await page.locator("#copc-file").setInputFiles({
    name: "picker-after-drop.copc.laz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("replacement from picker"),
  });
  await expect(page.locator("#source-status")).toHaveText("Loaded picker-after-drop.copc.laz");
});

test("a newer file drop supersedes a delayed local load and a pending remote probe", async ({ page }) => {
  const sourceUrl = "https://data.pointcloud.org/autzen/autzen-classified.copc.laz";
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range",
    "access-control-expose-headers": "Content-Range, Content-Length",
  };
  const probeBody = Buffer.alloc(1024);
  probeBody.write("LASF", 0, "ascii");
  probeBody.writeUInt16LE(375, 94);
  probeBody.writeUInt32LE(589, 96);
  probeBody.writeUInt32LE(1, 100);
  probeBody.write("copc", 377, "ascii");
  probeBody.writeUInt16LE(1, 393);
  probeBody.writeUInt16LE(160, 395);
  let releaseProbe!: () => void;
  let startProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise<void>((resolve) => { startProbe = resolve; });
  let staleRemoteRequests = 0;
  let firstProbeSeen = false;
  await page.route("https://data.pointcloud.org/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (request.headers().range === "bytes=0-1023" && !firstProbeSeen) {
      firstProbeSeen = true;
      startProbe();
      await probeGate;
      try {
        await route.fulfill({
          status: 206,
          headers: {
            ...corsHeaders,
            "content-range": "bytes 0-1023/8192",
            "content-length": "1024",
          },
          body: probeBody,
        });
      } catch {
        // Selecting a local File aborts this pending probe.
      }
      return;
    }
    staleRemoteRequests += 1;
    await route.fulfill({ status: 500, headers: corsHeaders, body: "stale remote request" });
  });

  try {
    await page.goto("./");
    await page.evaluate(() => {
      const hooks = (window as Window & {
        __COPC_PLAYGROUND_TEST__?: {
          useCameraResetLayerMock(): void;
          delayNextLoad(): void;
          releaseDelayedLoad(): void;
          getAppliedConfig(): { source: string | File } | undefined;
        };
      }).__COPC_PLAYGROUND_TEST__;
      if (!hooks) throw new Error("Playground test hooks are unavailable.");
      hooks.useCameraResetLayerMock();
    });
    await page.getByRole("button", { name: "Probe source" }).click();
    await probeStarted;
    await page.evaluate(() => {
      (window as Window & { __COPC_PLAYGROUND_TEST__?: { delayNextLoad(): void } })
        .__COPC_PLAYGROUND_TEST__?.delayNextLoad();
    });
    await installFileTransfer(page, {
      name: "superseded.copc.laz",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("first local file"),
    });
    await dispatchDrag(page, "dragenter", "#app");
    await dispatchDrag(page, "drop", "#app");
    await expect(page.locator("#source-status")).toHaveText("Loading superseded.copc.laz…");

    await installFileTransfer(page, {
      name: "latest-selection.copc.laz",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("second local file"),
    });
    await dispatchDrag(page, "dragenter", "#app");
    await dispatchDrag(page, "drop", "#app");
    await expect(page.locator("#source-status")).toHaveText("Loaded latest-selection.copc.laz");
    await page.evaluate(() => {
      (window as Window & { __COPC_PLAYGROUND_TEST__?: { releaseDelayedLoad(): void } })
        .__COPC_PLAYGROUND_TEST__?.releaseDelayedLoad();
    });
    await page.waitForTimeout(50);
    await expect(page.locator("#source-status")).toHaveText("Loaded latest-selection.copc.laz");
    releaseProbe();
    await page.waitForTimeout(100);
    expect(staleRemoteRequests).toBe(0);
    expect(new URL(page.url()).search).toBe("");
  } finally {
    releaseProbe();
  }
});
