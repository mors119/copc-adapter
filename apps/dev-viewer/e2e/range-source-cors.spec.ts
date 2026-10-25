import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageEntryUrl = `/@fs/${fileURLToPath(
  new URL("../../../packages/index.ts", import.meta.url),
)}`;
const autzenFixturePath = fileURLToPath(
  new URL("../../../samples/local/autzen.copc.laz", import.meta.url),
);

type CopcResponseMode =
  | "valid"
  | "hidden"
  | "invalid-readable"
  | "status-200"
  | "short"
  | "changed-validator";

async function installCopcResponseFixture(
  page: Page,
  origin: string,
  mode: CopcResponseMode,
): Promise<string[]> {
  const copc = await readFile(autzenFixturePath);
  const methods: string[] = [];
  let getCount = 0;
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const method = request.method();
    methods.push(method);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers()["access-control-request-headers"] ?? "*",
      "Access-Control-Expose-Headers":
        mode === "hidden"
          ? "Content-Length, ETag, Last-Modified"
          : "Content-Length, Content-Range, ETag, Last-Modified",
      "Accept-Ranges": "bytes",
      ETag: '"autzen-fixture-v1"',
      "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
    };
    if (method === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (method === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "Content-Length": String(copc.byteLength) },
      });
      return;
    }

    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range ?? "");
    if (!range) {
      await route.fulfill({ status: 400, headers: corsHeaders });
      return;
    }
    getCount += 1;
    const start = Number(range[1]);
    const end = Number(range[2]);
    let body = copc.subarray(start, end + 1);
    if (mode === "short" && body.byteLength > 1) {
      body = body.subarray(0, body.byteLength - 1);
    }
    const status = mode === "status-200" ? 200 : 206;
    const contentRange =
      mode === "invalid-readable"
        ? `bytes ${start + 1}-${end}/${copc.byteLength}`
        : `bytes ${start}-${end}/${copc.byteLength}`;
    const etag =
      mode === "changed-validator" && getCount > 1
        ? '"autzen-fixture-v2"'
        : '"autzen-fixture-v1"';
    await route.fulfill({
      status,
      headers: {
        ...corsHeaders,
        "Content-Length": String(body.byteLength),
        ETag: etag,
        ...(status === 206 ? { "Content-Range": contentRange } : {}),
      },
      body,
    });
  });
  return methods;
}

async function openRemoteSource(
  page: Page,
  source: string,
  policy?: "head-fallback" | "strict",
): Promise<void> {
  const params = new URLSearchParams({ debugPanel: "0", source });
  if (policy) params.set("rangeValidation", policy);
  await page.goto(`/?${params.toString()}`);
}

async function openSourceDiagnostics(page: Page): Promise<void> {
  await page.locator("#inspector-toggle").click();
  await page.getByRole("tab", { name: "Source" }).click();
  await page
    .locator(
      '#workbench-panel-source [data-diagnostic-section="source-probe"] summary',
    )
    .click();
}

async function expectLoadedPoints(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Health" }).click();
  const renderedPoints = page.locator('[data-field="renderedPointCount"]');
  await expect
    .poll(async () =>
      Number(((await renderedPoints.textContent()) ?? "").replaceAll(",", "")),
    )
    .toBeGreaterThan(0);
}

test("default compatibility fallback works and strict mode refuses hidden Content-Range", async ({
  page,
}) => {
  test.setTimeout(30_000);
  const requests: Array<{ method: string; range?: string }> = [];
  const rangeWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "warning" &&
      message.text().includes("HEAD-based Range compatibility")
    ) {
      rangeWarnings.push(message.text());
    }
  });
  await page.route("**/range-validation-fixture.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head></head><body></body></html>",
    });
  });
  await page.route("https://range-fixture.invalid/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const range = request.headers().range;
    requests.push({ method, ...(range ? { range } : {}) });

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length",
    };
    if (method === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, "Content-Length": "4096" },
      });
      return;
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match) {
      await route.fulfill({ status: 400, headers: corsHeaders });
      return;
    }
    const offset = Number(match[1]);
    const end = Number(match[2]);
    const body = Uint8Array.from(
      { length: end - offset + 1 },
      (_value, index) => (offset + index) % 256,
    );
    await route.fulfill({
      status: 206,
      headers: {
        ...corsHeaders,
        "Content-Length": String(body.byteLength),
        "Content-Range": `bytes ${offset}-${end}/4096`,
      },
      body: Buffer.from(body),
    });
  });

  await page.goto("/range-validation-fixture.html", {
    waitUntil: "domcontentloaded",
  });
  const result = await page.evaluate(async (moduleUrl) => {
    const sourceUrl = "https://range-fixture.invalid/data.copc.laz";
    const directResponse = await fetch(sourceUrl, {
      headers: { Range: "bytes=0-0" },
    });
    const contentRangeVisible = directResponse.headers.get("Content-Range");
    const contentLengthVisible = directResponse.headers.get("Content-Length");
    await directResponse.body?.cancel();

    const module = await Promise.race([
      import(/* @vite-ignore */ moduleUrl),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("module import timed out")), 8_000);
      }),
    ]);
    const source = new module.HttpRangeByteSource(sourceUrl);
    const bytes = await Promise.race([
      source.readRange(7, 4).then((rangeBytes) => [...rangeBytes]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("range read timed out")), 8_000);
      }),
    ]);
    const secondBytes = await source
      .readRange(20, 2)
      .then((rangeBytes) => [...rangeBytes]);
    const strictSource = new module.HttpRangeByteSource(sourceUrl, {
      rangeValidation: "strict",
    });
    const strictOutcome = await strictSource.readRange(7, 4).then(
      () => ({ code: "unexpected-success" }),
      (error: { code?: string; status?: number }) => ({
        code: error.code,
        status: error.status,
      }),
    );
    return {
      contentRangeVisible,
      contentLengthVisible,
      bytes,
      secondBytes,
      strictOutcome,
    };
  }, packageEntryUrl);

  expect(result).toEqual({
    contentRangeVisible: null,
    contentLengthVisible: "1",
    bytes: [7, 8, 9, 10],
    secondBytes: [20, 21],
    strictOutcome: { code: "content-range", status: 206 },
  });
  expect(requests).toEqual([
    { method: "GET", range: "bytes=0-0" },
    { method: "GET", range: "bytes=7-10" },
    { method: "HEAD" },
    { method: "GET", range: "bytes=20-21" },
    { method: "GET", range: "bytes=7-10" },
  ]);
  expect(rangeWarnings).toHaveLength(1);
  expect(rangeWarnings[0].replace(/\n/g, " ")).toContain(
    "byte-offset correctness cannot be fully established",
  );
  expect(rangeWarnings[0]).toContain("rangeValidation: 'strict'");
});

test("loads the public Autzen source with readable Content-Range under the default policy", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const publicAutzen =
    "https://data.pointcloud.org/autzen/autzen-classified.copc.laz";
  const methods = await installCopcResponseFixture(
    page,
    "https://data.pointcloud.org/autzen",
    "valid",
  );
  const compatibilityWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.text().includes("Using HEAD-based Range compatibility validation")
    ) {
      compatibilityWarnings.push(message.text());
    }
  });

  await openRemoteSource(page, publicAutzen);
  await expect(page.locator("#source-status")).toContainText("Ready");
  await expect(page.locator("#source-selection")).toHaveValue("autzen-remote");
  await expect(
    page
      .getByRole("radiogroup", { name: "HTTP Range Validation" })
      .getByRole("radio", { name: "HEAD Fallback" }),
  ).toHaveAttribute("aria-checked", "true");
  await openSourceDiagnostics(page);
  await expect(
    page.locator('[data-field="configuredRangeValidation"]'),
  ).toHaveText("head-fallback");
  await expect(
    page.locator('[data-field="sourceProbeValidationLevel"]'),
  ).toHaveText("strict");
  await expect(page.locator('[data-field="sourceWarnings"]')).toHaveText("—");
  await expectLoadedPoints(page);
  expect(methods).toContain("GET");
  expect(methods).not.toContain("HEAD");
  expect(compatibilityWarnings).toEqual([]);
});

test("HEAD Fallback reports limited assurance and loads when Content-Range is hidden", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const origin = "https://hidden-range-fixture.invalid";
  const methods = await installCopcResponseFixture(page, origin, "hidden");
  const compatibilityWarnings: string[] = [];
  page.on("console", (message) => {
    if (
      message.text().includes("Using HEAD-based Range compatibility validation")
    ) {
      compatibilityWarnings.push(message.text());
    }
  });

  await openRemoteSource(page, `${origin}/autzen.copc.laz`);
  await expect(page.locator("#source-status")).toContainText("Ready");
  await openSourceDiagnostics(page);
  await expect(
    page.locator('[data-field="sourceProbeValidationLevel"]'),
  ).toHaveText("compatibility-limited");
  await expect(page.locator('[data-field="sourceWarnings"]')).toContainText(
    "limited validation",
  );
  await expectLoadedPoints(page);
  expect(methods).toContain("HEAD");
  expect(compatibilityWarnings).toHaveLength(1);
});

test("Strict rejects hidden Content-Range without requesting HEAD fallback", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const origin = "https://strict-hidden-range.invalid";
  const methods = await installCopcResponseFixture(page, origin, "hidden");

  await openRemoteSource(page, `${origin}/autzen.copc.laz`, "strict");
  await expect(page.locator("#configuration-error")).toContainText(
    'HTTP Range validation failed under "strict" policy',
  );
  await openSourceDiagnostics(page);
  await expect(
    page.locator('[data-field="configuredRangeValidation"]'),
  ).toHaveText("strict");
  await expect(
    page.locator('[data-field="sourceProbeValidationLevel"]'),
  ).toHaveText("incompatible");
  expect(methods).toContain("GET");
  expect(methods).not.toContain("HEAD");
});

for (const policy of ["head-fallback", "strict"] as const) {
  test(`rejects invalid readable Content-Range under ${policy}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const origin = `https://invalid-range-${policy}.invalid`;
    const methods = await installCopcResponseFixture(
      page,
      origin,
      "invalid-readable",
    );

    await openRemoteSource(page, `${origin}/autzen.copc.laz`, policy);
    await expect(page.locator("#configuration-error")).toContainText(
      "HTTP Range validation failed",
    );
    await openSourceDiagnostics(page);
    await expect(page.locator('[data-field="sourceWarnings"]')).toContainText(
      "Content-Range does not match",
    );
    expect(methods).not.toContain("HEAD");
  });
}

for (const mode of ["status-200", "short"] as const) {
  test(`rejects ${mode === "status-200" ? "HTTP 200 instead of 206" : "an incomplete partial response"}`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const origin = `https://${mode}.range-fixture.invalid`;
    const methods = await installCopcResponseFixture(page, origin, mode);

    await openRemoteSource(page, `${origin}/autzen.copc.laz`);
    await expect(page.locator("#configuration-error")).toContainText(
      "HTTP Range validation failed",
    );
    expect(methods).not.toContain("HEAD");
  });
}

test("detects a changed remote ETag between browser range reads", async ({
  page,
}) => {
  const origin = "https://changed-source-fixture.invalid";
  const methods = await installCopcResponseFixture(
    page,
    origin,
    "changed-validator",
  );
  await page.route("**/range-validation-fixture.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head></head><body></body></html>",
    });
  });
  await page.goto("/range-validation-fixture.html", {
    waitUntil: "domcontentloaded",
  });
  const outcome = await page.evaluate(
    async ({ moduleUrl, sourceUrl }) => {
      const module = await import(/* @vite-ignore */ moduleUrl);
      const source = new module.HttpRangeByteSource(sourceUrl, {
        rangeValidation: "strict",
      });
      await source.readRange(0, 8);
      return source.readRange(8, 8).then(
        () => ({ code: "unexpected-success" }),
        (error: { code?: string }) => ({ code: error.code }),
      );
    },
    {
      moduleUrl: packageEntryUrl,
      sourceUrl: `${origin}/autzen.copc.laz`,
    },
  );
  expect(outcome).toEqual({ code: "source-changed" });
  expect(methods).toContain("GET");
  expect(methods).not.toContain("HEAD");
});

test("loads the local File as a Blob without HTTP validation requests", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const methods: string[] = [];
  page.on("request", (request) => methods.push(request.method()));
  await page.goto("/?debugPanel=0");
  await expect(page.locator("#source-status")).toContainText("Ready");
  await page.locator("#local-source-file").setInputFiles(autzenFixturePath);
  await page.getByRole("button", { name: "Load selected source" }).click();
  await expect(page.locator("#source-status")).toContainText(
    "Ready · autzen.copc.laz",
  );
  await openSourceDiagnostics(page);
  await expect(page.locator('[data-field="rangeValidationScope"]')).toHaveText(
    "Not applicable · local File",
  );
  await expect(
    page.locator('[data-field="sourceProbeValidationLevel"]'),
  ).toHaveText("not applicable · local File");
  await expectLoadedPoints(page);
  expect(methods).not.toContain("HEAD");
});
