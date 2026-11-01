# Future Adapter monorepo migration assessment — 2026-10-30

> Historical assessment, superseded by the monorepo integration. The chosen
> layout has independent npm distributions at `packages/adapter` and
> `packages/tiles`, with dependency direction from Tiles to public Adapter
> `/core`. The feature and performance gaps below remain relevant; choosing
> between an optional Adapter `/tiles` export and a separate package is no
> longer a migration decision.

At this audit date the distribution choice was undecided and no migration or
Adapter change had been performed. The subsequent monorepo change selected
the independently published package and records its import-graph and
regression checks in the root migration guide.

## Transferable modules

The source-neutral Tiles modules remain isolated from the Adapter connector:

- `src/input/tilePointView.ts`
- `src/geometry/tileLocalCoordinates.ts`
- `src/gltf/pointCloudGlb.ts`
- `src/implicit/octreeAvailability.ts`
- `src/tileset/explicitTileset.ts` and `src/tileset/implicitOctreeTileset.ts`
- `src/resources/tileResourceServer.ts`
- `src/source/tileNodeSource.ts` and `src/source/tileNodeReader.ts`
- Boundary-only connector: `src/adapter/copcCoreAdapter.ts`

The connector imports the actual published `@frillab/copc-adapter/core`
contract at exact version 0.7.1. It contains no hierarchy parser, Range
reader, LAZ decoder, CRS implementation, or cache conversion. The API record
and evidence are in [`adapter-api-compatibility.md`](./adapter-api-compatibility.md).

## Distribution comparison

| | A. Optional `@frillab/copc-adapter/tiles` subpath | B. Separate `@frillab/copc-tiles` package from a shared monorepo |
| --- | --- | --- |
| Published artifact | No Adapter `/tiles` export exists in 0.7.1. Building one would add module/export files to an Adapter artifact or require a separate companion artifact. | Existing Tiles artifact is independently packed and has an exact optional peer on Adapter 0.7.1. |
| Install footprint | Not measured. If Tiles files/dependencies are included in the regular Adapter tarball, Adapter-only users download/install them and may violate the no-Tiles install graph requirement. A package layout that avoids this must be demonstrated. | Packed consumer checks prove Tiles installs and runs without Adapter or either renderer; the Core connector consumer works with Adapter installed and no renderer packages. Exact current pack size is recorded by the final pack check. |
| Runtime graph | Not measured. Adapter `.`, `/cesium`, and `/three` must remain free of Tiles imports, encoder modules, and renderers. The new `/tiles` subpath must be isolated. | Engine root is a separate entry and the adapter connector is a separate Tiles subpath. Packed runtime checks test engine-only and Core-only entrypoints. A full representative application bundle-size comparison remains open. |
| Compatibility/release | Could align releases but would make Tiles API/release work part of Adapter release review. Adapter Direct regressions and install graph need every release. | Preserves independent versions and opt-in dependency, while adding package release/provenance overhead. The current peer is exact 0.7.1 pending broader compatibility evidence. |

The present package therefore demonstrates that the separate-package model can
keep the Tiles engine usable without installing Adapter or renderer peers.
It does not establish a package-size improvement versus a hypothetical
compliant `/tiles` distribution. Do not choose either model based on tree
shaking or this one-version tarball alone.

## API and compatibility boundary

Tiles depends on public Adapter 0.7.1 `/core` only. Adapter publishes
`CopcConservativeNodeSource.getConservativeNodeEcefBounds(nodeKey)`; generated
WGS84 EPSG:4326 and EPSG:4979 cases with explicit ellipsoidal height pass on
both backends. Real Autzen EPSG:2992 and a projected EPSG:32611 fixture return
`unsupported-horizontal-crs`. Real SoFi was not available for this run. No
Tiles-side CRS transform or unsupported-bounds fallback is used.

The public API gap from the earlier #383 proposal is present in the released
contract, but Adapter issue [#383](https://github.com/mors119/copc-adapter/issues/383)
was not changed or closed by this Tiles work. There is no public E-cache view;
Tiles must not rehydrate E entries as a workaround.

## Gates before migration or distribution decision

1. Complete and review T1–T12 evidence, including projected bounds if Adapter
   supports additional projected CRS classes.
2. Compare both distribution models with actual packed Adapter-only,
   Tiles-only and combined installs, lockfiles, runtime bundle graphs,
   renderer dependencies, API versioning, and release overhead.
3. For a monorepo move, open a dedicated reviewed PR and audit imports to prove
   no Tiles dependency reaches Adapter Core or Direct `.`, `/cesium`, `/three`.
4. Run all affected Adapter unit/type/browser/Direct performance regressions
   and packed consumer checks. Preserve precision, official validators,
   A/E ownership, Cesium/Three bytes, cancellation and source provenance.
5. Require maintainer approval. Do not migrate, merge, publish, release, or
   close issues as part of this assessment.
