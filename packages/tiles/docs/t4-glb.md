# T4 glTF POINTS GLB encoder

## Output contract

`encodePointCloudGlb()` writes a glTF 2.0 binary asset with one mesh primitive
in `POINTS` mode, a Float32 `POSITION` accessor and optional `COLOR_0`. Empty
nodes return `null` so no invalid zero-count accessor or empty content resource
is produced. The encoder writes no GLB node transform; placement is returned
alongside the bytes as one standard 3D Tiles translation matrix.

The GLB header and both chunks are little-endian. JSON is UTF-8 padded with
spaces and the BIN chunk is padded with zero bytes to four-byte boundaries.
`buffers[0].byteLength` excludes trailing BIN chunk padding; buffer views and
accessors describe only actual attribute bytes.

## Color policy

LAS RGB remains `Uint16Array` and is written without narrowing to an
`UNSIGNED_SHORT`, normalized `VEC3` `COLOR_0` accessor. This preserves each
16-bit channel exactly in the GLB buffer and maps it to the glTF display range
`[0, 1]` through normalized integer semantics. Vertex data uses an eight-byte
stride: six bytes hold RGB and two bytes are alignment padding. This is required
for four-byte vertex alignment while retaining all 16-bit channel values.

Intensity, classification and extra dimensions are not silently discarded.
T7 writes them through `EXT_structural_metadata` and `EXT_mesh_features`;
unsupported representations fail with an explicit metadata error.

## Validation

The deterministic GLB fixtures run through the official [Khronos glTF
Validator](https://github.com/KhronosGroup/glTF-Validator) npm package pinned
to `gltf-validator@2.0.0-dev.3.10`. Colorless and 16-bit RGB outputs currently
report zero errors and zero warnings. `npm run validate:gltf` runs that
conformance test directly.

The tests also inspect headers, chunk types and lengths, padding, alignment,
accessor shape/count, RGB bytes, empty-node behavior, output bounds, rejection
of unencoded inspection attributes, and deterministic output bytes.

## Acceptance mapping and limits

| Issue #4 criterion | Evidence / status |
| --- | --- |
| Valid glTF POINTS / GLB layout | Implemented; header, JSON/BIN chunks, padding and accessors are tested. |
| Correct Float32 positions and transform | Consumes T3 output; no model transform is added. |
| 16-bit LAS RGB display policy | Full normalized Uint16 channels, exact buffer round-trip, aligned stride. |
| Empty, malformed, and bounded output | Empty nodes have no content; invalid buffers fail; point/output limits are enforced. |
| Khronos validator | Deterministic fixtures and actual Autzen GLB: zero errors and zero warnings. |
| Compatible loader and real Autzen node | Cesium and Three fetched and rendered the same 119,292-byte GLB containing 5,122 points from node `4-11-2-0`. This is one pre-generated node; full-source output remains outstanding, so T4 remains partial. |
