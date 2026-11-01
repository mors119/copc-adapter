# T7 — Per-point LAS metadata

`encodePointCloudGlb` stores point inspection attributes with the glTF 2.0
`EXT_structural_metadata` and `EXT_mesh_features` extensions. Each point uses
its vertex index as its feature ID, so property table row `i` is the metadata
for `(nodeKey, pointIndex: i)`. This avoids a redundant feature-ID vertex
buffer while preserving point order and identity within the tile.

| Input field | Metadata type | Representation |
| --- | --- | --- |
| LAS intensity | `UINT16` | Little-endian property table value |
| LAS classification | `UINT8` | Property table value |
| `Float64Array` extra dimension | `FLOAT64` | Little-endian binary64; finite values only |
| `BigInt64Array` extra dimension | `INT64` | Exact two’s-complement 64-bit value |
| `BigUint64Array` extra dimension | `UINT64` | Exact unsigned 64-bit value |
| LAS RGB | Existing `COLOR_0` | Normalized `UNSIGNED_SHORT VEC3`; no metadata duplicate |

Extra-dimension property IDs are stable `extra_<UTF-8 hex>` identifiers, and
the schema property's `name` preserves the exact original name. Names over
128 UTF-8 bytes or invalid UTF-8 are rejected. The default property limit is
64 per tile, with a hard maximum of 256. The configured GLB output-byte limit
includes metadata storage and alignment. No missing field is fabricated.

Values use one `EXT_structural_metadata` property table with one row per point.
The mesh primitive's `EXT_mesh_features` entry maps feature IDs by vertex
index to that table. Both extensions are listed in `extensionsUsed`, but not
`extensionsRequired`, so renderers that do not inspect metadata can still load
the standard POINTS geometry. The extension data follows the CesiumGS
[`EXT_structural_metadata`](https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_structural_metadata/README.md)
and [`EXT_mesh_features`](https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_mesh_features/README.md)
drafts used by 3D Tiles.

`npm run validate:gltf` checks the GLB with the official Khronos glTF
Validator, then places a metadata-bearing GLB in a tileset and runs the
CesiumGS 3D Tiles Validator's extension-aware checks. The Khronos validator
does not validate these extension semantics; the CesiumGS validator reports
zero errors and warnings for the fixture. Cesium and Three.js runtime metadata
inspection is covered by the browser fixtures. The actual one-node Autzen GLB
also passed the Khronos validator, and Three.js read its RGB, intensity and
classification data through the standard GLB/metadata plugins. The published
Adapter 0.7.1 `/core` accepts exact named Extra Bytes on `copc-js` when the
LAS descriptor permits them; Rust/WASM rejects non-empty requests. Real named
Extra Bytes were not exercised. The current SoFi run verified position,
intensity and classification on both backends, but it did not establish
additional Extra Bytes or GPS/return metadata. See the [versioned API matrix](./adapter-api-compatibility.md).
