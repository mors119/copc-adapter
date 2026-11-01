# T1 Tile input contract

## Scope and compatibility

T1 defines an internal, renderer-neutral point view for later Tiles work. Its
types have no Adapter dependency. The `PreparedPointDataAInput` structural
shape mirrors the fields consumed from A; a separate compile-time check maps
the published Registry Adapter 0.7.1 `/core` declarations to that shape. The Adapter
remains optional for applications that provide another valid source.

The A view reads `PreparedPointData.world.coordinates` and, when explicitly
requested, the existing `source.coordinates`, `geographic.coordinates`, and
attribute arrays. These are read-only aliases: creating a view does not copy
point buffers, transform ECEF back to Geographic, fetch source data, or
rehydrate another cache layout. Tile code must treat all shared typed arrays as
immutable. Typed arrays cannot be made immutable by `Object.freeze`, so this is
an ownership contract documented on the internal API and checked by the
zero-copy identity tests.

The experimental E view accepts a Tiles-owned structural input with required
`ecef` and prepared-height buffers and optional independently retained Source
and Geographic buffers. It aliases those buffers directly. This structural
type does not import or promise compatibility with Adapter internals.

## Public Adapter integration and limits

The exact published `@frillab/copc-adapter@0.7.1` Registry artifact supplies
renderer-neutral `createCopcContext()`, `CopcNodeSource`, hierarchy/page
methods, cancellation, source/transform generations, transform provenance,
A-shaped `loadPreparedNodeData()`, and the conservative source-cell bounds
contract. Tiles consumes only public `/core` declarations and aliases the
returned Float64 ECEF and requested attribute buffers. Registry integrity and
packed consumer evidence are in the [compatibility matrix](./adapter-api-compatibility.md).

The public contract still has no read-only view of Adapter's experimental E
cache, so A remains the real-source baseline and the connector does not
reconstruct E entries. `ecefBounds` is labeled `decoded-point-content`; it is
kept distinct from conservative cell bounds. The 0.7.1 conservative operation
supports tested geographic cases but rejects projected Autzen EPSG:2992 and
projected EPSG:32611 as `unsupported-horizontal-crs`. Tiles preserves the
reason and does not infer bounds from decoded points. No Adapter files are
changed here.

Adapter supports exact named Extra Bytes requests on `copc-js` where the
LAS descriptor permits them. Rust/WASM rejects non-empty Extra Bytes requests.
Tiles forwards exact requested names and preserves the returned typed array;
the unit fixture verifies BigUint64 identity. Real named Extra Bytes were not
exercised in the browser source tests.

## View and selection rules

- ECEF is always required: interleaved WGS84 ECEF XYZ in metres, Float64, with
  exactly `pointCount * 3` values.
- `pointCount` is a non-negative safe integer. Source and Geographic are
  optional, independently requested Float64 XYZ triples. Prepared height is
  optional on the general view; E supplies it directly, while A has no
  separate contiguous height buffer to alias.
- Position is implicit in field selection and cannot be disabled. RGB requests
  all three Uint16 channels. Intensity is Uint16, classification is Uint8.
  Extra dimensions are requested by exact name and retain their Float64,
  BigInt64, or BigUint64 typed array without narrowing or conversion.
- A requested missing coordinate buffer or attribute is an error. A partial
  RGB tuple, wrong typed-array class, invalid length, invalid generation, or
  mismatched source identity is an error. Missing values are never filled with
  zero. BigInt arrays remain exact in the view; later encoders must support
  their declared representation or fail explicitly.
- Available but unrequested attributes are omitted from the view. The point
  identity is `(context.nodeKey, pointIndex)`; no synthetic point IDs are
  allocated.
- Context carries the opaque source identity, node key, transform generation,
  source CRS evidence (including unknown or unverified status), vertical datum
  evidence, applied height offset, and explicit manual / validated corrections.
  Identified CRSs need an identifier or definition, and a verified vertical
  datum needs an identifier. Every view creation checks source identity and
  transform generation against the caller's current expectation, rejecting
  stale work.

## Acceptance mapping

| Issue #1 criterion | Implementation |
| --- | --- |
| Renderer-neutral `TilePointView` and explicit node provenance | `src/input/tilePointView.ts`; `TileNodeContext` is separate from the point arrays. |
| A-shaped input uses prepared ECEF without copies | `createTilePointViewFromA()` aliases `world.coordinates`; requested Source, Geographic, and attribute buffers are also aliases. The packed Registry compatibility check verifies the shape against public `/core` `CopcPreparedNodeData`. |
| E uses ECEF / height buffers directly, with optional coordinates | `createExperimentalETilePointView()` aliases the structural input. Public Adapter integration is blocked and documented above. |
| Explicit field selection and missing-field policy | `TilePointFieldSelection`; requested absent fields throw `TilePointViewError`. |
| Identity, lengths, BigInt, and stale-generation checks | `test/tilePointView.test.mjs`. |

## Review limits

This contract does not define a Tiles scheduler or GLB attribute encoding.
The E function proves the zero-copy Tiles boundary against its declared input
shape; it is not evidence that a consumer can obtain E data through the public
Adapter API. T2 uses the packed Registry package's public hierarchy and
node-read capabilities. T1 validates coordinate tags,
typed-array classes, lengths, and provenance without scanning every point
value; T3/T11 must validate numeric finiteness and precision before encoding.
