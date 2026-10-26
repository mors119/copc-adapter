import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./ci-diagnostic-fixtures";

const packageEntryUrl = `/@fs/${fileURLToPath(
  new URL("../../../packages/index.ts", import.meta.url),
)}`;
const viewerRoot = fileURLToPath(new URL("..", import.meta.url));

const remoteSources = [
  {
    label: "Autzen",
    url: "https://data.pointcloud.org/autzen/autzen-classified.copc.laz",
  },
  {
    label: "Chicago",
    url: "https://data.pointcloud.org/chicago-downtown/chicago-downtown.copc.laz",
  },
  {
    label: "SoFi",
    url: "https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz",
  },
] as const;

type SmokeResult = {
  label: string;
  host: string;
  state: "PASS" | "FAIL" | "LIMITED";
  reason: string;
  bytesRead?: number;
  firstFourBytes?: string;
  requests: Array<{
    method: string;
    range?: string;
    status?: number;
    contentRangeVisible: boolean;
    contentRange?: string;
    contentLength?: number;
    bodyLength?: number;
    error?: string;
  }>;
};

test("classifies direct browser Range reads for public COPC sources", async ({
  page,
}) => {
  test.skip(
    process.env.COPC_REMOTE_SMOKE !== "1",
    "Run only in the scheduled or manually dispatched remote browser smoke workflow",
  );
  test.setTimeout(120_000);
  await page.route("**/remote-smoke-fixture.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><head></head><body></body></html>",
    });
  });
  await page.goto("/remote-smoke-fixture.html", {
    waitUntil: "domcontentloaded",
  });

  const results: SmokeResult[] = [];
  for (const source of remoteSources) {
    const result = await page.evaluate(
      async ({ moduleUrl, sourceUrl, label }) => {
        type RequestEvidence = SmokeResult["requests"][number];
        const requests: RequestEvidence[] = [];
        const nativeFetch = window.fetch.bind(window);
        const fetchWithEvidence: typeof window.fetch = async (input, init) => {
          const range = new Headers(init?.headers).get("Range") ?? undefined;
          const method = (init?.method ?? "GET").toUpperCase();
          try {
            const response = await nativeFetch(input, init);
            const contentRange = response.headers.get("Content-Range") ?? undefined;
            const contentLengthRaw = response.headers.get("Content-Length");
            const contentLength =
              contentLengthRaw && /^\d+$/.test(contentLengthRaw)
                ? Number(contentLengthRaw)
                : undefined;
            let bodyLength: number | undefined;
            try {
              const reader = response.clone().body?.getReader();
              if (reader) {
                bodyLength = 0;
                while (bodyLength < 257) {
                  const next = await reader.read();
                  if (next.done) break;
                  bodyLength += Math.min(next.value.byteLength, 257 - bodyLength);
                }
                if (bodyLength === 257) await reader.cancel();
                reader.releaseLock();
              }
            } catch {
              // The direct browser request can be readable while the body is
              // interrupted; keep its metadata and classify it below.
            }
            requests.push({
              method,
              ...(range ? { range: range.slice(0, 80) } : {}),
              status: response.status,
              contentRangeVisible: contentRange !== undefined,
              ...(contentRange ? { contentRange: contentRange.slice(0, 120) } : {}),
              ...(contentLength !== undefined ? { contentLength } : {}),
              ...(bodyLength !== undefined ? { bodyLength } : {}),
            });
            return response;
          } catch (error) {
            requests.push({
              method,
              ...(range ? { range: range.slice(0, 80) } : {}),
              contentRangeVisible: false,
              error: error instanceof Error ? error.name : "fetch failed",
            });
            throw error;
          }
        };

        const module = await import(/* @vite-ignore */ moduleUrl);
        const byteSource = new module.HttpRangeByteSource(sourceUrl, {
          fetch: fetchWithEvidence,
        });
        let bytes: Uint8Array | undefined;
        let adapterError: string | undefined;
        try {
          bytes = await byteSource.readRange(0, 256);
        } catch (error) {
          const candidate = error as { code?: string; name?: string };
          adapterError = candidate.code ?? candidate.name ?? "read failed";
        }

        const get = requests.find((request) => request.method === "GET");
        const host = new URL(sourceUrl).hostname;
        if (!get || get.status !== 206) {
          return {
            label,
            host,
            state: "LIMITED" as const,
            reason: get?.status
              ? `upstream returned HTTP ${get.status}`
              : "browser could not read the upstream response (network or CORS prerequisite)",
            ...(bytes ? { bytesRead: bytes.byteLength } : {}),
            requests,
          };
        }

        if (!get.contentRangeVisible) {
          return {
            label,
            host,
            state: "LIMITED" as const,
            reason: adapterError
              ? `Content-Range is hidden and compatibility fallback failed (${adapterError})`
              : "Content-Range is hidden from JavaScript; byte-offset validation is compatibility-limited",
            ...(bytes ? { bytesRead: bytes.byteLength } : {}),
            requests,
          };
        }

        const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          get.contentRange ?? "",
        );
        if (
          !contentRange ||
          Number(contentRange[1]) !== 0 ||
          Number(contentRange[2]) !== 255 ||
          get.bodyLength !== 256
        ) {
          return {
            label,
            host,
            state: "LIMITED" as const,
            reason: "upstream did not return the requested 256-byte partial response",
            ...(bytes ? { bytesRead: bytes.byteLength } : {}),
            requests,
          };
        }

        if (adapterError || !bytes || bytes.byteLength !== 256) {
          return {
            label,
            host,
            state: "FAIL" as const,
            reason: `adapter rejected a browser-readable valid Range response (${adapterError ?? "wrong byte count"})`,
            ...(bytes ? { bytesRead: bytes.byteLength } : {}),
            requests,
          };
        }

        const firstFourBytes = String.fromCharCode(...bytes.slice(0, 4));
        if (firstFourBytes !== "LASF") {
          return {
            label,
            host,
            state: "LIMITED" as const,
            reason: "upstream response is not a LAS/COPC header",
            bytesRead: bytes.byteLength,
            firstFourBytes,
            requests,
          };
        }
        return {
          label,
          host,
          state: "PASS" as const,
          reason: "browser read the requested bytes with matching exposed Content-Range",
          bytesRead: bytes.byteLength,
          firstFourBytes,
          requests,
        };
      },
      { moduleUrl: packageEntryUrl, sourceUrl: source.url, label: source.label },
    );
    results.push(result);
    console.log(`COPC_REMOTE_SMOKE ${JSON.stringify(result)}`);
  }

  const outputPath = path.join(
    viewerRoot,
    "test-results",
    "remote-smoke",
    "results.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(results, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  expect(results).toHaveLength(remoteSources.length);
  const failures = results.filter((result) => result.state === "FAIL");
  expect(
    failures,
    `Direct browser smoke detected adapter failures: ${JSON.stringify(
      failures.map(({ host, reason }) => ({ host, reason }),
    )).slice(0, 1000)}`,
  ).toHaveLength(0);
});
