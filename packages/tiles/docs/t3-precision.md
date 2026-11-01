# T3 tile-local position precision

## Coordinate and transform contract

`encodeTileLocalPositions()` accepts WGS 84 ECEF Float64 values in metres. It
computes or accepts a Float64 local origin and subtracts it before conversion
to Float32. It never performs ECEF-to-Geographic conversion and never mutates
the source buffers.

3D Tiles uses a right-handed Cartesian system with Z up; glTF content is Y up
and 3D Tiles applies the standard Y-up-to-Z-up rotation. The encoder therefore
writes each local ECEF vector `(dx, dy, dz)` in glTF coordinates as
`(dx, dz, -dy)`. The standard runtime rotation restores `(dx, dy, dz)`. The
single placement transform is a column-major translation in `tileTransform`;
the GLB node transform must remain identity. For a child tile, supply its
parent's ECEF origin so the translation is parent-relative. See the [official
3D Tiles coordinate and transform specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc#coordinate-reference-system-crs).

## Numeric error budget

The encoder reconstructs every ECEF coordinate using the Float32 glTF vector,
the standard Y-up-to-Z-up rotation, and Float64 origin. It measures Euclidean
absolute error in metres and relative error as
`absoluteError / max(length(localEcef), 1 metre)`.

Default limits are 0.01 m maximum absolute error and `1e-7` maximum relative
error. Both limits apply to every point. A tile outside either limit fails
with `PRECISION_BUDGET_EXCEEDED`; callers must split the tile or choose a
nearer origin. Result metrics report the maximum errors seen in the tile.
These are selected engineering thresholds for this implementation and still
need maintainer acceptance against representative production data.

## Acceptance mapping

| Issue #3 criterion | Evidence / status |
| --- | --- |
| Float64 origin and Float32 glTF positions | Implemented in `src/geometry/tileLocalCoordinates.ts`. |
| Exactly one placement transform and no double translation | Translation appears only in the returned standard tileset transform. The GLB contract is identity node transform; T4 will verify the emitted model. |
| Preserve WGS 84 ECEF, no inverse transform, no buffer mutation | ECEF-only implementation and source-buffer identity/immutability fixture. |
| Large coordinates, poles, date line and altitude extremes | Synthetic ECEF fixtures generated from geodetic parameters pass the selected budgets. |
| Boundary precision and tile seams | Non-representable Float32 values fail when over budget; adjacent synthetic tiles reconstruct a shared boundary within the threshold. |
| Autzen point and production numeric acceptance | The latest real Autzen check encoded and rendered node `4-11-2-0` (5,122 points) in both browsers. Cesium bound-center error was 0 m; Three first-point world error was 0.0000014947356675 m; the encoder maximum was 0.0000019626224569 m. This compares against Adapter-prepared ECEF and does not independently validate Adapter CRS/vertical conversion or multi-node seams. T3 remains partial pending those checks and maintainer approval of thresholds. |
