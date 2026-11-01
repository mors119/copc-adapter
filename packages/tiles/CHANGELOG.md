# Changelog

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
