import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";

export { expect };

const MAX_REQUEST_EVENTS = 24;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 500;
const MAX_DIAGNOSTIC_BYTES = 24 * 1024;
const viewerRoot = fileURLToPath(new URL("..", import.meta.url));

type RequestEvent = {
  host: string;
  method: string;
  range?: string;
  status?: number;
  corsReadable?: boolean;
  contentRange?: string;
  contentLength?: number;
  contentRangeVisible?: boolean;
  contentLengthVisible?: boolean;
  failure?: string;
};

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.slice(0, 120);
  } catch {
    return "unavailable";
  }
}

function sanitizeText(input: string): string {
  const withoutUrls = input.replace(/https?:\/\/[^\s"'<>`]+/gi, (match) => {
    const trailing = match.match(/[),.;:!?]+$/)?.[0] ?? "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    return `${safeHost(candidate)}/[redacted]${trailing}`;
  });

  return withoutUrls
    .replace(
      /\b(authorization|cookie|set-cookie|x-amz-credential|x-amz-signature|access[_-]?token|token|secret|password)\b(\s*[:=]\s*)[^\s,;]+/gi,
      "$1$2[redacted]",
    )
    .replace(/([?&](?:source|url|token|signature|credential|key|auth)[^=\s]*=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(?:\/home\/runner\/work\/[^/\s]+\/[^/\s]+|\/Users\/[^/\s]+)(?:\/[^\s:'"<>]*)?/g, "[local-path]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function isVisibleResponseHeader(
  responseUrl: string,
  pageOrigin: string,
  headerName: string,
  responseHeaders: Record<string, string>,
): boolean {
  let responseOrigin: string;
  try {
    responseOrigin = new URL(responseUrl).origin;
  } catch {
    return false;
  }
  if (responseOrigin === pageOrigin) return true;
  const allowedOrigin = responseHeaders["access-control-allow-origin"];
  if (
    allowedOrigin !== "*" &&
    allowedOrigin !== pageOrigin
  ) {
    return false;
  }
  if (
    allowedOrigin === "*" &&
    responseHeaders["access-control-allow-credentials"]?.toLowerCase() ===
      "true"
  ) {
    return false;
  }
  if (headerName === "content-length") return true;
  const exposed = (responseHeaders["access-control-expose-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  return (
    exposed.includes(headerName.toLowerCase()) ||
    (exposed.includes("*") &&
      responseHeaders["access-control-allow-credentials"]?.toLowerCase() !==
        "true")
  );
}

function boundedPush<T>(items: T[], item: T, maximum: number): void {
  items.push(item);
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

async function captureRuntimeState(page: Page): Promise<unknown> {
  try {
    return await page.evaluate(() => {
      type RuntimeDebug = { getState?: () => unknown };
      const debug = (window as Window & { __COPC_DEBUG__?: RuntimeDebug })
        .__COPC_DEBUG__;
      const value = debug?.getState?.();
      if (!value || typeof value !== "object") return undefined;

      const state = value as Record<string, unknown>;
      const performance =
        state.performance && typeof state.performance === "object"
          ? (state.performance as Record<string, unknown>)
          : {};
      const transition =
        state.transition && typeof state.transition === "object"
          ? (state.transition as Record<string, unknown>)
          : {};
      const rangeRequests =
        state.rangeRequests && typeof state.rangeRequests === "object"
          ? (state.rangeRequests as Record<string, unknown>)
          : {};
      const worker =
        state.worker && typeof state.worker === "object"
          ? (state.worker as Record<string, unknown>)
          : {};
      const hierarchy =
        state.hierarchy && typeof state.hierarchy === "object"
          ? (state.hierarchy as Record<string, unknown>)
          : {};

      const count = (key: string): number | undefined => {
        const candidate = state[key];
        return Array.isArray(candidate) ? candidate.length : undefined;
      };

      return {
        lifecycle: state.lifecycle,
        layerLoaded: state.layerLoaded,
        loadGeneration: state.loadGeneration,
        viewGeneration: state.viewGeneration,
        backend: state.backend,
        cameraHeadingDegrees: state.cameraHeadingDegrees,
        cameraPitchDegrees: state.cameraPitchDegrees,
        renderedPointCount: state.renderedPointCount,
        selectedNodeCount: count("selectedNodeKeys"),
        renderedNodeCount: count("renderedNodeKeys"),
        streamingUpdateCount: state.streamingUpdateCount,
        rangeRequests: {
          requested: rangeRequests.requested,
          active: rangeRequests.active,
          completed: rangeRequests.completed,
          failed: rangeRequests.failed,
          abortedSuperseded: rangeRequests.abortedSuperseded,
          abortedLifecycle: rangeRequests.abortedLifecycle,
        },
        worker: {
          activeCount: worker.activeCount,
          queuedCount: worker.queuedCount,
          submittedCount: worker.submittedCount,
          completedCount: worker.completedCount,
          cancelledCount: worker.cancelledCount,
          failedCount: worker.failedCount,
        },
        hierarchy: {
          activePageLoads: hierarchy.activePageLoads,
          pageRequests: hierarchy.pageRequests,
        },
        performance: {
          activeNodeCount: performance.activeNodeCount,
          queuedNodeCount: performance.queuedNodeCount,
          loadedPointCount: performance.loadedPointCount,
          rangeFetchBytes: performance.rangeFetchBytes,
          refinementAlgorithm: performance.refinementAlgorithm,
          decodeDurationMs: performance.decodeDurationMs,
          longestMainThreadTaskMs: state.longestMainThreadTaskMs,
          cesiumFrameDurationMs: state.cesiumFrameDurationMs,
        },
        transition: {
          activeReplacementGroupCount: transition.activeReplacementGroupCount,
          staleReplacementCancellationCount:
            transition.staleReplacementCancellationCount,
          coarseNodesRetainedForCoverageCount:
            transition.coarseNodesRetainedForCoverageCount,
        },
        lastError: state.lastError,
      };
    });
  } catch {
    return undefined;
  }
}

async function captureEnvironment(page: Page): Promise<unknown> {
  try {
    return await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const gl =
        canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? undefined;
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        userAgent: navigator.userAgent.slice(0, 240),
        platform: navigator.platform.slice(0, 80),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        devicePixelRatio: window.devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
        webglRenderer: debugInfo
          ? String(gl?.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
              .slice(0, 120)
          : gl
            ? "masked"
            : "unavailable",
      };
    });
  } catch {
    return undefined;
  }
}

async function writeFailureSummary(
  page: Page,
  testInfo: TestInfo,
  requestEvents: RequestEvent[],
  requestEventCount: number,
  consoleMessages: string[],
  pageErrors: string[],
): Promise<void> {
  const errors = testInfo.errors.slice(0, 4).map((error) =>
    sanitizeText(error.message ?? "Test failed without an error message"),
  );
  const primaryError = errors[0] ?? "Test failed without an error message";
  const message = primaryError.toLowerCase();
  const failureStage = message.includes("timeout")
    ? "playwright-timeout"
    : message.includes("webgl") || message.includes("context lost")
      ? "browser-renderer"
      : "assertion-or-test-error";
  const url = (() => {
    try {
      return new URL(page.url());
    } catch {
      return undefined;
    }
  })();
  const allowedSettings = [
    "scenario",
    "backend",
    "rangeValidation",
    "refinementAlgorithm",
    "renderer",
    "budget",
    "distance",
    "prefetch",
  ];
  const settings = Object.fromEntries(
    allowedSettings.flatMap((key) => {
      const value = url?.searchParams.get(key);
      return value && /^[\w.,+-]{1,80}$/.test(value) ? [[key, value]] : [];
    }),
  );
  const source = url?.searchParams.get("source");
  const sourceHost = source ? safeHost(source) : undefined;
  const commit = process.env.GITHUB_SHA;
  const runtime = await captureRuntimeState(page);
  if (runtime && typeof runtime === "object") {
    const runtimeRecord = runtime as Record<string, unknown>;
    if (typeof runtimeRecord.lastError === "string") {
      runtimeRecord.lastError = sanitizeText(runtimeRecord.lastError);
    }
  }
  const summary = {
    schemaVersion: 1,
    classification: "UNKNOWN",
    failureStage,
    commit: commit && /^[a-f\d]{40}$/i.test(commit) ? commit : undefined,
    browser: testInfo.project.use.browserName,
    node: process.version,
    test: sanitizeText(testInfo.titlePath.join(" › ")),
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    durationMs: testInfo.duration,
    retry: testInfo.retry,
    workerIndex: testInfo.workerIndex,
    page: {
      host: url?.hostname ?? "unavailable",
      sourceHost,
      settings,
    },
    environment: await captureEnvironment(page),
    assertionErrors: errors,
    consoleMessages: consoleMessages.slice(-MAX_MESSAGES),
    pageErrors: pageErrors.slice(-MAX_MESSAGES),
    requests: requestEvents,
    runtime,
    omittedRequestEvents: Math.max(0, requestEventCount - requestEvents.length),
  };
  const serialized = JSON.stringify(summary, null, 2);
  const bounded = Buffer.byteLength(serialized) <= MAX_DIAGNOSTIC_BYTES
    ? serialized
    : JSON.stringify({
        schemaVersion: 1,
        classification: "UNKNOWN",
        failureStage,
        commit: summary.commit,
        test: summary.test,
        status: summary.status,
        durationMs: summary.durationMs,
        page: summary.page,
        assertionErrors: summary.assertionErrors,
        requests: summary.requests.slice(-8),
        runtime: summary.runtime,
        truncated: true,
      }, null, 2);

  const digest = createHash("sha256")
    .update(testInfo.testId)
    .digest("hex")
    .slice(0, 16);
  const directory = path.join(viewerRoot, "test-results", "ci-diagnostics");
  const filePath = path.join(directory, `${digest}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, bounded, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    process.stderr.write(
      `Could not write sanitized browser failure summary: ${sanitizeText(String(error))}\n`,
    );
  }
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const requestEvents: RequestEvent[] = [];
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    let requestEventCount = 0;
    const configuredOrigin = testInfo.project.use.baseURL;
    let pageOrigin = "";
    try {
      pageOrigin = new URL(String(configuredOrigin)).origin;
    } catch {
      // A missing base URL keeps cross-origin response headers conservative.
    }

    page.on("response", (response) => {
      requestEventCount += 1;
      const headers = response.headers();
      const request = response.request();
      const requestHeaders = request.headers();
      const contentRangeVisible = isVisibleResponseHeader(
        response.url(),
        pageOrigin,
        "content-range",
        headers,
      );
      const contentLengthVisible = isVisibleResponseHeader(
        response.url(),
        pageOrigin,
        "content-length",
        headers,
      );
      const contentLength = contentLengthVisible
        ? Number(headers["content-length"])
        : Number.NaN;
      const event: RequestEvent = {
        host: safeHost(response.url()),
        method: request.method().slice(0, 12),
        ...(requestHeaders.range
          ? { range: requestHeaders.range.slice(0, 80) }
          : {}),
        status: response.status(),
        corsReadable:
          contentLengthVisible || contentRangeVisible,
        ...(contentRangeVisible && headers["content-range"]
          ? { contentRange: headers["content-range"].slice(0, 120) }
          : {}),
        ...(Number.isSafeInteger(contentLength) && contentLength >= 0
          ? { contentLength }
          : {}),
        contentRangeVisible,
        contentLengthVisible,
      };
      if (event.range || event.status >= 400 || event.method === "HEAD") {
        boundedPush(requestEvents, event, MAX_REQUEST_EVENTS);
      }
    });
    page.on("requestfailed", (request) => {
      requestEventCount += 1;
      boundedPush(
        requestEvents,
        {
          host: safeHost(request.url()),
          method: request.method().slice(0, 12),
          ...(request.headers().range
            ? { range: request.headers().range.slice(0, 80) }
            : {}),
          failure: sanitizeText(request.failure()?.errorText ?? "request failed"),
        },
        MAX_REQUEST_EVENTS,
      );
    });
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "error") {
        boundedPush(
          consoleMessages,
          `${message.type()}: ${sanitizeText(message.text())}`,
          MAX_MESSAGES,
        );
      }
    });
    page.on("pageerror", (error) => {
      boundedPush(pageErrors, sanitizeText(error.message), MAX_MESSAGES);
    });

    try {
      await use(page);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await writeFailureSummary(
          page,
          testInfo,
          requestEvents,
          requestEventCount,
          consoleMessages,
          pageErrors,
        );
      }
    }
  },
});
