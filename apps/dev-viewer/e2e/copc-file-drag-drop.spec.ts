import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "./ci-diagnostic-fixtures";
import type { Page } from "@playwright/test";

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
  options: { readonly renamedFile?: string; readonly delayFirstReadMs?: number } = {},
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
  await page.evaluate(({ renamedFile, delayFirstReadMs }) => {
    const input = document.querySelector<HTMLInputElement>("#copc-drag-test-input");
    if (!input?.files?.length) throw new Error("The browser test file was not installed.");
    const transfer = new DataTransfer();
    for (const [index, source] of Array.from(input.files).entries()) {
      let file = source;
      if (renamedFile && input.files.length === 1) {
        file = new File([source], renamedFile, { type: source.type });
      }
      if (delayFirstReadMs && index === 0) {
        const originalSlice = file.slice.bind(file);
        Object.defineProperty(file, "slice", {
          configurable: true,
          value(start?: number, end?: number, contentType?: string) {
            const blob = originalSlice(start, end, contentType);
            const read = blob.arrayBuffer.bind(blob);
            Object.defineProperty(blob, "arrayBuffer", {
              configurable: true,
              value: async () => {
                await new Promise((resolve) => setTimeout(resolve, delayFirstReadMs));
                return read();
              },
            });
            return blob;
          },
        });
      }
      transfer.items.add(file);
    }
    (window as Window & { __COPC_DRAG_TEST_TRANSFER__?: DataTransfer })
      .__COPC_DRAG_TEST_TRANSFER__ = transfer;
  }, options);
}

async function dispatchDrag(
  page: Page,
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  selector = "body",
  coordinates?: { readonly x: number; readonly y: number },
  relatedTargetSelector?: string,
): Promise<boolean> {
  return page.evaluate(({ eventType, targetSelector, x, y, relatedSelector }) => {
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
    if (relatedSelector) {
      const relatedTarget = document.querySelector(relatedSelector);
      Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
    }
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }, {
    eventType: type,
    targetSelector: selector,
    x: coordinates?.x ?? 20,
    y: coordinates?.y ?? 20,
    relatedSelector: relatedTargetSelector,
  });
}

async function expectRenderedPoints(page: Page): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
}

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: {
      getSnapshot(): { lifecycle: string; renderedPointCount: number } | undefined;
      getConfiguration(): { renderer: string };
    };
    __COPC_DEBUG__?: {
      getState(): { metadataPointCount?: number; layerLoaded?: boolean };
    };
  }
}

test("local COPC drops load and render in Cesium and Three without uploads", async ({ page }) => {
  test.skip(!autzenFixtureAvailable, "Download the Autzen COPC fixture with npm run download-samples -- autzen.");
  test.setTimeout(300_000);
  const uploadRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT"].includes(request.method().toUpperCase())) {
      uploadRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto("/");
  const renderer = page.getByRole("radiogroup", { name: "Renderer" });
  await page.locator("#local-source-file").setInputFiles(autzenFixture);
  await expect(page.locator("#source-selection")).toHaveValue("local-file");
  await installFileTransfer(page, autzenFixture, { renamedFile: "dragged-autzen.copc.laz" });
  await dispatchDrag(page, "dragenter", "#viewport-panel");
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragover", "#controls-panel");
  expect(await dispatchDrag(page, "drop", "#viewport-panel")).toBe(true);
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready", { timeout: 120_000 });
  await expect(page.locator("#source-status")).toContainText("dragged-autzen.copc.laz");
  await expect.poll(() => page.evaluate(() => window.__COPC_DEBUG__?.getState().metadataPointCount ?? 0)).toBe(10_653_336);
  await expectRenderedPoints(page);
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer))
    .toBe("cesium");

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
  await dispatchDrag(page, "dragenter", "#viewport-panel");
  expect(await dispatchDrag(page, "drop", "#viewport-panel")).toBe(true);
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#source-status")).toContainText("COPC");
  await expectRenderedPoints(page);

  await renderer.getByRole("radio", { name: "Three.js" }).click();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready", { timeout: 120_000 });
  await expect(page.locator("#source-status")).toContainText("dragged-autzen.copc.laz");
  await expectRenderedPoints(page);
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getConfiguration().renderer))
    .toBe("three");

  await page.locator("#local-source-file").setInputFiles(autzenFixture);
  await expect(page.locator("#source-selection")).toHaveValue("local-file");
  await page.getByRole("button", { name: "Load selected source" }).click();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready", { timeout: 120_000 });
  await expect(page.locator("#source-status")).toContainText("autzen.copc.laz");
  await expectRenderedPoints(page);
  expect(uploadRequests).toEqual([]);
});

test("drag lifecycle rejects unsupported and multiple files and leaves other drags alone", async ({ page }) => {
  await page.goto("/");
  await installFileTransfer(page, {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a COPC"),
  });
  await dispatchDrag(page, "dragenter", "body");
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragenter", "#controls-panel");
  await dispatchDrag(page, "dragleave", "#controls-panel", { x: 40, y: 40 }, "#viewport-panel");
  await expect(page.locator(".copc-file-drop-overlay")).toBeVisible();
  await dispatchDrag(page, "dragleave", "#viewport-panel", { x: -1, y: 40 });
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();

  await dispatchDrag(page, "dragenter", "#viewport-panel");
  expect(await dispatchDrag(page, "drop", "#viewport-panel")).toBe(true);
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "error");
  await expect(page.locator("#source-status")).toContainText("Unsupported file type");
  await expect(page.locator("#local-source-file")).toBeAttached();

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

  await installFileTransfer(page, [
    { name: "one.copc.laz", mimeType: "application/octet-stream", buffer: Buffer.from("one") },
    { name: "two.copc.laz", mimeType: "application/octet-stream", buffer: Buffer.from("two") },
  ]);
  await dispatchDrag(page, "dragenter", "#viewport-panel");
  await dispatchDrag(page, "drop", "#viewport-panel");
  await expect(page.locator("#source-status")).toContainText("Drop one COPC file at a time");
  await expect(page.locator(".copc-file-drop-overlay")).toBeHidden();
});

test("a newer local drop supersedes an in-flight file read", async ({ page }) => {
  test.skip(!autzenFixtureAvailable, "Download the Autzen COPC fixture with npm run download-samples -- autzen.");
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.locator(".copc-file-drop-overlay")).toBeAttached();
  await installFileTransfer(page, autzenFixture, {
    renamedFile: "superseded.copc.laz",
    delayFirstReadMs: 2_000,
  });
  await dispatchDrag(page, "dragenter", "#viewport-panel");
  await dispatchDrag(page, "drop", "#viewport-panel");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "loading");

  await installFileTransfer(page, autzenFixture, { renamedFile: "latest-selection.copc.laz" });
  await dispatchDrag(page, "dragenter", "#controls-panel");
  await dispatchDrag(page, "drop", "#controls-panel");
  await expect(page.locator("#source-status")).toHaveAttribute("data-status", "ready", { timeout: 120_000 });
  await expect(page.locator("#source-status")).toContainText("latest-selection.copc.laz");
  await expectRenderedPoints(page);
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEBUG__?.getState().metadataPointCount ?? 0))
    .toBe(10_653_336);
});
