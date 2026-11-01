# Using COPC Tiles

COPC Tiles is a source-neutral 3D Tiles engine. Its optional Adapter connector
uses the renderer-neutral public `@frillab/copc-adapter/core` API. The adapter
source still owns COPC ranges, hierarchy parsing, LAZ decode, and CRS/vertical
preparation. Tiles provides bounded reads for explicitly requested node keys,
encoding, a live explicit provider for sources with supported conservative
bounds, and resource serving. It does not schedule camera-driven LOD.

```ts
import { createCopcCoreNodeSource } from '@frillab/copc-tiles/adapter/copc-core';
import {
  createPaddedEcefBoundsFromConservativeResult,
  TileNodeReader,
  encodePointCloudGlb,
} from '@frillab/copc-tiles';

const source = await createCopcCoreNodeSource({
  input: '/data/autzen.copc.laz',
  backend: 'copc-js', // choose 'rust' explicitly to use Rust/WASM
  sourceIdentity: 'catalog:autzen-2026-10', // opaque; do not use a signed URL
  contextOptions: { heightOffsetMeters: 0 },
});

try {
  const reader = new TileNodeReader(source, {
    maxRequestedNodes: 8,
    maxPointsPerNode: 100_000,
  });
  const views = await reader.readNodes(['4-11-2-0'], {
    attributes: { rgb: true, intensity: true },
  });
  const view = views.get('4-11-2-0');
  if (!view) throw new Error('The source did not return the requested node.');

  const content = encodePointCloudGlb(view);
  if (!content) throw new Error('The selected node has no points.');
  console.log(view.context.sourceGeneration, view.context.transformPlan?.identity.key);
  console.log(view.context.availableFields, content.bytes);
} finally {
  source.close();
}
```

For a source whose hierarchy cells all have supported conservative ECEF
bounds, the live provider creates the explicit Tileset from bounded hierarchy
metadata and reads point data only when its content URI is requested:

```ts
import {
  createCopcTileResourceProvider,
  createTileResourceServer,
} from '@frillab/copc-tiles/resources';

const provider = await createCopcTileResourceProvider(source, {
  scanCompleteHierarchy: true,
  readerLimits: { maxHierarchyPages: 128, maxHierarchyNodes: 50_000 },
  selection: { attributes: { rgb: true, intensity: true } },
  maxEncoderPaddingMeters: 0.01,
});
const server = createTileResourceServer(provider, { closeProviderOnShutdown: true });
// Mount server.handle(request) at the application's 3D Tiles URL.
// Close it when the source is replaced or the application shuts down.
await server.close();
```

Set `scanCompleteHierarchy: true` to authorize provider construction to scan
all hierarchy metadata needed to prove complete child discovery and check every
cell bound. Without this explicit opt-in the provider rejects before reading
hierarchy pages or point data. Any unsupported result stops construction and
remains available on `CopcTileResourceProviderError.conservativeBoundsResult`.
It never falls back to decoded-point bounds. The provider does not generate
implicit subtrees or perform camera-driven requests. Real projected Autzen (EPSG:2992) and SoFi
(EPSG:32611) are rejected by Adapter 0.7.1 for metadata-only bounds, so they
cannot use this `conservative-source-cell` multi-node path yet.

For an explicitly bounded content visualization when source-cell bounds are
unsupported, choose the distinct `decoded-content` strategy and authorize its
preprocessing separately:

```ts
const provider = await createCopcTileResourceProvider(source, {
  scanCompleteHierarchy: true,
  boundsStrategy: 'decoded-content',
  allowDecodedContentBounds: true,
  readerLimits: {
    maxTotalPoints: 4_000_000, // default total point budget
    maxTotalPointDataBytes: 256 * 1024 * 1024,
    maxTotalDecodedBytes: 384 * 1024 * 1024,
    maxConcurrentNodeReads: 1,
  },
  tilesetOptions: { maxTotalPoints: 4_000_000 },
  onDecodedContentProgress(progress) {
    console.log(progress.phase, progress.scannedPoints, progress.totalPoints);
  },
});

const scan = provider.decodedContentScan;
if (scan?.coverage !== 'all-content-points-in-complete-hierarchy') {
  throw new Error('The complete content scan did not finish.');
}
console.log(scan.transformPlanIdentity, scan.sourceCrs, scan.verticalPlacement);
console.log(scan.contentBounds); // per content node, no retained decoded positions
```

This path completes the bounded hierarchy scan, preflights point and byte
budgets before point reads, then sequentially prepares every point of every
content-bearing node. A successful result encloses all those prepared ECEF
positions and all reconstructed Float32 GLB positions. Parent volumes combine
their own content and every finalized child volume. It does **not** enclose
unobserved source-space cells: `getConservativeNodeEcefBounds()` keeps its
existing contract, the Tileset reports `sourceCellCoverage: false`, and
`metadataOnlySourceCellStatus` remains separately visible in the scan summary.
The hard point ceiling is 20 million; all hierarchy, node, compressed-byte,
prepared-ECEF-byte, GLB, and Tileset limits remain active and may reject a
source first. No partial Tileset is returned.

Every content tile and its parent carries strategy and source/transform
provenance in `extras`; the provider summary retains per-node bounds and
coordinate evidence. Point resources are regenerated on demand and checked
against the recorded identity and envelope. If Core cannot produce valid
finite prepared ECEF points, the scan fails. `verticalPlacement: 'unverified'`
is a geometry diagnostic only and is not authoritative terrain alignment.
Never assign an unknown vertical CRS to ellipsoidal height or supply an
unmatched geoid grid. The local Dev Viewer additionally defaults to 4 million
points and exposes progress, bytes, ECEF buffer size, and placement status;
the mode is not enabled in the public Playground.

The connector preserves the Adapter source and transform generations, its
immutable transform plan, actual field availability, and zero-copy ECEF
Float64 buffers. Missing standard fields and Extra Dimensions are omitted and
reported in the node context; Tiles does not create zero-filled attributes.
Named Extra Bytes must be configured at source open and requested by exact
case-sensitive name. Adapter's `copc-js` supports exact values where the LAS
descriptor allows them; Rust/WASM explicitly rejects Extra Bytes requests.

`view.context.decodedPointEcefBounds` is the bound for that decoded node's
transformed point content and is labeled
`decodedPointEcefBoundsKind: 'decoded-point-content'`. It bounds loaded point
content only. The connector also exposes the Adapter 0.7.1
`source.getConservativeNodeEcefBounds(nodeKey)` capability for a complete
source cell and its spatial descendants when Adapter certifies the active
transform. This synchronous metadata-only call does not read points or issue
network requests.

```ts
const result = source.getConservativeNodeEcefBounds('4-11-2-0');
if (result.status === 'unsupported') {
  // Preserve/report result.reasonCode and result.reason; do not invent a bound.
  throw new Error(`Cannot build a safe tile bound: ${result.reasonCode}`);
}

// The returned ECEF interval covers the source cell, but requires padding for
// tile-local Float32 reconstruction. Use measured encoder error as padding.
const content = encodePointCloudGlb(view);
if (!content) throw new Error('The selected node has no points.');
const bounds = createPaddedEcefBoundsFromConservativeResult(
  result,
  content.maxAbsoluteErrorMeters,
);
```

The source-cell bound remains in COPC source axes and units; the supported
conservative bound is WGS84 ECEF in metres; and decoded-point bounds cover only
prepared points. All three stay distinct. Adapter result provenance includes
source identity and generations, transform-plan identity, source-cell
bounds, manual height offset and vertical-grid evidence when present. The
result certifies analytic source-cell coverage but does not certify GLB
Float32 reconstruction error; Tiles applies the measured encoder padding.

The verified bounds cases include generated EPSG:4326 and EPSG:4979 WGS84
fixtures with explicit ellipsoidal height. Unknown vertical reference returns
`unsupported-vertical-reference`. Projected EPSG:2992 Autzen and EPSG:32611
return `unsupported-horizontal-crs`, so these sources cannot use this
metadata-only `conservative-source-cell` bounds path. This capability does not itself implement live
multi-node request scheduling or camera-driven COPC refinement.

`TileNodeReader` resolves only requested node keys and has bounded hierarchy
pages, ranges, decoded points, concurrency, and cancellation. It does not
materialize the full octree or run Adapter's Direct `NodeSelector`. A complete
production LOD tileset still needs a conservative policy for cells whose
points have not yet been decoded.

## Adapter compatibility

Tiles pins the verified published `@frillab/copc-adapter@0.7.1` package as an
exact optional peer and development dependency. Its `/core` subpath publicly
exports the node-source integration and conservative-bounds types/runtime.
See the [versioned API matrix](./adapter-api-compatibility.md) for Registry
integrity, exact method and result semantics, NodeNext checks, backend results,
and the relationship to [Adapter issue #383](https://github.com/mors119/copc-adapter/issues/383).

## Real-source browser checks

The configured Autzen Chromium tests run with both `copc-js` and Rust/WASM and
use bounded HTTP Range requests. They encode a real node, run Khronos and
CesiumGS validators, and render the same primary GLB bytes in Cesium and Three.
The SoFi test accepts `COPC_TILES_SOFI_URL` or the legacy
`COPC_TILES_SECOND_COPC_URL`; it is skipped when no real source is configured.
Both backends use Adapter's `head-fallback` Range validation when the browser
origin does not expose `Content-Range`.

```sh
COPC_TILES_AUTZEN=/path/to/autzen-classified.copc.laz \
  npm run validate:adapter-integration

COPC_TILES_SOFI_URL=https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz \
  npx playwright test --config test/browser/playwright.config.mjs \
  test/browser/second-source.real.spec.mjs
```

The real Autzen source is projected and correctly returns
`unsupported-horizontal-crs` for conservative source-cell bounds. Its
one-node renderer check therefore does not demonstrate safe multi-node
placement or production LOD. Geographic bounds fixtures exercise supported
and unsupported vertical-reference results. These checks do not prove
full-cloud coverage, validated vertical-grid behavior, File/Blob input, real
named Extra Bytes, or full source switching under camera churn. See the
[implementation status](./implementation-status.md) and
[benchmark report](./benchmark-report-2026-10-29.md).
