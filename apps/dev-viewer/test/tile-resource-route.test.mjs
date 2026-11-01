import assert from "node:assert/strict";
import { test } from "node:test";
import { registerCesiumTileXhrRoute } from "../src/cesiumTileXhrRoute.ts";
import { registerTileResourceRoute } from "../src/tileResourceRoute.ts";

test("routes Tiles resources to their own server and restores fetch after final close", async () => {
  const previousWindow = globalThis.window;
  let fallbackCalls = 0;
  const origin = "http://viewer.test";
  const fallbackFetch = async () => {
    fallbackCalls += 1;
    return new Response("fallback");
  };
  globalThis.window = {
    location: { href: `${origin}/` , origin },
    fetch: fallbackFetch,
  };

  const requests = [];
  const server = (label) => ({
    async handle(request) {
      requests.push({ label, url: request.url, method: request.method });
      const body = `${label}:${new URL(request.url).pathname}`;
      return new Response(body, {
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    },
    async close() {},
  });

  try {
    const first = registerTileResourceRoute(server("first"));
    const firstRoutedFetch = globalThis.window.fetch;
    const second = registerTileResourceRoute(server("second"));
    assert.equal(globalThis.window.fetch, firstRoutedFetch);

    const firstResponse = await globalThis.window.fetch(first.url);
    assert.equal(await firstResponse.text(), "first:/tileset.json");
    const contentResponse = await globalThis.window.fetch(
      new Request(first.url.replace("tileset.json", "content/root.glb")),
    );
    assert.equal(await contentResponse.text(), "first:/content/root.glb");
    assert.equal(first.getMetrics().tilesetRequestCount, 1);
    assert.equal(first.getMetrics().glbRequestCount, 1);
    assert.equal(first.getMetrics().glbBytes, Buffer.byteLength("first:/content/root.glb"));

    const secondResponse = await globalThis.window.fetch(second.url);
    assert.equal(await secondResponse.text(), "second:/tileset.json");
    assert.equal(second.getMetrics().tilesetRequestCount, 1);
    assert.deepEqual(requests.map(({ label }) => label), ["first", "first", "second"]);

    first.close();
    assert.equal(globalThis.window.fetch, firstRoutedFetch);
    const fallbackResponse = await globalThis.window.fetch(`${origin}/not-a-tile`);
    assert.equal(await fallbackResponse.text(), "fallback");
    assert.equal(fallbackCalls, 1);

    second.close();
    assert.equal(globalThis.window.fetch, fallbackFetch);
  } finally {
    if (globalThis.window.fetch !== fallbackFetch) globalThis.window.fetch = fallbackFetch;
    globalThis.window = previousWindow;
  }
});

test("routes only Cesium Tiles XHR requests through Fetch and restores its loader", async () => {
  const previousWindow = globalThis.window;
  const origin = "http://viewer.test";
  const requests = [];
  const fallbackCalls = [];
  const originalLoadWithXhr = (...args) => {
    fallbackCalls.push(args[0]);
    return "original-xhr";
  };
  const implementations = { loadWithXhr: originalLoadWithXhr };
  globalThis.window = {
    location: { href: `${origin}/`, origin },
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ route: new URL(String(url)).pathname }), {
        headers: { "content-type": "application/json" },
      });
    },
  };

  try {
    const route = registerCesiumTileXhrRoute(
      { _Implementations: implementations },
      `${origin}/_dev/copc-tiles/1/tileset.json`,
    );
    assert.notEqual(implementations.loadWithXhr, originalLoadWithXhr);

    const result = await new Promise((resolve, reject) => {
      implementations.loadWithXhr(
        `${origin}/_dev/copc-tiles/1/tileset.json`,
        "json",
        "GET",
        undefined,
        undefined,
        { resolve, reject },
      );
    });
    assert.deepEqual(result, { route: "/_dev/copc-tiles/1/tileset.json" });
    assert.equal(requests.length, 1);
    assert.equal(
      implementations.loadWithXhr(`${origin}/other.json`, "json", "GET", undefined, undefined, {}),
      "original-xhr",
    );
    assert.deepEqual(fallbackCalls, [`${origin}/other.json`]);

    route.close();
    assert.equal(implementations.loadWithXhr, originalLoadWithXhr);
  } finally {
    globalThis.window = previousWindow;
  }
});
