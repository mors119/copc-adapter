import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiagnosticsRefreshLoop,
  createDiagnosticsViewModel,
  displaySourceLabel,
  formatDiagnosticBytes,
  formatDiagnosticCount,
  formatDiagnosticDuration,
  supportsLongTaskObservation,
} from "../src/diagnostics.ts";

const config = {
  backend: "rust",
  colorMode: "elevation",
  pointSize: 3,
  maxRenderedPoints: 250_000,
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  refinementAlgorithm: "foveated",
};

const context = {
  sourceLabel: "Autzen · data.pointcloud.org",
  renderer: "cesium",
  config,
  sourceKind: "http",
  sourceSizeBytes: 1024 * 1024 * 12,
  sourceHttpStatus: 206,
  sourcePartialHttpStatus: 206,
  corsReadable: true,
  rangeSupported: true,
  copcDetected: true,
};

test("formats byte counts, durations, and unavailable values with stable units", () => {
  assert.equal(formatDiagnosticBytes(0), "0 B");
  assert.equal(formatDiagnosticBytes(482 * 1024), "482 KiB");
  assert.equal(formatDiagnosticBytes(4.8 * 1024 * 1024), "4.8 MiB");
  assert.equal(formatDiagnosticBytes(1.2 * 1024 ** 3), "1.2 GiB");
  assert.equal(formatDiagnosticBytes(Number.POSITIVE_INFINITY), "No byte limit");
  assert.equal(formatDiagnosticBytes(Number.NaN), "Not available");
  assert.equal(formatDiagnosticCount(undefined), "Not available");
  assert.equal(formatDiagnosticCount(Number.NaN), "Not available");
  assert.equal(formatDiagnosticDuration(12.25), "12.3 ms");
  assert.equal(formatDiagnosticDuration(1250), "1.25 s");
  assert.equal(formatDiagnosticDuration(undefined), "Not available");
});

test("sanitizes remote source labels to the host and omits credentials and paths", () => {
  assert.equal(
    displaySourceLabel(
      "Custom source",
      "https://user:secret@data.example.test/private/file.copc.laz?token=abc",
    ),
    "Custom source · data.example.test",
  );
  assert.equal(displaySourceLabel("local.copc.laz"), "local.copc.laz");
});

test("maps missing Worker data as unavailable and never fabricates numeric zeros", () => {
  const rustModel = createDiagnosticsViewModel(undefined, context, {});
  assert.equal(rustModel.workerSummary, "Unavailable in this environment");
  assert.equal(rustModel.renderedPoints, "Not available");
  assert.equal(rustModel.cacheBytes, "Not available");
  assert.equal(rustModel.renderInterval, "Not available");
  assert.equal(rustModel.metadataPointCount, "Not available");
  assert.equal(
    rustModel.sourceStatus,
    "HTTP 206 · CORS readable · Range supported (206) · COPC detected",
  );
  assert.equal(rustModel.sourceSize, "12.0 MiB");

  const jsModel = createDiagnosticsViewModel(undefined, {
    ...context,
    config: { ...config, backend: "copc-js" },
  }, {});
  assert.equal(jsModel.workerSummary, "Not applicable for this backend");
});

test("uses the public maxDepth default when omitted and honors an explicit value", () => {
  const { maxDepth: _maxDepth, ...configWithoutMaxDepth } = config;
  const defaultModel = createDiagnosticsViewModel(
    undefined,
    { ...context, config: configWithoutMaxDepth },
    {},
  );
  const explicitModel = createDiagnosticsViewModel(
    undefined,
    { ...context, config: { ...configWithoutMaxDepth, maxDepth: 3 } },
    {},
  );

  assert.match(defaultModel.context, /maxDepth 6/);
  assert.match(explicitModel.context, /maxDepth 3/);
});

test("shows a long on-demand render gap as cadence interval, not render cost", () => {
  const model = createDiagnosticsViewModel(
    undefined,
    context,
    { renderIntervalMs: 5_000 },
  );

  assert.equal(model.renderInterval, "5.00 s");
  assert.equal(model.approximateRenderCadence, "~0.2 FPS");
});

test("recognizes absent or unsupported Long Task APIs without throwing", () => {
  assert.equal(supportsLongTaskObservation(undefined), false);
  assert.equal(
    supportsLongTaskObservation({ supportedEntryTypes: [] }),
    false,
  );
  assert.equal(
    supportsLongTaskObservation({ supportedEntryTypes: ["longtask"] }),
    true,
  );
});

test("marks Rust CRS work as fused when the public metric reports point preparation", () => {
  const model = createDiagnosticsViewModel(
    {
      snapshot: {
        lifecycle: "ready",
        renderedPoints: 12,
        renderedNodes: 1,
        selectedNodes: 1,
        refinementAlgorithm: "foveated",
        performance: {
          pointPreparationDurationMs: 3.4,
          crsTransformDurationMs: 0,
        },
      },
    },
    context,
    {},
  );
  assert.equal(model.crsDuration, "Included in point preparation");
  assert.equal(model.refinementAlgorithm, "Foveated");
});

test("replaces the active source model without retaining the prior layer", () => {
  const first = createDiagnosticsViewModel(
    {
      snapshot: {
        lifecycle: "destroyed",
        renderedPoints: 90,
        renderedNodes: 2,
        selectedNodes: 2,
      },
    },
    context,
    {},
  );
  const replacement = createDiagnosticsViewModel(
    {
      snapshot: {
        lifecycle: "ready",
        renderedPoints: 5,
        renderedNodes: 1,
        selectedNodes: 1,
      },
    },
    { ...context, sourceLabel: "Chicago · data.pointcloud.org" },
    {},
  );
  assert.equal(first.sourceLabel, "Autzen · data.pointcloud.org");
  assert.equal(replacement.sourceLabel, "Chicago · data.pointcloud.org");
  assert.equal(replacement.renderedPoints, "5");
  assert.equal(replacement.lifecycle, "ready");
});

test("refresh loop reads the current layer and stops after cleanup", () => {
  let tick;
  let cancelledHandle;
  let current = "first layer";
  const rendered = [];
  const stop = createDiagnosticsRefreshLoop(
    () => current,
    (value) => rendered.push(value),
    (callback, intervalMs) => {
      assert.equal(intervalMs, 500);
      tick = callback;
      return 41;
    },
    (handle) => {
      cancelledHandle = handle;
    },
  );

  tick();
  current = "replacement layer";
  tick();
  current = undefined;
  tick();
  stop();
  tick();
  stop();

  assert.deepEqual(rendered, ["first layer", "replacement layer", undefined]);
  assert.equal(cancelledHandle, 41);
});
