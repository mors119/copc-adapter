# Issue #328: Cesium imagery-projected point color research

- **Reviewed:** 2026-10-31.
- **Status:** Technical feasibility demonstrated with a deterministic browser fixture and one live USGS tile. Provider/source rights are not cleared for product use. Do not open an implementation issue yet.
- **Scope:** Optional 2D imagery projection for COPC point display. This does not change a COPC file or its measured attributes.

Issue [#328](https://github.com/mors119/copc-adapter/issues/328) asks whether COPC points can be colored from imagery that is also available to a CesiumJS application. The result would be **synthetic imagery-projected RGB**, not measured LAS RGB. The research is deliberately separate from the point style API, option manifest, Workbench UI, and code generation.

## Decision

The Cesium tile-request and CPU sampling path works in a browser without reading Cesium's private renderer state. A local fixture proves pixel sampling, coordinate projection, transparent-pixel detection, browser CORS behavior, and a bounded one-tile/100,000-point sample. An opt-in browser probe also read a live USGS tile at the Autzen location.

**Do not proceed to a production implementation issue yet.** The USGS National Map imagery endpoint is a promising candidate for a narrow CONUS use case, but it serves a mixed mosaic. The service metadata does not identify the source image for an individual returned tile, and its `licenseInfo` field does not describe the derivative-colorization and client-cache rights for that mixed endpoint. The CORS header proves browser access, not permission. A tile/source-specific rights and service-use review is still required.

If a provider owner confirms the exact CONUS source, attribution, derivative use, and temporary browser caching in writing, a separate issue can scope an opt-in Cesium-only MVP around that exact source. Until then, there is no production API, mode, UI placeholder, or generated-code option for imagery.

## Cesium API findings

The packed consumer pins `cesium` **1.142.0** in `tests/environments/cesium-vite/package.json`. The relevant Cesium 1.142 source is [ImageryProvider](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Scene/ImageryProvider.js), [UrlTemplateImageryProvider](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Scene/UrlTemplateImageryProvider.js), [GeographicTilingScheme](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Core/GeographicTilingScheme.js), and [WebMercatorTilingScheme](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Core/WebMercatorTilingScheme.js). The [public API reference](https://cesium.com/learn/cesiumjs/ref-doc/ImageryProvider.html) documents the same provider contract.

- `ImageryProvider` is an interface, not a source of pixels for the already-composited Viewer. A concrete provider exposes its `tilingScheme`, `rectangle`, tile dimensions, level bounds, credits, an asynchronous error event, and `requestImage(x, y, level, request?)`.
- `requestImage` resolves to an image (or another documented imagery type). It can return `undefined` when Cesium's request scheduler is saturated; that means retry later, not “no coverage.” The optional `request` parameter is internal Cesium request state. The adapter should not manufacture or depend on it. The [UrlTemplate provider API](https://cesium.com/learn/cesiumjs/ref-doc/UrlTemplateImageryProvider.html) also documents `{x}` as west-to-east and `{y}` as north-to-south.
- Public [tiling-scheme methods](https://cesium.com/learn/cesiumjs/ref-doc/TilingScheme.html) map a `Cartographic` position to tile XY and map a tile to its native rectangle. `rectangleToNativeRectangle` is needed because geographic native coordinates are degrees while Web Mercator native coordinates are projected metres. Tile row zero is north in both schemes.
- `ImageryLayerCollection` exposes layer membership, order, and per-layer properties. Its imagery feature picking delegates to providers' `pickFeatures`; it does not return composited raster colors. The [Cesium imagery guide](https://cesium.com/learn/cesiumjs-learn/cesiumjs-imagery/) describes layer blending and notes WebGL's cross-origin image restrictions.

`requestImage` can therefore sample a specific provider's source tile when that tile is readable. It cannot promise the same RGB as a screen pixel in the Viewer: Viewer imagery may include several alpha-blended/reordered layers, layer brightness/contrast/gamma, a time-dependent source, reprojection, and globe rendering. The public API does not expose the final imagery composition as a CPU-readable raster. Do not read Cesium's private WebGL textures or framebuffer as a substitute.

An imagery provider is created by the host application and passed to any eventual API. Some provider factories are asynchronous; the app must await its provider creation before handing over the resulting instance. The library should not invent a URL, fetch token, or implicit default provider.

## Provider, permissions, and CORS

### USGS National Map candidate

The candidate examined was [USGSImageryOnly MapServer](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=pjson), using its cached tile path:

```text
https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}
```

The service declares Web Mercator (EPSG:3857), 256 × 256 cached tiles, and levels 0–23. Its attribution text is `USDA, USGS The National Map: Orthoimagery`. The description says most CONUS imagery comes from NAIP and its CONUS one-metre orthoimagery downloads are public domain. It also says the service can contain partner imagery and specifically says Alaska SPOT imagery is restricted from direct download. The National Map is generally marked public domain on the [USGS viewer/data page](https://www.usgs.gov/tools/national-map-viewer), and USGS asks users to acknowledge the source in its [data citation guidance](https://www.usgs.gov/centers/eros/data-citation).

These facts make a fixed, source-confirmed CONUS NAIP region a viable candidate for a later rights review. They do **not** clear every tile from `USGSImageryOnly`: its service description covers several sources and its one raster layer has no per-tile source/provenance response. The service's `licenseInfo` metadata is effectively blank. The rights review must confirm the exact returned tile's source and whether derivative point coloring and browser-side decoded-pixel caching are allowed. The endpoint's HTTP `Cache-Control: max-age=86400` is a transport cache directive, not a license grant.

The returned tile also has a date mismatch risk. The service metadata says its data was refreshed June 2024 and reports NAIP collection years 2017–2021 for CONUS. A COPC acquisition may be older or newer; imagery color is contextual display only.

| Gate | Evidence | Result |
| --- | --- | --- |
| Public Cesium integration | `UrlTemplateImageryProvider` supports the service's `{z}/{y}/{x}` tile scheme. | Pass |
| Browser CORS and pixel read | A Chromium request to the Autzen-area tile returned HTTP 200 with `Access-Control-Allow-Origin: *`; Cesium 1.142.0 decoded the JPEG and `getImageData` returned RGBA. | Pass for this probed endpoint/tile/date |
| Rights for a source-confirmed CONUS NAIP tile | USGS metadata describes public-domain CONUS NAIP downloads and the source credit. The mosaic does not expose source identity for this tile. | Conditional; source confirmation needed |
| Derivative colorization and decoded-pixel cache terms | The service metadata does not answer these questions for each mosaic source. | Unresolved |
| One provider usable for all of the service's coverage | Alaska SPOT restrictions and partner imagery are called out in the service description. | Fail; do not enable this endpoint as a world-wide default |

### Browser security result

The checked-in deterministic browser test serves the same synthetic tile from a second local origin:

- With `Access-Control-Allow-Origin: *`, the public Cesium provider request succeeds and the canvas returns RGBA.
- Without CORS, Cesium's provider request fails with `Request has failed.` A normal cross-origin `<img>` can display the same response, but drawing it to a canvas causes `getImageData` to throw `SecurityError`.
- A 404 tile fails explicitly. There is no proxy, CORS bypass, or fallback to reading the Viewer framebuffer.

The live USGS check is opt-in and is not part of the normal suite. On 2026-10-31, from the recorded test environment, the Autzen-area tile at level 16, x=10364, y=23815 returned as JPEG (HTTP 200, 27,974 bytes, `Access-Control-Allow-Origin: *`, HTTP `Date: Fri, 30 Oct 2026 21:28:44 GMT`). Cesium decoded it and a canvas pixel read succeeded. This proves the sampled endpoint was technically readable at that time; CORS can change and this result says nothing about derivative rights.

## Coordinate and pixel semantics

The existing prepared point data retains WGS84 geographic longitude/latitude in degrees, as well as source and ECEF coordinates (`packages/adapter/core/copc/types/copc.ts`, `packages/adapter/core/point/preparedPoint.ts`). A future Cesium colorizer should consume those already-prepared geographic values; it must not reinterpret raw COPC X/Y as longitude/latitude. The source CRS must be recognized by the existing coordinate pipeline. Unknown datum realization/epoch or unsupported horizontal CRS means no imagery sample; imagery is not a way to hide a bad CRS transformation.

For each valid point, the algorithm should:

1. Convert its prepared longitude/latitude into the provider's cartographic position.
2. Ask the provider tiling scheme for tile XY at the explicit selected level.
3. Convert the point and tile rectangle into the tiling scheme's native coordinates, then compute the pixel column and north-origin row.
4. Sample one decoded tile raster. The research fixture uses nearest-neighbor sampling and proves pixel boundaries on either side of longitude zero and latitude zero. The Web Mercator check deliberately distinguishes projected northing from linear latitude: the same point maps to fixture row 2 in the geographic scheme and row 4 in Web Mercator.

The browser test found that the image returned by Cesium 1.142.0 reads vertically flipped when drawn into a 2D canvas (`getImageData` top-left returned the PNG's bottom row). A CPU implementation must normalize that image orientation before applying north-origin tile rows. It must retain a regression for this behavior across supported Cesium versions.

Nearest sampling is the MVP candidate because it preserves the source pixel and gives deterministic boundary semantics. Bilinear sampling is a later option: it needs explicit handling for tile seams, alpha/no-data neighbors, and color-space interpolation. A coordinate outside the provider rectangle, a failed/timed-out tile, invalid prepared coordinate, or fully transparent pixel falls back to the selected existing point color mode and records a diagnostic. Never leave stale imagery RGB from an earlier provider/time generation. Partial alpha behavior needs its own fixture decision before implementation.

This is 2D orthophoto projection. The same XY pixel is applied at every point height. It cannot recover the color of a wall face, tree trunk, underpass, or other occluded surface and is not a terrain-height, vertical-datum, or textured 3D Tiles material sampler. Oblique non-orthorectified source imagery adds displacement. Imagery timestamp and horizontal CRS/epoch limitations must be shown to the user.

## Architecture and bounds

The existing Cesium path already produces point colors on CPU: `packages/adapter/core/point/style/pointStyle.ts` feeds the batched geometry renderer, while the point-primitive renderer computes per-point colors. The shared streaming cache retains prepared coordinates, so a Cesium-only sampler can color already-decoded/visible nodes without downloading a whole COPC or decoding source points a second time. The sampler should remain inside the Cesium package; a `Cesium.ImageryProvider` is not renderer-neutral and does not make the Three renderer support imagery.

| Approach | Fit to current code | Costs and limits |
| --- | --- | --- |
| CPU: request each unique tile once, read its RGBA array once, sample prepared points into a per-node color buffer | Best MVP fit. Reuses prepared geographic coordinates and existing point color-buffer/upload paths. | Main-thread coordinate/pixel loop unless moved to a Worker; color buffer and decoded-pixel cache consume CPU memory. Recolor/update can add latency after first visible points. |
| GPU: attach UV/tile selection and sample imagery textures in a custom point shader | Could reduce CPU per-point work after texture upload. | Requires texture ownership/duplication or Cesium-private texture access, custom atlas/layer updates, shader changes for both renderers, and deterministic alpha/tile invalidation. It still samples a chosen provider, not Viewer-composited pixels. Poor first implementation. |

Starting caps for a bounded implementation experiment (to be measured before becoming public defaults): at most 16 unique tiles for one prepared node, 4 in-flight image requests per layer, a 32 MiB decoded RGBA LRU, and no more than the existing selected-node point budget. A 256 × 256 RGBA tile occupies 262,144 bytes before temporary canvas/browser copies; 32 MiB holds 128 such rasters. A 1,000,000-point RGBA output is another 4,000,000 bytes. Budget transient decode copies and Cesium's own GPU textures separately; the Cesium scene may keep its own copy outside this sampler's LRU.

Deduplicate on provider identity/generation plus level/X/Y. A host that changes time, URL, credentials, projection, or provider must advance the generation and invalidate the old cache. Share one promise per tile key; never request one image per point. `requestImage` has no public `AbortSignal` contract. On node/style disposal, stop consuming stale results and do not start more queued requests; count in-flight requests against the cap until their promises settle. Ignore stale completions by generation. Do not claim network cancellation that Cesium does not provide.

## Illustrative API only

This is a design sketch, **not a proposed committed public signature**. The current `colorMode` and all RGB/intensity/elevation/classification/dimension behavior remain as-is unless the host explicitly supplies an imagery style. A supplied imagery style is opt-in and may override existing RGB where a valid imagery pixel exists; transparent, uncovered, failed, or unsupported pixels use the existing color mode.

```ts
type ImageryStyleDraft = {
  provider: Cesium.ImageryProvider; // supplied and licensed by the host app
  level: number;                    // fixed initially; no hidden scene-zoom guess
  sampling: "nearest";
  fallback: "existing-color-mode";
  revision: string;                 // host changes this for time/source changes
};

new CopcCesiumLayer({
  url,
  colorMode: "rgb", // existing mode remains the fallback
  imageryStyle: {
    provider: appOwnedProvider,
    level: 16,
    sampling: "nearest",
    fallback: "existing-color-mode",
    revision: "naip-2020-region-a",
  },
});
```

The provider instance and any credentials are non-serializable resources. Share URLs and generated snippets must not serialize a provider object or token. Generated code should show the app's explicit provider construction and licensing/credit responsibility, then pass that instance at runtime. Workbench option manifests, capabilities, `#397`/`#314` controls, and `#399` copy output should only learn this mode after a separately implemented and released feature is approved; no inactive imagery option belongs in npm 0.6.0.

The point inspection panel, legend, and examples must say **synthetic imagery-projected RGB** whenever this style is active. Keep the original LAS RGB and other COPC attributes unchanged and available for inspection. For RGB-present data, supplying the imagery style is the explicit override; without it, existing color modes behave as they do now.

## Deterministic browser evidence and performance

The new research browser spec (`tests/environments/cesium-vite/e2e/imagery-projection-research.spec.js`) constructs its fixture PNG from source code under this repository's Apache-2.0 license. It is a synthetic coordinate-coded 16 × 16 RGBA tile with an alpha-zero southeast quadrant; it contains no third-party image data. It tests known pixel samples, geographic/Web Mercator projection, tile seam ownership, north/south orientation, a shared in-flight tile request, CORS-readable and non-CORS responses, transparent pixels, and a failed tile.

Run from `tests/environments/cesium-vite`:

```sh
npm install --no-save --package-lock=false
npm run test:imagery-research
COPC_IMAGERY_EXTERNAL_SMOKE=1 npm run test:imagery-research -- --grep 'live USGSImageryOnly'
```

The install step is needed for a clean checkout of this consumer template, which has no local lockfile. It installs the manifest dependencies without changing the manifest or creating a lockfile.

The first command passed on 2026-10-31; the opt-in live command also passed. The live command is excluded unless its environment flag is set. The final local run reported:

| Measurement | Result | Conditions |
| --- | ---: | --- |
| Cesium / Chromium | 1.142.0 / 156.0.8078.74 | macOS Darwin 25.6, Apple M2, headless Chromium using SwiftShader config |
| Known point samples | 8/8 matched; 4/4 tile-edge samples matched | Geographic pixels, transparent pixel, both sides of lon/lat zero, geographic/Web Mercator projection, and three neighboring level-1 tiles |
| Cold local tile request + decode | 4.2 ms | One same-origin synthetic 16 × 16 PNG; no real-provider latency |
| Warm tile cache | 100,000 cache lookups in 1.1 ms; 0 additional image requests | Same process; the timed root-tile sampling reused the already decoded raster |
| CPU sampling | 100,000 prepared geographic points in 7.3 ms (13.70 million points/s) | One synthetic root tile; per-point projection and nearest RGBA copy only; no COPC decode, renderer update, visible-point measurement, worker transfer, or browser GPU cost |
| Retained RGBA arrays | 405,120 B: five cached 1,024 B tiles plus a 400,000 B point color buffer | Exact typed-array storage at the sample; excludes browser image objects, temporary canvas backing stores, existing coordinates, allocator overhead, and Cesium GPU textures |
| Tile request/dedup | 5 requests: four for the geographic provider, one for the Web Mercator provider | Four seam samples shared three unique level-1 tiles; the two geographic samples in the same tile shared one in-flight request. The 100,000-point timed pass made no tile request |

The separate live USGS tile request and decode took 1,023.8 ms in this single run. That is a provider/network observation, not an end-to-end point `firstVisible` measurement. If a future layer waits for imagery before rendering points, this wait could become added first-visible delay; the MVP should render existing-mode fallback colors first and recolor asynchronously. The fixture contains no COPC layer, so first-visible impact, renderer upload, and actual COPC re-decode count remain unmeasured. Structural review shows the proposed path consumes prepared cached geographic points and therefore needs no second COPC decode.

These figures confirm the sample loop and explicit typed-array byte budget are measurable, not that a production feature meets a latency target. The 16 × 16 fixture is smaller than provider tiles. A feature spike must profile at least 256 × 256 tiles and realistic streamed node sizes against the production Cesium point renderers, with cold/warm cache, many tile crossings, eviction, and first-visible timing. Browser image/canvas/GPU memory was not captured in this fixture.

## Implementation gate / next validation

Before opening the separate implementation issue, obtain provider-specific confirmation for a source-identifiable CONUS NAIP area and verify its derivative-colorization, attribution, rate-limit, and temporary browser-cache terms. Then run the live smoke at that exact source with its CORS policy and attribution preserved. If source provenance cannot be tied to a returned tile, choose a service that exposes a single licensed source or keep the feature host-provider-only with license validation left to the host.

The next bounded browser/performance spike should measure cold/warm requests, request deduplication, four-request concurrency, cancellation/stale completion, 16-tile/node rejection, LRU eviction at 32 MiB, alpha/no-data/coverage fallback, Web Mercator and geographic seams, and memory for 100k/500k/1M point color buffers. It must also report first visible point time and compare the existing point-primitive and batched Cesium renderers, without re-decoding COPC. Do not benchmark or promise Three renderer support in this Cesium-only research.
