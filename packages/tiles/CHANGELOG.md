# Changelog

## Unreleased — 0.1.0 candidate updates

- Implement renderer-selected COPC node streaming through standard Cesium and
  Three.js 3D Tiles consumers. Bypass only the streaming Tileset-wide point
  total check while retaining bounded hierarchy, per-node, batch, request,
  byte, concurrency, GLB, cache, and explicit full-scan budgets.
- Add an explicit versioned decoded-content bounds index bound to a strong
  ETag source fingerprint, resource-selecting query parameters, and
  transform-plan identity. Exclude known signed credentials from the query
  identity. Validate checksum,
  complete hierarchy, coverage totals, CRS/vertical evidence, per-node bounds,
  and Float32 reconstruction allowances before serving indexed content.
- Pin persistent-index Range reads to the recorded strong ETag and track
  actual returned source bytes. Keep full decoded-content/index generation a
  separate preprocessing choice with the 4,000,000-point default.
- Show actual source, hierarchy, node, GLB, cancellation, cache, first-visible,
  and vertical-placement measurements in the Dev Viewer and update the 3D
  Tiles presentation runbook.
- Add an explicitly authorized, separately named `decoded-content` resource
  provider strategy. It preflights bounded complete hierarchy metadata and
  point/byte budgets, sequentially scans every prepared point, records
  per-node ECEF envelopes and source/transform/vertical provenance, and returns
  no Tileset after an incomplete or over-budget scan.
- Keep `conservative-source-cell` and Adapter Core's
  `getConservativeNodeEcefBounds()` contract unchanged. Decoded-content
  coverage explicitly excludes unobserved source-space cells.
- Union parent content with finalized child volumes, account for minimum Tiles
  half-extents, include a proven Float32 reconstruction allowance, and verify
  regenerated GLB positions against recorded content and tile bounds.
- Add Dev Viewer progress/coverage/height diagnostics and generated projected
  EPSG:32611 fixtures for both unknown-height and explicitly declared WGS 84
  ellipsoidal-height paths. The former remains visibly unverified; the latter
  reports explicit reference semantics without claiming survey-grade accuracy.
- Keep the existing Core prepared-node and conservative-bounds APIs. Add a
  narrow Core WKT2 diagnostic enhancement in Adapter 0.8.0, keep the Tiles
  development baseline at 0.7.1, and validate the optional peer range against
  both packed package versions. This Tiles candidate remains unpublished.

## 0.1.0 — maintainer review candidate

- Add a standalone, source-neutral 3D Tiles point-cloud engine.
- Define validated A/E-compatible point views and bounded node reads.
- Encode tile-local glTF 2.0 POINTS with LAS metadata and build explicit or
  implicit 3D Tiles 1.1 hierarchies.
- Serve addressable resources with bounded cache, cancellation, and source
  generation invalidation.
- Integrate the public COPC Adapter Core API verified at 0.7.1, with
  conservative bounds and explicit unsupported-CRS results.
- Validate fixtures in CesiumJS and Three.js browser integrations, and verify
  bounded real Autzen and SoFi node reads through public Adapter APIs.
- Make browser and packed-consumer checks resolve workspace-hoisted tools and
  add a tracked-content staging verification for a future `packages/tiles`
  workspace.

This candidate has not been published. See `docs/implementation-status.md` for
acceptance status, measured results, and release blockers. Migration evidence
and destination prerequisites are recorded in
`docs/migration-readiness.md`.
