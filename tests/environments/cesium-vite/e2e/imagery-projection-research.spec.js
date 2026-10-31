import { createServer } from "node:http";
import { cpus, platform, release } from "node:os";
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

const width = 16;
const height = 16;
const requestPath = "/research-imagery/{z}/{x}/{y}.png";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function createSyntheticTile() {
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      scanlines[offset] = x * 16;
      scanlines[offset + 1] = y * 16;
      scanlines[offset + 2] = (x + y) * 8;
      scanlines[offset + 3] = x >= width / 2 && y >= height / 2 ? 0 : 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const syntheticTile = createSyntheticTile();

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("samples deterministic RGBA tiles through public Cesium APIs and records bounded CPU costs", async ({
  page,
  browser,
}) => {
  let sameOriginRequests = 0;
  const sameOriginPathRequests = [];
  await page.route("**/research-imagery/**", async (route) => {
    sameOriginRequests += 1;
    sameOriginPathRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: syntheticTile,
    });
  });

  await page.goto("/imagery-research/");
  await page.waitForFunction(() => window.__IMAGERY_RESEARCH_READY__ === true);

  const result = await page.evaluate(
    async ({ template, width, height, count }) => {
      const Cesium = window.Cesium;
      const providerRequestCounts = new Map();
      const requestTile = async (provider, x, y, level) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          providerRequestCounts.set(
            provider,
            (providerRequestCounts.get(provider) ?? 0) + 1,
          );
          const image = provider.requestImage(x, y, level);
          if (image !== undefined) return image;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Cesium kept throttling tile ${level}/${x}/${y}`);
      };
      const providerFor = (tilingScheme, url = template) =>
        new Cesium.UrlTemplateImageryProvider({
          url,
          tilingScheme,
          tileWidth: width,
          tileHeight: height,
          maximumLevel: 2,
          credit: "Repository-generated coordinate-coded research fixture",
          enablePickFeatures: false,
        });

      const imageToRaster = (image) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const rawPixels = context.getImageData(0, 0, width, height).data;
        const northUpPixels = new Uint8Array(rawPixels.length);
        for (let row = 0; row < height; row += 1) {
          const sourceOffset = (height - row - 1) * width * 4;
          northUpPixels.set(
            rawPixels.subarray(sourceOffset, sourceOffset + width * 4),
            row * width * 4,
          );
        }
        return northUpPixels;
      };

      const fixtureScheme = new Cesium.GeographicTilingScheme({
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1,
      });
      const fixtureProvider = providerFor(fixtureScheme);
      const coldStart = performance.now();
      const fixtureImage = await requestTile(fixtureProvider, 0, 0, 0);
      const fixturePixels = imageToRaster(fixtureImage);
      const coldTileMs = performance.now() - coldStart;

      const rasterCaches = new Map([
        [fixtureProvider, new Map([["0/0/0", fixturePixels]])],
      ]);
      const rasterRequests = new Map();
      const getRaster = async (provider, level, tile) => {
        const key = `${level}/${tile.x}/${tile.y}`;
        let cache = rasterCaches.get(provider);
        if (!cache) {
          cache = new Map();
          rasterCaches.set(provider, cache);
        }
        const cached = cache.get(key);
        if (cached) return cached;
        let providerRequests = rasterRequests.get(provider);
        if (!providerRequests) {
          providerRequests = new Map();
          rasterRequests.set(provider, providerRequests);
        }
        let request = providerRequests.get(key);
        if (!request) {
          request = requestTile(provider, tile.x, tile.y, level)
            .then(imageToRaster)
            .then((pixels) => {
              cache.set(key, pixels);
              return pixels;
            });
          providerRequests.set(key, request);
        }
        try {
          return await request;
        } finally {
          providerRequests.delete(key);
        }
      };
      const fixtureCache = rasterCaches.get(fixtureProvider);
      const warmCacheStart = performance.now();
      for (let hit = 0; hit < count; hit += 1) {
        if (fixtureCache.get("0/0/0") !== fixturePixels) {
          throw new Error("Warm tile cache lookup missed the decoded raster");
        }
      }
      const warmCacheLookupMs = performance.now() - warmCacheStart;
      const sample = async (provider, scheme, level, longitude, latitude) => {
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const tile = scheme.positionToTileXY(cartographic, level);
        const pixels = await getRaster(provider, level, tile);
        const pointRectangle = new Cesium.Rectangle(
          cartographic.longitude,
          cartographic.latitude,
          cartographic.longitude,
          cartographic.latitude,
        );
        const nativePoint = scheme.rectangleToNativeRectangle(pointRectangle);
        const rectangle = scheme.tileXYToNativeRectangle(tile.x, tile.y, level);
        const column = Math.max(
          0,
          Math.min(width - 1, Math.floor(((nativePoint.west - rectangle.west) / (rectangle.east - rectangle.west)) * width)),
        );
        const row = Math.max(
          0,
          Math.min(height - 1, Math.floor(((rectangle.north - nativePoint.north) / (rectangle.north - rectangle.south)) * height)),
        );
        const offset = (row * width + column) * 4;
        return {
          tile: { x: tile.x, y: tile.y, level },
          pixel: { column, row },
          rgba: Array.from(pixels.subarray(offset, offset + 4)),
        };
      };

      const geographic = await Promise.all([
        [-90, 60, [64, 32, 48, 255]],
        [90, 60, [192, 32, 112, 255]],
        [-90, -45, [64, 192, 128, 255]],
        [90, -45, [0, 0, 0, 0]],
        [-0.001, 45, [112, 64, 88, 255]],
        [0.001, 45, [128, 64, 96, 255]],
        [-90, 0.001, [64, 112, 88, 255]],
        [-90, -0.001, [64, 128, 96, 255]],
      ].map(async ([longitude, latitude, expected]) => {
        const value = sample(fixtureProvider, fixtureScheme, 0, longitude, latitude);
        const sampled = await value;
        if (JSON.stringify(sampled.rgba) !== JSON.stringify(expected)) {
          throw new Error(`Geographic sample mismatch at ${longitude},${latitude}: ${JSON.stringify(sampled)}`);
        }
        return { longitude, latitude, ...sampled };
      }));

      const mercatorScheme = new Cesium.WebMercatorTilingScheme();
      const mercatorProvider = providerFor(mercatorScheme);
      const mercator = await sample(mercatorProvider, mercatorScheme, 0, -90, 60);
      if (JSON.stringify(mercator.rgba) !== JSON.stringify([64, 64, 64, 255])) {
        throw new Error(`Web Mercator northing sample mismatch: ${JSON.stringify(mercator)}`);
      }

      const boundaryScheme = new Cesium.GeographicTilingScheme({
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1,
      });
      const boundaryAt = (longitude, latitude) => {
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const tile = boundaryScheme.positionToTileXY(cartographic, 1);
        return { x: tile.x, y: tile.y };
      };
      const boundaryTiles = {
        west: boundaryAt(-0.001, 20),
        east: boundaryAt(0.001, 20),
        north: boundaryAt(20, 0.001),
        south: boundaryAt(20, -0.001),
      };
      if (
        boundaryTiles.west.x !== 0 ||
        boundaryTiles.east.x !== 1 ||
        boundaryTiles.north.y !== 0 ||
        boundaryTiles.south.y !== 1
      ) {
        throw new Error(`Unexpected geographic tile-boundary ownership: ${JSON.stringify(boundaryTiles)}`);
      }
      const seamSamples = await Promise.all([
        sample(fixtureProvider, boundaryScheme, 1, -0.001, 20),
        sample(fixtureProvider, boundaryScheme, 1, 0.001, 20),
        sample(fixtureProvider, boundaryScheme, 1, 20, 0.001),
        sample(fixtureProvider, boundaryScheme, 1, 20, -0.001),
      ]);
      const expectedSeamPixels = [
        { tile: { x: 0, y: 0, level: 1 }, pixel: { column: 15, row: 12 }, rgba: [0, 0, 0, 0] },
        { tile: { x: 1, y: 0, level: 1 }, pixel: { column: 0, row: 12 }, rgba: [0, 192, 96, 255] },
        { tile: { x: 1, y: 0, level: 1 }, pixel: { column: 1, row: 15 }, rgba: [16, 240, 128, 255] },
        { tile: { x: 1, y: 1, level: 1 }, pixel: { column: 1, row: 0 }, rgba: [16, 0, 8, 255] },
      ];
      if (JSON.stringify(seamSamples) !== JSON.stringify(expectedSeamPixels)) {
        throw new Error(`Tile-seam samples mismatch: ${JSON.stringify(seamSamples)}`);
      }

      const coordinates = new Float64Array(count * 3);
      for (let index = 0; index < count; index += 1) {
        coordinates[index * 3] = -179.9 + ((index * 7919) % 35980) / 100;
        coordinates[index * 3 + 1] = -89.9 + ((index * 3571) % 17980) / 100;
        coordinates[index * 3 + 2] = index % 50;
      }
      const outputColors = new Uint8Array(count * 4);
      const cartographic = new Cesium.Cartographic();
      const tileXY = new Cesium.Cartesian2();
      const pointRectangle = new Cesium.Rectangle(0, 0, 0, 0);
      const nativePoint = new Cesium.Rectangle(0, 0, 0, 0);
      const rectangle = fixtureScheme.tileXYToNativeRectangle(0, 0, 0);
      const benchmarkStart = performance.now();
      for (let index = 0; index < count; index += 1) {
        cartographic.longitude = Cesium.Math.toRadians(coordinates[index * 3]);
        cartographic.latitude = Cesium.Math.toRadians(coordinates[index * 3 + 1]);
        fixtureScheme.positionToTileXY(cartographic, 0, tileXY);
        pointRectangle.west = cartographic.longitude;
        pointRectangle.east = cartographic.longitude;
        pointRectangle.south = cartographic.latitude;
        pointRectangle.north = cartographic.latitude;
        fixtureScheme.rectangleToNativeRectangle(pointRectangle, nativePoint);
        const column = Math.max(
          0,
          Math.min(width - 1, Math.floor(((nativePoint.west - rectangle.west) / (rectangle.east - rectangle.west)) * width)),
        );
        const row = Math.max(
          0,
          Math.min(height - 1, Math.floor(((rectangle.north - nativePoint.north) / (rectangle.north - rectangle.south)) * height)),
        );
        const inputOffset = (row * width + column) * 4;
        const outputOffset = index * 4;
        outputColors[outputOffset] = fixturePixels[inputOffset];
        outputColors[outputOffset + 1] = fixturePixels[inputOffset + 1];
        outputColors[outputOffset + 2] = fixturePixels[inputOffset + 2];
        outputColors[outputOffset + 3] = fixturePixels[inputOffset + 3];
      }
      const samplePassMs = performance.now() - benchmarkStart;
      const cachedRgbaBytes = [...rasterCaches.values()]
        .flatMap((cache) => [...cache.values()])
        .reduce((bytes, pixels) => bytes + pixels.byteLength, 0);

      const levelOneTiles = fixtureScheme.getNumberOfXTilesAtLevel(1) *
        fixtureScheme.getNumberOfYTilesAtLevel(1);
      return {
        cesiumVersion: Cesium.VERSION,
        coordinateSamples: geographic,
        webMercatorSample: mercator,
        boundaryTiles,
        seamSamples,
        fixtureTileCacheEntries: fixtureCache.size,
        mercatorTileCacheEntries: rasterCaches.get(mercatorProvider).size,
        fixtureProviderRequests: providerRequestCounts.get(fixtureProvider),
        mercatorProviderRequests: providerRequestCounts.get(mercatorProvider),
        tileWidth: fixturePixels.length / 4 / height,
        tileHeight: height,
        fixtureDecodedBytes: fixturePixels.byteLength,
        cachedRgbaBytes,
        pointCount: count,
        pointColorBytes: outputColors.byteLength,
        retainedRgbaBytes: cachedRgbaBytes + outputColors.byteLength,
        pointsPerSecond: Math.round(count / (samplePassMs / 1000)),
        samplePassMs,
        coldTileMs,
        warmCacheLookupMs,
        warmCacheLookups: count,
        warmTileNetworkRequests: 0,
        tileCountAtLevelOne: levelOneTiles,
        requestsForOneRootTile: 1,
      };
    },
    {
      template: requestPath,
      width,
      height,
      count: 100_000,
    },
  );

  expect(result.cesiumVersion).toBe("1.142.0");
  expect(result.coordinateSamples).toHaveLength(8);
  expect(result.webMercatorSample.rgba).toEqual([64, 64, 64, 255]);
  expect(result.boundaryTiles).toEqual({
    west: { x: 0, y: 0 },
    east: { x: 1, y: 0 },
    north: { x: 1, y: 0 },
    south: { x: 1, y: 1 },
  });
  expect(result.seamSamples).toHaveLength(4);
  expect(result.fixtureTileCacheEntries).toBe(4);
  expect(result.mercatorTileCacheEntries).toBe(1);
  expect(result.fixtureProviderRequests).toBe(4);
  expect(result.mercatorProviderRequests).toBe(1);
  expect(result.cachedRgbaBytes).toBe(5_120);
  expect(result.requestsForOneRootTile).toBe(1);
  expect(result.pointColorBytes).toBe(400_000);
  expect(result.retainedRgbaBytes).toBe(405_120);
  expect(sameOriginRequests).toBe(5);
  expect([...sameOriginPathRequests].sort()).toEqual([
    "/research-imagery/0/0/0.png",
    "/research-imagery/0/0/0.png",
    "/research-imagery/1/0/0.png",
    "/research-imagery/1/1/0.png",
    "/research-imagery/1/1/1.png",
  ].sort());

  console.log(
    "[imagery-research-metrics]",
    JSON.stringify({
      ...result,
      browserVersion: browser.version(),
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      sameOriginRequests,
      sameOriginPathRequests,
    }),
  );
});

test("proves canvas readability needs CORS and failures stay explicit", async ({
  page,
}) => {
  const corsServer = createServer((request, response) => {
    if (request.url === "/missing.png") {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("missing fixture tile");
      return;
    }
    response.setHeader("Content-Type", "image/png");
    if (request.url === "/cors.png") {
      response.setHeader("Access-Control-Allow-Origin", "*");
    }
    response.end(syntheticTile);
  });
  const corsPort = await listen(corsServer);

  try {
    await page.goto("/imagery-research/");
    await page.waitForFunction(() => window.__IMAGERY_RESEARCH_READY__ === true);
    const result = await page.evaluate(async ({ corsPort, width, height }) => {
      const Cesium = window.Cesium;
      const scheme = new Cesium.GeographicTilingScheme({
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1,
      });
      const read = async (path) => {
        const provider = new Cesium.UrlTemplateImageryProvider({
          url: `http://127.0.0.1:${corsPort}${path}`,
          tilingScheme: scheme,
          tileWidth: width,
          tileHeight: height,
          maximumLevel: 0,
          enablePickFeatures: false,
        });
        try {
          let image;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            image = provider.requestImage(0, 0, 0);
            if (image !== undefined) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (image === undefined) return { readable: false, reason: "throttled" };
          const loaded = await image;
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(loaded, 0, 0);
          const pixel = Array.from(context.getImageData(0, 0, 1, 1).data);
          return { readable: true, pixel };
        } catch (error) {
          return { readable: false, reason: String(error) };
        }
      };
      const noCorsImage = new Image();
      noCorsImage.src = `http://127.0.0.1:${corsPort}/no-cors.png`;
      await new Promise((resolve, reject) => {
        noCorsImage.onload = resolve;
        noCorsImage.onerror = () => reject(new Error("no-CORS HTML image did not load"));
      });
      const taintCanvas = document.createElement("canvas");
      taintCanvas.width = width;
      taintCanvas.height = height;
      const taintContext = taintCanvas.getContext("2d");
      taintContext.drawImage(noCorsImage, 0, 0);
      let canvasTaint;
      try {
        taintContext.getImageData(0, 0, 1, 1);
        canvasTaint = { tainted: false };
      } catch (error) {
        canvasTaint = { tainted: true, errorName: error.name };
      }
      return {
        cors: await read("/cors.png"),
        noCors: await read("/no-cors.png"),
        failedTile: await read("/missing.png"),
        canvasTaint,
      };
    }, { corsPort, width, height });

    expect(result.cors).toEqual({ readable: true, pixel: [0, 240, 120, 255] });
    expect(result.noCors.readable).toBe(false);
    expect(result.failedTile.readable).toBe(false);
    expect(result.canvasTaint).toEqual({ tainted: true, errorName: "SecurityError" });
    console.log("[imagery-research-cors]", JSON.stringify(result));
  } finally {
    await close(corsServer);
  }
});

test("live USGSImageryOnly tile is CORS readable when explicitly enabled", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.COPC_IMAGERY_EXTERNAL_SMOKE !== "1",
    "Set COPC_IMAGERY_EXTERNAL_SMOKE=1 to probe the live USGS service.",
  );

  await page.goto("/imagery-research/");
  await page.waitForFunction(() => window.__IMAGERY_RESEARCH_READY__ === true);
  const network = [];
  page.on("response", async (response) => {
    if (!response.url().includes("USGSImageryOnly/MapServer/tile/")) return;
    const headers = response.headers();
    network.push({
      status: response.status(),
      contentType: headers["content-type"],
      contentLength: headers["content-length"],
      accessControlAllowOrigin: headers["access-control-allow-origin"],
      date: headers.date,
    });
  });

  const result = await page.evaluate(async () => {
    const Cesium = window.Cesium;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 23,
      credit: "USDA, USGS The National Map: Orthoimagery",
      enablePickFeatures: false,
    });
    const location = Cesium.Cartographic.fromDegrees(
      -123.0664124403,
      44.0563024781,
    );
    const level = 16;
    const tile = provider.tilingScheme.positionToTileXY(location, level);
    const startedAt = performance.now();
    let image;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      image = provider.requestImage(tile.x, tile.y, level);
      if (image !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (image === undefined) throw new Error("USGS tile request remained throttled");
    const loaded = await image;
    const canvas = document.createElement("canvas");
    canvas.width = provider.tileWidth;
    canvas.height = provider.tileHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(loaded, 0, 0);
    const pointRectangle = new Cesium.Rectangle(
      location.longitude,
      location.latitude,
      location.longitude,
      location.latitude,
    );
    const nativePoint = provider.tilingScheme.rectangleToNativeRectangle(pointRectangle);
    const native = provider.tilingScheme.tileXYToNativeRectangle(
      tile.x,
      tile.y,
      level,
    );
    const column = Math.max(
      0,
      Math.min(
        provider.tileWidth - 1,
        Math.floor(((nativePoint.west - native.west) / (native.east - native.west)) * provider.tileWidth),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        provider.tileHeight - 1,
        Math.floor(((native.north - nativePoint.north) / (native.north - native.south)) * provider.tileHeight),
      ),
    );
    return {
      cesiumVersion: Cesium.VERSION,
      tile: { x: tile.x, y: tile.y, level },
      tileSize: [provider.tileWidth, provider.tileHeight],
      samplePixel: { column, row },
      rgba: Array.from(context.getImageData(column, row, 1, 1).data),
      requestAndDecodeMs: performance.now() - startedAt,
    };
  });

  expect(result.cesiumVersion).toBe("1.142.0");
  expect(result.tileSize).toEqual([256, 256]);
  expect(result.rgba).toHaveLength(4);
  await expect.poll(() => network.length).toBe(1);
  expect(network[0].status).toBe(200);
  expect(network[0].accessControlAllowOrigin).toBe("*");
  console.log(
    "[imagery-research-usgs]",
    JSON.stringify({ ...result, response: network[0], testRetry: testInfo.retry }),
  );
});
