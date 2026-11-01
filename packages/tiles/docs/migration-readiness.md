# Historical migration readiness — 2026-10-31

> **Historical preparation record.** This package now lives at
> `packages/tiles` in the `mors119/copc-adapter` npm Workspaces monorepo. The
> destination snapshot and path assumptions below describe the earlier audit;
> the completed migration is recorded in the repository's
> [`docs/monorepo-development.md`](../../../docs/monorepo-development.md).
> The original `FrilLab/copc-tiles` repository remains unchanged.

## Status at preparation checkpoint: CONDITIONAL (superseded)

The Tiles package itself builds and passes a tracked-content staging test at
`packages/tiles`, including clean workspace installation and packed external
consumers. The audited local `origin/main` snapshot of `mors119/copc-adapter`
(`fe7637c`) has no root npm `workspaces` declaration; its Adapter package
manifest is `packages/package.json`. The destination must establish and
review the workspace boundary for `packages/tiles` alongside that existing
package before a real import. This task did not change the destination.

The module-by-module ownership and API audit is in
[`migration-responsibility-matrix.md`](migration-responsibility-matrix.md).
No engine or Adapter connector implementation file changed in this refactor.

## Package and Adapter boundary

- Package name/version remain `@frillab/copc-tiles@0.1.0`.
- The existing exports remain intact: `.` (source-neutral engine),
  `./adapter/copc-core`, `./resources`, `./tileset`, and
  `./tileset/implicit`.
- The Adapter connector imports only the published
  `@frillab/copc-adapter/core` contract at exactly `0.7.1`; its peer remains
  optional. The public types and methods were checked against the actual
  Registry tarball and the connector type/runtime tests.
- Engine root and renderer-free subpaths passed runtime and strict NodeNext
  checks with no Adapter, Cesium, or Three installed. Packed source maps show
  no Adapter or renderer modules in the Engine bundle. Adapter `/cesium`,
  `/three`, and `/core` packed bundles contain no Tiles modules.
- No COPC header/hierarchy parser, Range reader, LAZ decoder, CRS/vertical
  transformer, or E-cache reconstruction exists in Tiles source. A/E point
  views, tile hierarchy mapping, Float32 encoding, serialization, resource
  lifecycle, and spatial validation remain Tiles responsibilities.

## Resource behavior and current support

`createCopcTileResourceProvider()` requires explicit
`scanCompleteHierarchy: true` authorization before its bounded metadata-only
full hierarchy scan. Point payloads are prepared only when their content
resource is requested. A supported conservative ECEF source-cell bound is
required before spatial Tileset creation; unsupported results are preserved
and fail closed. Real Autzen EPSG:2992 and SoFi EPSG:32611 remain unsupported
by Adapter 0.7.1 for conservative bounds. Real projected multi-node Tilesets
and camera-driven Cesium/Three LOD remain unverified.

## Staged Workspace verification

The package-local command is `npm run verify`. It copies only `git ls-files`
entries to a disposable workspace root with `packages/tiles`, performs a
clean npm install there, and runs package checks. The final Node 22 run used:

```sh
COPC_TILES_AUTZEN="$AUTZEN_COPC_PATH" \
COPC_TILES_SOFI_URL=https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz \
npm run verify
```

`AUTZEN_COPC_PATH` should point to a local COPC fixture; it is not copied into
the staging tree. The SoFi test uses bounded HTTP Range reads and does not
download the source object in full.

Environment and results:

| Check | Result |
| --- | --- |
| Node / npm | Node `22.14.0`; npm `11.20.0`; macOS arm64 / Apple M2 |
| Clean Workspace install | Passed; 240 packages installed. The temporary workspace root carries the package's existing `allowScripts` list because npm ignores that setting on an individual workspace package. |
| `typecheck`, `typecheck:adapter-core`, `build` | Passed in the staged package. |
| `npm test` | 88 passed, 0 failed, 0 skipped. Includes malformed input/resource, precision, bounds, glTF and Tileset validator coverage. |
| Browser fixtures | 8 passed, 8 skipped. The configured Autzen and SoFi real-source checks passed on both backends; remaining optional real fixture cases lacked inputs. These are requested-node/single-node checks, not real multi-node LOD verification. |
| Packed external consumers | Passed. Strict NodeNext and Bundler checks covered Adapter root/Core/Cesium/Three and all Tiles exports. Core-only worked without renderers; Engine-only ESM, strict NodeNext, and Vite bundle worked without Adapter or renderer packages. |
| `npm pack` | Passed: 50 files, approximately 98.1 kB packed / 375.1 kB unpacked. The tarball contains `package.json`, README/CHANGELOG/LICENSE, `dist/`, and package docs; no tests, scripts, raw source, workspace-only paths, local datasets, or generated test artifacts. |
| `bench:engine` | Passed on the deterministic synthetic 100,000-point case. It does not measure real decode or multi-node LOD. |

Node `18.20.8` / npm `10.8.2` also passed clean staged installation,
typechecks, build, all 88 unit tests, and the synthetic benchmark. The script
explicitly skipped browser and packed-bundle checks in that run because the
pinned Vite 7, Playwright, and Cesium development tools require Node 20 or
22. The full browser and packed-consumer gates passed on Node 22.

The first workspace install surfaced npm's workspace behavior: package-level
`allowScripts` is ignored. The staging root now copies the existing allowlist
to its root manifest and runs install scripts normally. The local Homebrew
libvips link is broken, so the staging command sets
`SHARP_IGNORE_GLOBAL_LIBVIPS=1` to use Sharp's bundled libvips. No install
scripts were disabled and no test assertions were changed. The known Node 26
development-only `better-sqlite3@11.10.0` install limitation remains as
recorded in the package README; Node 26 was not used for this final staging
run.

## T1–T12 status preserved

| Issue | Current status |
| --- | --- |
| T1 — input contract | Implemented, partially verified; public E-cache view and broader field/backend matrix remain incomplete. |
| T2 — node reads | Implemented, partially verified; real projected live hierarchy output and broader Range/File cases remain incomplete. |
| T3 — precision | Implemented, partially verified; broader CRS and multi-node seam/error evidence remains incomplete. |
| T4 — GLB | Implemented, partially verified; broader field and allocation evidence remains incomplete. |
| T5 — bounds | Geographic live path implemented; projected conservative bounds unsupported by Adapter 0.7.1; partial. |
| T6 — implicit tiling | Fixture engine implemented; live COPC integration not implemented. |
| T7 — metadata | Implemented, partially verified; Extra Bytes and cross-renderer 64-bit metadata remain incomplete. |
| T8 — resource serving | Live explicit provider implemented; partially verified; full real-source LOD/cancellation and implicit resources remain incomplete. |
| T9 — Cesium | Real selected-node and synthetic live multi-node fixture verified; real multi-node LOD remains unverified. |
| T10 — Three | Real selected-node and synthetic live multi-node fixture verified; real multi-node LOD remains unverified. |
| T11 — standards/security | Validators implemented; coverage matrix remains partial. |
| T12 — performance/package | Synthetic A/E benchmark and package isolation verified; full Direct/on-demand/prebuilt comparison remains incomplete. |

These are feature acceptance gaps, not duplicated responsibilities. They do
not require algorithm changes for migration.

## Destination-only migration delta

Before a real import, a dedicated Adapter PR still needs to:

1. Establish the actual npm Workspace layout and show that
   `packages/tiles` coexists correctly with the existing Adapter package at
   `packages/package.json`.
2. Merge the Tiles native install-script allowlist into the destination
   workspace root's npm policy where required.
3. Set monorepo `repository` metadata for the Tiles package (including its
   `packages/tiles` directory) while preserving its independent package name,
   version, exports, and optional exact Adapter peer.
4. Add package verification to destination CI and run the affected Adapter
   Direct regressions plus monorepo packed-consumer/import-graph checks.

The staging command and package changes are ready for that reviewed PR. These
destination changes were not applied here.
