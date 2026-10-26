import { expect, test } from "./ci-diagnostic-fixtures";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type SelectedPoint = {
  nodeKey: string;
  pointIndex: number;
  height: number;
  source?: { x: number; y: number; z: number };
  world?: { x: number; y: number; z: number };
};

type DevViewerApi = {
  getSnapshot():
    | {
        lifecycle: string;
        renderedPointCount: number;
        rangeRequests: { requested: number; completed: number };
        performance: {
          decodeDurationMs: number;
          pointPreparationDurationMs: number;
          rangeFetchDurationMs: number;
          crsTransformDurationMs: number;
          geographicToCartesianDurationMs: number;
          worldToCartesianDurationMs: number;
          pointStylePreparationDurationMs: number;
          pointCollectionCreationDurationMs: number;
          pointAddDurationMs: number;
          rendererPreparationDurationMs: number;
          nodeRemovalDurationMs: number;
          activeNodeCount?: number;
          queuedNodeCount?: number;
        };
        transition: { activeReplacementGroupCount: number };
        worker?: { workerCount: number; completedCount: number; activeCount: number };
      }
    | undefined;
  getSelectedPoint(): SelectedPoint | undefined;
  getPickablePointScreenPosition(): { x: number; y: number } | undefined;
  getConfiguration(): { heightOffsetMeters: number; terrainSource: string };
  getLastApplyTrace(): Array<{ stage: string; elapsedMs: number }>;
};

type ApplyGlEvent = {
  kind: "bufferData" | "bufferSubData" | "drawArrays" | "drawElements";
  sessionId: string;
  elapsedMs: number;
  bytes: number;
  durationMs: number;
};

type ApplyGlProfile = {
  start(): void;
  stop(): ApplyGlEvent[];
};

type ApplyTimingSample = {
  heightOffsetMeters: number;
  clickToReadyMs: number;
  clickToFirstPostRenderMs: number;
  clickToViewSettledMs: number;
};

function applyTimingSample(
  events: Array<{ stage: string; elapsedMs: number }>,
  heightOffsetMeters: number,
): ApplyTimingSample {
  const milestone = (stage: string): number => {
    const event = events.find((entry) => entry.stage === stage);
    if (!event) throw new Error(`Apply trace is missing ${stage}`);
    return event.elapsedMs;
  };
  return {
    heightOffsetMeters,
    clickToReadyMs: milestone("status-ready"),
    clickToFirstPostRenderMs: milestone("first-visible-post-render"),
    clickToViewSettledMs: milestone("view-settled"),
  };
}

function summarizePercentiles(values: number[]): {
  samples: number;
  p50Ms: number;
  p95Ms: number;
} {
  if (values.length === 0) return { samples: 0, p50Ms: 0, p95Ms: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const p50Ms =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    samples: sorted.length,
    p50Ms,
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
  };
}

declare global {
  interface Window {
    __COPC_DEV_VIEWER__?: DevViewerApi;
    __COPC_DEBUG__?: {
      runSyntheticEllipsoidalHeightOffsetBenchmark(pointCount?: number): {
        pointCount: number;
        warmups: number;
        repetitions: number;
        baselineOffsetMeters: number;
        targetOffsetMeters: number;
        fullPointPreparation: { p50Ms: number; p95Ms: number };
        preparedPointReposition: { p50Ms: number; p95Ms: number };
        ecefNormalUpdate: { p50Ms: number; p95Ms: number };
        additionalEcefBufferBytes: number;
        additionalEcefBufferBytesPerPoint: number;
        maximumReferenceErrorMeters: number;
        scope: string;
      };
      setTerrainFixtureHeight(heightMeters: number): void;
    };
    __COPC_APPLY_GL_PROFILE__?: ApplyGlProfile;
  }
}

const sourcePath = fileURLToPath(
  new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
);
let fixtureBytes: Buffer | undefined;

async function getAutzenFixture(): Promise<Buffer> {
  if (fixtureBytes) return fixtureBytes;
  fixtureBytes = Buffer.from(await readFile(sourcePath));
  return fixtureBytes;
}

async function installSourceRoute(page: Page): Promise<{
  snapshot(): { rangeRequests: number; rangeBytes: number };
}> {
  const data = await getAutzenFixture();
  let rangeRequests = 0;
  let rangeBytes = 0;
  await page.route("**/terrain-alignment-fixture.copc.laz*", async (route) => {
    const baseHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      ETag: '"terrain-alignment-fixture"',
    };
    if (route.request().method() === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(data.length),
        },
      });
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/u.exec(
      route.request().headers().range ?? "",
    );
    if (!range) {
      await route.fulfill({
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(data.length) },
        body: data,
      });
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(
      range[2] ? Number(range[2]) : data.length - 1,
      data.length - 1,
    );
    if (!Number.isSafeInteger(start) || start > end || start >= data.length) {
      await route.fulfill({ status: 416, headers: baseHeaders });
      return;
    }
    rangeRequests += 1;
    rangeBytes += end - start + 1;
    await route.fulfill({
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${data.length}`,
      },
      body: data.subarray(start, end + 1),
    });
  });
  return { snapshot: () => ({ rangeRequests, rangeBytes }) };
}

async function openFixture(
  page: Page,
  terrainFixtureHeight?: number,
  ellipsoidalSourceFixture = false,
): Promise<{ snapshot(): { rangeRequests: number; rangeBytes: number } }> {
  await page.addInitScript(() => {
    let nextSessionId = 0;
    let active = false;
    let startedAt = 0;
    let initialSessionIds = new Set<string>();
    let events: ApplyGlEvent[] = [];

    const getSessionId = (mount: Element): string => {
      const existing = mount.getAttribute("data-copc-profile-session");
      if (existing) return existing;
      nextSessionId += 1;
      const sessionId = String(nextSessionId);
      mount.setAttribute("data-copc-profile-session", sessionId);
      return sessionId;
    };

    const byteLength = (value: unknown): number => {
      if (typeof value === "number") return Math.max(0, value);
      if (
        value &&
        typeof value === "object" &&
        "byteLength" in value &&
        typeof value.byteLength === "number"
      ) {
        return value.byteLength;
      }
      return 0;
    };

    const record = (
      context: WebGLRenderingContext | WebGL2RenderingContext,
      kind: ApplyGlEvent["kind"],
      bytes: number,
      durationMs: number,
    ): void => {
      if (!active) return;
      const canvas = context.canvas;
      const mount = canvas.closest(".dev-session-mount");
      if (!mount) return;
      const sessionId = getSessionId(mount);
      if (initialSessionIds.has(sessionId)) return;
      events.push({
        kind,
        sessionId,
        elapsedMs: performance.now() - startedAt,
        bytes,
        durationMs,
      });
    };

    const prototypes = [
      WebGLRenderingContext.prototype,
      ...(typeof WebGL2RenderingContext === "undefined"
        ? []
        : [WebGL2RenderingContext.prototype]),
    ] as Array<Record<string, unknown>>;
    const methods: Array<{
      name: ApplyGlEvent["kind"];
      getBytes(args: unknown[]): number;
    }> = [
      { name: "bufferData", getBytes: (args) => byteLength(args[1]) },
      { name: "bufferSubData", getBytes: (args) => byteLength(args[2]) },
      { name: "drawArrays", getBytes: () => 0 },
      { name: "drawElements", getBytes: () => 0 },
    ];

    for (const prototype of prototypes) {
      for (const method of methods) {
        const original = prototype[method.name];
        if (typeof original !== "function") continue;
        prototype[method.name] = function (
          this: WebGLRenderingContext | WebGL2RenderingContext,
          ...args: unknown[]
        ): unknown {
          if (!active) {
            return Reflect.apply(original, this, args);
          }
          const callStartedAt = performance.now();
          try {
            return Reflect.apply(original, this, args);
          } finally {
            record(
              this,
              method.name,
              method.getBytes(args),
              performance.now() - callStartedAt,
            );
          }
        };
      }
    }

    window.__COPC_APPLY_GL_PROFILE__ = {
      start(): void {
        initialSessionIds = new Set(
          [...document.querySelectorAll(".dev-session-mount")].map(getSessionId),
        );
        events = [];
        startedAt = performance.now();
        active = true;
      },
      stop(): ApplyGlEvent[] {
        active = false;
        return events.map((event) => ({ ...event }));
      },
    };
  });
  const sourceMetrics = ellipsoidalSourceFixture
    ? { snapshot: () => ({ rangeRequests: 0, rangeBytes: 0 }) }
    : await installSourceRoute(page);
  const params = new URLSearchParams({
    source: "/terrain-alignment-fixture.copc.laz",
    cameraDistance: "1500",
    backend: "rust",
  });
  if (terrainFixtureHeight !== undefined) {
    params.set("terrainFixtureHeight", String(terrainFixtureHeight));
  }
  if (ellipsoidalSourceFixture) {
    params.set("terrainEllipsoidalFixture", "1");
  }
  await page.goto(`/?${params.toString()}`);
  await expect(page.locator("#source-status")).toContainText("Ready");
  const terrainSection = page
    .locator(".dev-control-section")
    .filter({ has: page.getByText("Terrain and height alignment", { exact: true }) })
  if (!(await terrainSection.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await terrainSection.locator("summary").click();
  }
  await expect(page.getByLabel("I confirm the selected point is ground")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSnapshot()?.renderedPointCount ?? 0))
    .toBeGreaterThan(0);
  if (ellipsoidalSourceFixture) {
    await page.evaluate(() =>
      window.__COPC_DEBUG__?.setCameraView({
        longitudeDegrees: -122.495,
        latitudeDegrees: 44.505,
        heightMeters: 3_000,
        headingDegrees: 0,
        pitchDegrees: -90,
      }),
    );
  }
  return sourceMetrics;
}

async function pickRenderedPoint(page: Page): Promise<SelectedPoint> {
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
      ),
    )
    .toBeDefined();
  const position = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__?.getPickablePointScreenPosition(),
  );
  const canvasBounds = await page
    .locator("#cesium-container canvas")
    .first()
    .boundingBox();
  expect(canvasBounds).not.toBeNull();
  await page.mouse.click(
    canvasBounds!.x + position!.x,
    canvasBounds!.y + position!.y,
  );
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__?.getSelectedPoint()))
    .toBeDefined();
  return page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!);
}

test("estimates, previews, and applies a WKT2 ellipsoidal fixture only after approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sourceMetrics = await openFixture(page, 102, true);
  const before = await pickRenderedPoint(page);
  expect(before.source?.z).toBe(100);

  await page.getByLabel("I confirm the selected point is ground").check();
  const estimateStartedAt = performance.now();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: ready (current)");
  await expect(preview).toContainText("ControlledTerrainProvider");
  await expect(preview).toContainText("Current displayed COPC height: 100.000 m");
  await expect(preview).toContainText("Sampled Terrain height: 102.000 m");
  await expect(preview).toContainText("Proposed adjustment (Terrain − COPC): 2.000 m");
  await expect(preview).toContainText("Sampling: 1 call");
  const estimateLatencyMs = performance.now() - estimateStartedAt;
  const afterPreview = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!,
  );
  expect(afterPreview.height).toBe(before.height);
  expect(afterPreview.source).toEqual(before.source);
  expect(afterPreview.world).toEqual(before.world);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeEnabled();

  const rangeMetricsBeforeApply = sourceMetrics.snapshot();
  const offsetFastPathPrototype = await page.evaluate(() =>
    window.__COPC_DEBUG__?.runSyntheticEllipsoidalHeightOffsetBenchmark(50_000),
  );
  expect(offsetFastPathPrototype).toBeDefined();
  expect(offsetFastPathPrototype!.maximumReferenceErrorMeters).toBeLessThan(0.000001);
  await page.evaluate(() => window.__COPC_APPLY_GL_PROFILE__?.start());
  await page.getByRole("button", { name: "Apply proposed correction" }).click();
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect
    .poll(() => page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters))
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__COPC_DEV_VIEWER__!.getLastApplyTrace().some(
          (event) => event.stage === "first-visible-post-render",
        ),
      ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__COPC_DEV_VIEWER__!.getLastApplyTrace().some(
          (event) => event.stage === "view-settled",
        ),
      ),
      { timeout: 30_000 },
    )
    .toBe(true);
  const applyTrace = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getLastApplyTrace(),
  );
  const applyTimingSamples = [applyTimingSample(applyTrace, 2)];
  const applyGlEvents = await page.evaluate(
    () => window.__COPC_APPLY_GL_PROFILE__!.stop(),
  );
  const appliedSnapshot = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSnapshot()!,
  );
  const after = await pickRenderedPoint(page);
  expect(after.source).toEqual(before.source);
  expect(after.source?.z).toBe(100);
  expect(after.height).toBe(102);
  expect(after.world).not.toEqual(before.world);
  const rangeMetricsAfterApply = sourceMetrics.snapshot();
  expect(appliedSnapshot.renderedPointCount).toBe(2);
  expect(await page.locator("#cesium-container > .dev-session-mount").count()).toBe(1);
  console.info("WKT2 ellipsoidal Terrain fixture measurements", {
    sourceFixture: "two-point custom in-memory WKT2 ellipsoidal COPC backend",
    estimateLatencyMs,
    ...applyTimingSamples[0],
    browser: {
      playwrightChromium: page.context().browser()?.version(),
      ...(await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const gl =
          canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? undefined;
        const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
        return {
          userAgent: navigator.userAgent,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          devicePixelRatio: window.devicePixelRatio,
          hardwareConcurrency: navigator.hardwareConcurrency,
          webglRenderer: debugInfo
            ? String(gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
            : gl
              ? "masked"
              : "unavailable",
        };
      })),
    },
    offsetFastPathPrototype,
    applyMilestones: applyTrace,
    additionalRangeRequests:
      rangeMetricsAfterApply.rangeRequests - rangeMetricsBeforeApply.rangeRequests,
    additionalRangeBytes:
      rangeMetricsAfterApply.rangeBytes - rangeMetricsBeforeApply.rangeBytes,
    candidateSessionGlUploads: {
      uploadCalls: applyGlEvents.filter((event) => event.kind.startsWith("buffer")).length,
      uploadBytes: applyGlEvents.reduce((sum, event) => sum + event.bytes, 0),
      uploadApiDurationMs: applyGlEvents.reduce(
        (sum, event) => sum + event.durationMs,
        0,
      ),
      drawCalls: applyGlEvents.filter((event) => event.kind.startsWith("draw")).length,
    },
    performanceLimitations: [
      "WebGL totals include Cesium Viewer resources and are not attributed to COPC point buffers.",
      "This in-memory custom backend does not fetch COPC Ranges, decode LAZ, or expose Worker timings.",
      "Renderer and point-preparation stage durations are zero for this custom backend; use a ranged production source for those stages.",
    ],
    renderer: {
      worldToCartesianDurationMs: appliedSnapshot.performance.worldToCartesianDurationMs,
      pointStylePreparationDurationMs: appliedSnapshot.performance.pointStylePreparationDurationMs,
      pointCollectionCreationDurationMs:
        appliedSnapshot.performance.pointCollectionCreationDurationMs,
      pointAddDurationMs: appliedSnapshot.performance.pointAddDurationMs,
      rendererPreparationDurationMs:
        appliedSnapshot.performance.rendererPreparationDurationMs,
      nodeRemovalDurationMs: appliedSnapshot.performance.nodeRemovalDurationMs,
    },
    pointPreparationDurationMs: appliedSnapshot.performance.pointPreparationDurationMs,
    decodeDurationMs: appliedSnapshot.performance.decodeDurationMs,
    worker: appliedSnapshot.worker,
  });

  for (const targetHeight of [105, 100, 98]) {
    await page.evaluate((height) => {
      window.__COPC_DEBUG__!.setTerrainFixtureHeight(height);
    }, targetHeight);
    const current = await pickRenderedPoint(page);
    expect(current.source).toEqual(before.source);
    await page.getByLabel("I confirm the selected point is ground").check();
    await page.getByRole("button", { name: "Estimate residual" }).click();
    await expect(page.locator("#terrain-estimate-preview")).toContainText(
      `Sampled Terrain height: ${targetHeight.toFixed(3)} m`,
    );
    await expect(page.locator("#terrain-estimate-preview")).toContainText(
      `Effective offset after approval: ${(targetHeight - 100).toFixed(3)} m`,
    );
    await page.getByRole("button", { name: "Apply proposed correction" }).click();
    await expect(page.locator("#source-status")).toContainText("Ready");
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters,
        ),
      )
      .toBe(targetHeight - 100);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__COPC_DEV_VIEWER__!.getLastApplyTrace().some(
            (event) => event.stage === "first-visible-post-render",
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__COPC_DEV_VIEWER__!.getLastApplyTrace().some(
            (event) => event.stage === "view-settled",
          ),
        ),
      )
      .toBe(true);
    const settledTrace = await page.evaluate(
      () => window.__COPC_DEV_VIEWER__!.getLastApplyTrace(),
    );
    applyTimingSamples.push(
      applyTimingSample(settledTrace, targetHeight - 100),
    );
    const updated = await pickRenderedPoint(page);
    expect(updated.source).toEqual(before.source);
    expect(updated.height).toBe(targetHeight);
    expect(updated.world).not.toEqual(current.world);
  }

  console.info("Repeated warm Apply timing samples", {
    fixture: "two-point WKT2 ellipsoidal source with controlled Terrain",
    offsetSequenceMeters: applyTimingSamples.map(
      (sample) => sample.heightOffsetMeters,
    ),
    firstApply: applyTimingSamples[0],
    repeatedWarm: {
      clickToReady: summarizePercentiles(
        applyTimingSamples.slice(1).map((sample) => sample.clickToReadyMs),
      ),
      clickToFirstPostRender: summarizePercentiles(
        applyTimingSamples
          .slice(1)
          .map((sample) => sample.clickToFirstPostRenderMs),
      ),
      clickToViewSettled: summarizePercentiles(
        applyTimingSamples.slice(1).map((sample) => sample.clickToViewSettledMs),
      ),
    },
    samples: applyTimingSamples,
    note: "Three warm repetitions; these synthetic-source values exclude Range networking and LAZ decode.",
  });
});

test("rejects Terrain alignment for Autzen NAVD88 without moving the selected point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page, 250);
  const before = await pickRenderedPoint(page);
  await page.getByLabel("I confirm the selected point is ground").check();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: uncertain (current)");
  await expect(preview).toContainText("ControlledTerrainProvider");
  await expect(preview).toContainText("Vertical reference: EPSG:6360 → unverified");
  await expect(preview).toContainText("no validated transformation to WGS 84 ellipsoidal height");
  await expect(preview).toContainText("Sampling: 0 calls");
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeDisabled();
  const after = await page.evaluate(
    () => window.__COPC_DEV_VIEWER__!.getSelectedPoint()!,
  );
  expect(after.height).toBe(before.height);
  expect(after.source).toEqual(before.source);
  expect(after.world).toEqual(before.world);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
});

test("ellipsoid-only mode does not sample NAVD88 heights or move the selected point", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openFixture(page);
  const before = await pickRenderedPoint(page);
  await page.getByLabel("I confirm the selected point is ground").check();
  await page.getByRole("button", { name: "Estimate residual" }).click();
  const preview = page.locator("#terrain-estimate-preview");
  await expect(preview).toContainText("Estimate status: uncertain (current)");
  await expect(preview).toContainText("Vertical reference: EPSG:6360 → unverified");
  await expect(preview).toContainText("Terrain provider: EllipsoidTerrainProvider");
  await expect(preview).toContainText("Sampling: 0 calls");
  await expect(page.getByRole("button", { name: "Apply proposed correction" })).toBeDisabled();
  const after = await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getSelectedPoint());
  expect(after?.height).toBe(before.height);
  expect(after?.source?.z).toBe(before.source?.z);
  expect(await page.evaluate(() => window.__COPC_DEV_VIEWER__!.getConfiguration().heightOffsetMeters)).toBe(0);
});
