import assert from "node:assert/strict";
import test from "node:test";
import { isVisibleResponseHeader } from "../e2e/diagnostic-cors.ts";

const pageOrigin = "https://viewer.example";
const responseUrl = "https://data.example/point-cloud.copc.laz";

test("wildcard CORS origin follows the request credentials mode", () => {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "content-range",
  };

  assert.equal(
    isVisibleResponseHeader(responseUrl, pageOrigin, "content-range", headers),
    true,
  );
  assert.equal(
    isVisibleResponseHeader(
      responseUrl,
      pageOrigin,
      "content-range",
      headers,
      "include",
    ),
    false,
  );
});

test("exposed header wildcard follows the request credentials mode", () => {
  const headers = {
    "access-control-allow-origin": pageOrigin,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "*",
  };

  assert.equal(
    isVisibleResponseHeader(responseUrl, pageOrigin, "content-range", headers),
    true,
  );
  assert.equal(
    isVisibleResponseHeader(
      responseUrl,
      pageOrigin,
      "content-range",
      headers,
      "include",
    ),
    false,
  );
});
