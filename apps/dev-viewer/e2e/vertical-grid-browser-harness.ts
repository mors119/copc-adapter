import {
  loadNgaEgm2008Grid,
  loadGtxGeoidGrid,
  VerticalTransformError,
} from "@frillab/copc-adapter";

declare global {
  interface Window {
    __VERTICAL_GRID_BROWSER_SMOKE__?: () => Promise<{
      centerUndulationMeters: number;
      correctedHeightMeters: number;
      noDataCode: string;
    }>;
    __NGA_EGM2008_BROWSER_SMOKE__?: (
      url: string,
      inputMode: "blob" | "array-buffer",
    ) => Promise<{
      sha256: string;
      encodedByteLength: number;
      decodedByteLength: number;
      width: number;
      height: number;
      loadDurationMs: number;
      interpolation250kMs: number;
      sanFranciscoMeters: number;
      longTasks: Array<{ startTimeMs: number; durationMs: number }>;
      rowTaskDurationsMs: number[];
      maximumFrameGapMs: number;
      maximumTimerDelayMs: number;
      fetchDurationMs: number;
      sourceReadDurationMs: number;
      loaderDurationMs: number;
      userAgentMemoryBytes?: number;
    }>;
  }
}

window.__VERTICAL_GRID_BROWSER_SMOKE__ = async () => {
  const buffer = new ArrayBuffer(40 + 4 * 4);
  const header = new DataView(buffer);
  header.setFloat64(0, 0, false);
  header.setFloat64(8, 0, false);
  header.setFloat64(16, 1, false);
  header.setFloat64(24, 1, false);
  header.setInt32(32, 2, false);
  header.setInt32(36, 2, false);
  [10, 20, 30, 40].forEach((value, index) =>
    header.setFloat32(40 + index * 4, value, false),
  );
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const grid = await loadGtxGeoidGrid(blob, {
    gridId: "browser-synthetic-grid",
    sourceVerticalCrs: "Local orthometric height",
    targetVerticalCrs: "EPSG:4979",
    horizontalCrs: "EPSG:4326",
    referenceEllipsoid: "WGS84",
    sha256,
    valueUnit: "metre",
    valueConvention: "ellipsoidal-minus-orthometric",
    noDataValue: null,
  });
  let noDataCode = "none";
  try {
    const badBytes = new ArrayBuffer(40 + 4 * 4);
    const bad = new DataView(badBytes);
    bad.setFloat64(0, 0, false);
    bad.setFloat64(8, 0, false);
    bad.setFloat64(16, 1, false);
    bad.setFloat64(24, 1, false);
    bad.setInt32(32, 2, false);
    bad.setInt32(36, 2, false);
    [10, -9999, 30, 40].forEach((value, index) =>
      bad.setFloat32(40 + index * 4, value, false),
    );
    const badBlob = new Blob([badBytes]);
    const badDigest = await crypto.subtle.digest(
      "SHA-256",
      await badBlob.arrayBuffer(),
    );
    const badGrid = await loadGtxGeoidGrid(badBlob, {
      gridId: "browser-synthetic-nodata-grid",
      sourceVerticalCrs: "Local orthometric height",
      targetVerticalCrs: "EPSG:4979",
      horizontalCrs: "EPSG:4326",
      referenceEllipsoid: "WGS84",
      sha256: [...new Uint8Array(badDigest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      valueUnit: "metre",
      valueConvention: "ellipsoidal-minus-orthometric",
      noDataValue: -9999,
    });
    badGrid.sampleUndulation(1, 0);
  } catch (error) {
    if (!(error instanceof VerticalTransformError)) throw error;
    noDataCode = error.code;
  }
  return {
    centerUndulationMeters: grid.sampleUndulation(0.5, 0.5),
    correctedHeightMeters: grid.transformHeight(
      100,
      0.5,
      0.5,
      "orthometric-to-ellipsoidal",
    ),
    noDataCode,
  };
};

window.__NGA_EGM2008_BROWSER_SMOKE__ = async (url, inputMode) => {
  const longTasks: Array<{ startTimeMs: number; durationMs: number }> = [];
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        longTasks.push({ startTimeMs: entry.startTime, durationMs: entry.duration });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // Long Task timing is optional in Chromium builds without the API.
  }

  let maximumFrameGapMs = 0;
  let previousFrameMs: number | undefined;
  let animationFrame = 0;
  const sampleFrame = (now: number): void => {
    if (previousFrameMs !== undefined) {
      maximumFrameGapMs = Math.max(maximumFrameGapMs, now - previousFrameMs);
    }
    previousFrameMs = now;
    animationFrame = requestAnimationFrame(sampleFrame);
  };
  animationFrame = requestAnimationFrame(sampleFrame);

  let maximumTimerDelayMs = 0;
  let expectedTimerMs = performance.now() + 16;
  let timer = 0;
  const sampleTimer = (): void => {
    const now = performance.now();
    maximumTimerDelayMs = Math.max(maximumTimerDelayMs, now - expectedTimerMs);
    expectedTimerMs = now + 16;
    timer = window.setTimeout(sampleTimer, 16);
  };
  timer = window.setTimeout(sampleTimer, 16);

  const startedAt = performance.now();
  const response = await fetch(url);
  const responseReadyAt = performance.now();
  if (!response.ok) throw new Error(`EGM2008 fixture request failed with HTTP ${response.status}`);
  const source = inputMode === "blob"
    ? await response.blob()
    : await response.arrayBuffer();
  const sourceReadyAt = performance.now();
  const loaderStartedAt = performance.now();
  const rowTaskDurationsMs: number[] = [];
  const originalSetTimeout = window.setTimeout;
  const scheduleTimeout = originalSetTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 0 && typeof handler === "function") {
      return scheduleTimeout(() => {
        const taskStartedAt = performance.now();
        (handler as (...callbackArgs: unknown[]) => void)(...args);
        queueMicrotask(() => rowTaskDurationsMs.push(performance.now() - taskStartedAt));
      }, timeout);
    }
    return scheduleTimeout(handler, timeout, ...args);
  }) as typeof window.setTimeout;
  let grid: Awaited<ReturnType<typeof loadNgaEgm2008Grid>>;
  try {
    grid = await loadNgaEgm2008Grid(source);
  } finally {
    window.setTimeout = originalSetTimeout;
  }
  const gridReadyAt = performance.now();
  const loadDurationMs = gridReadyAt - startedAt;
  const loaderDurationMs = gridReadyAt - loaderStartedAt;

  let seed = 0x51f15e;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const locations = new Float64Array(250_000 * 2);
  for (let index = 0; index < 250_000; index += 1) {
    locations[index * 2] = -123.06875 + (random() - 0.5) * 0.1;
    locations[index * 2 + 1] = 44.04034 + (random() - 0.5) * 0.1;
  }
  for (let index = 0; index < 10_000; index += 1) {
    grid.sampleUndulation(locations[index * 2], locations[index * 2 + 1]);
  }
  const interpolationStartedAt = performance.now();
  let checksum = 0;
  for (let index = 0; index < 250_000; index += 1) {
    checksum += grid.sampleUndulation(locations[index * 2], locations[index * 2 + 1]);
  }
  const interpolation250kMs = performance.now() - interpolationStartedAt;
  const performanceWithMemory = performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };
  let userAgentMemoryBytes: number | undefined;
  let memoryTimeout: number | undefined;
  try {
    const measurement = performanceWithMemory.measureUserAgentSpecificMemory?.();
    if (measurement) {
      const timeout = new Promise<undefined>((resolve) => {
        memoryTimeout = window.setTimeout(() => resolve(undefined), 1_000);
      });
      userAgentMemoryBytes = (await Promise.race([measurement, timeout]))?.bytes;
    }
  } catch {
    // The API can be unavailable outside cross-origin-isolated contexts.
  }
  if (memoryTimeout !== undefined) clearTimeout(memoryTimeout);

  clearTimeout(timer);
  cancelAnimationFrame(animationFrame);
  observer?.disconnect();
  if (!Number.isFinite(checksum)) throw new Error("EGM2008 interpolation checksum is not finite");
  return {
    sha256: grid.sha256,
    encodedByteLength: grid.encodedByteLength,
    decodedByteLength: grid.decodedByteLength,
    width: grid.width,
    height: grid.height,
    loadDurationMs,
    interpolation250kMs,
    sanFranciscoMeters: grid.sampleUndulation(-122.4194, 37.7749),
    longTasks,
    rowTaskDurationsMs,
    maximumFrameGapMs,
    maximumTimerDelayMs,
    fetchDurationMs: responseReadyAt - startedAt,
    sourceReadDurationMs: sourceReadyAt - responseReadyAt,
    loaderDurationMs,
    ...(userAgentMemoryBytes === undefined ? {} : { userAgentMemoryBytes }),
  };
};
