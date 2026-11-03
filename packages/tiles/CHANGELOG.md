# Changelog

## 0.1.0 — Initial release

- Add a source-neutral point-cloud engine for producing standard 3D Tiles 1.1
  and glTF 2.0 `POINTS` content.
- Add read-only point views, precision-safe ECEF-to-tile-local encoding,
  explicit Tilesets, fixture-backed implicit octrees, and bounded resource
  serving with cancellation and cache controls.
- Add an optional connector for the public
  `@frillab/copc-adapter/core` API. The Tiles engine runs without Adapter,
  Cesium, or Three.js installed; the optional Adapter peer supports
  `^0.7.1 || ^0.8.0`.
- Add on-demand COPC node content for CesiumJS and Three.js, plus certified
  source-cell bounds, reusable indexed content bounds, and explicitly
  approved decoded-content preprocessing strategies.
- Validate package exports and packed consumers, GLB and Tileset output,
  precision and resource limits, and browser integration with CesiumJS and
  Three.js.

### Known limits

- The live provider scans the complete bounded hierarchy metadata before its
  first render. Point payloads and GLB resources are requested on demand.
- Projected source-cell bounds are unavailable when the Adapter cannot certify
  them. Indexed or decoded-content bounds cover observed prepared points, not
  unobserved source cells; decoded-content preprocessing is explicit, defaults
  to 4,000,000 points, and is capped at 20,000,000.
- Vertical placement remains dependent on source metadata and configured
  transforms. Unknown vertical provenance is not treated as verified.
- A live COPC implicit-subtree provider and real-source multi-node LOD coverage
  remain incomplete. See [`docs/implementation-status.md`](docs/implementation-status.md)
  for the full acceptance status and evidence.
