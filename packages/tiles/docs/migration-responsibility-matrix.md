# Migration responsibility matrix

> Historical source audit. Current package locations are `packages/adapter`
> and `packages/tiles`; the original repository and PR references below are
> retained as provenance. The destination-only decisions below are superseded
> by the completed integration recorded in
> [`docs/monorepo-development.md`](../../../docs/monorepo-development.md).

Audit snapshot: `16fe264` (merged Tiles PR #19, 2026-10-31), which includes
the baseline in PR #18 plus its merged live-provider follow-up. The working
tree was clean before this audit. The requested migration target is a
simulated `packages/tiles` package only; this audit does not modify
`mors119/copc-adapter`.

The migration imported the verified source `main` at
`5297405def349e83298ea41e2f21549e6d8e25e9`, including PR #20. The earlier
audit snapshot above is retained as historical provenance.

The source and call-path review covered `README.md`, all T1–T12 issue bodies
and their linked Adapter issues #332–#343, the Adapter #383 bounds follow-up,
all package entrypoints/configuration, every `src/` module, scripts, tests,
browser fixtures, benchmark, and current T1–T12 evidence. The current
Adapter contract was checked against the pinned public 0.7.1 `/core`
contract and the versioned inventory in
[`adapter-api-compatibility.md`](adapter-api-compatibility.md).

## Source module decisions

| Module | Classification | Responsibility and evidence | Migration action |
| --- | --- | --- | --- |
| `src/input/tilePointView.ts` | 1 — Tiles-owned | Read-only A-shaped point view and experimental E-shaped view; preserves point count, identity, selected attributes, and provenance. It imports no Adapter or renderer code. | Preserve. |
| `src/geometry/tileLocalCoordinates.ts` | 1 — Tiles-owned | Float64 ECEF origin and Float32 local coordinate encoding/error measurement. This is tile precision work, not CRS transformation. | Preserve. |
| `src/gltf/pointCloudGlb.ts` | 1 — Tiles-owned | glTF 2.0 POINTS/GLB and point metadata serialization. | Preserve. |
| `src/implicit/octreeAvailability.ts` | 1 — Tiles-owned | Tiles implicit subtree availability bitstreams and serialization. | Preserve. |
| `src/tileset/explicitTileset.ts` | 1 — Tiles-owned | Explicit 3D Tiles hierarchy, conservative-volume validation/padding, and content mapping. | Preserve. |
| `src/tileset/implicitOctreeTileset.ts` | 1 — Tiles-owned | Implicit octree/subtree mapping and Tiles metadata. It does not parse COPC hierarchy bytes. | Preserve. |
| `src/resources/tileResourceServer.ts` | 1 — Tiles-owned | Fetch `Request`/`Response` serving, bounded cache, de-duplication, cancellation, and generation lifecycle. | Preserve. |
| `src/resources/copcTileResourceProvider.ts` | 1 — Tiles-owned | Explicit Tiles hierarchy mapping and on-demand content lifecycle over the source-neutral node-source interface. It requires explicit authorization for a bounded complete metadata scan; it does not decode point payloads during construction. | Preserve. |
| `src/source/tileNodeSource.ts` | 1 — Tiles-owned | Source-neutral hierarchy, bound, and point-source contracts; no Adapter import. | Preserve. |
| `src/source/tileNodeReader.ts` | 1 — Tiles-owned | Bounded requested-node traversal, request limits, cancellation, identity/generation checks, and point-read orchestration. Tiles owns these request policies. | Preserve. |
| `src/adapter/copcCoreAdapter.ts` | 2 — Public Adapter connector | Adapts public Adapter Core context, hierarchy, prepared-node, transform, generation, and conservative-bound contracts to the source-neutral Tiles interfaces. It contains validation/copy/freeze logic, not COPC parsing or transformation. | Keep as the sole Adapter-dependent boundary. |
| `src/index.ts` | 4 — Portable package integration | Source-neutral engine barrel. It intentionally does not export the optional Adapter connector. | Preserve root API. |
| `src/resources/index.ts` | 4 — Portable package integration | Resource-provider/server barrel used by `./resources`. Its relative exports resolve within `src/resources`. | Preserve subpath API. |

No module was classified as redundant or obsolete. In particular, the
resource provider, node reader, hierarchy mapping, and resource server have
different owners and call paths; Adapter similarities do not make them
duplicates. No source module is proposed for deletion.

## Non-source package contents

| Contents | Classification | Decision |
| --- | --- | --- |
| `test/`, `test-types/`, `test/browser/` | 3 — Test infrastructure | Keep the unit, validator, public-contract type, browser fixture, optional real-source, and packed-consumer coverage package-local. Temporary test content is created under OS temporary directories. |
| `scripts/`, `bench/` | 3 — Development infrastructure | Keep build cleanup, packed-consumer verification, and the synthetic A/E benchmark package-local. Audit the explicit dependency-resolution paths for npm workspace hoisting. |
| `tsconfig*.json` | 3 — Build infrastructure | Keep `rootDir: src` and `outDir: dist` package-relative; declarations are generated from package source. |
| `package.json`, `package-lock.json` | 4 — Portable package integration | Preserve independent `@frillab/copc-tiles@0.1.0` metadata, standard exports, `files` whitelist, exact optional Adapter peer, and separate dev dependency. Do not add workspace-only dependency syntax. |
| `README.md`, `CHANGELOG.md`, `LICENSE` | 4 — Package documentation/legal | Keep with the package. The README now states the current 0.7.1 boundary, monorepo location, implemented engine/provider behavior, and CRS limitations. |
| `docs/implementation-status.md`, `docs/release-audit-2026-10-29.md`, `docs/benchmark-report-2026-10-29.md`, `PACKED_CONSUMER_RECORD.md`, T1–T12 evidence, bounds follow-up, and release records | 3 — Evidence/history | Preserve historical measurements and audits. Retain package-agnostic evidence in `docs/`; do not discard or rewrite historical results as migration evidence. |
| `docs/adapter-migration-assessment.md`, `docs/adapter-api-compatibility.md`, `docs/migration-responsibility-matrix.md` | 4 — Migration/contract documentation | Keep package-relative links and explicit versioned Adapter contract. The repository uses two independent npm distributions; T12's Direct/Tiles performance comparison remains open. |

## Public boundaries and responsibility check

- The package root exports the source-neutral engine. `./adapter/copc-core`
  is the separate Connector entrypoint; `./resources`, `./tileset`, and
  `./tileset/implicit` expose the resource, explicit Tileset, and implicit
  Tileset APIs.
- Only `src/adapter/copcCoreAdapter.ts` imports
  `@frillab/copc-adapter/core`. Runtime loading of `createCopcContext` is
  dynamic within that connector; the package-root engine does not load the
  Adapter connector. `copcTileResourceProvider.ts` depends on Tiles'
  source-neutral contract, not Adapter.
- The connector calls public Core APIs for context creation, metadata,
  hierarchy pages, node preparation, source/transform generations and
  transform plans, and conservative ECEF source-cell bounds. The exact
  method names, ownership, cancellation limits, and tests are listed in the
  compatibility matrix. It does not import undocumented paths or private
  Adapter files.
- Source search found no COPC header/hierarchy parser, HTTP Range reader,
  LAZ decoder, CRS/vertical transformation, or E-cache reconstruction in
  `src/`. The public Core connector is the only COPC input path. Tiles does
  retain its distinct node-to-Tiles hierarchy mapping, tile-local precision,
  serialization, request scheduling, cache lifecycle, and spatial coverage
  checks.
- Adapter 0.7.1 does not expose the direct E-cache view described in T1, and
  reports real projected Autzen EPSG:2992 and SoFi EPSG:32611 conservative
  bounds as unsupported. These are documented capability/feature gaps, not
  reasons to copy Adapter internals or migration-specific blockers.

## Portability findings before edits

Package-relative imports, declaration output, test fixture paths, and test
temporary directories are already rooted at the package or OS temp directory.
Two development paths assume package-local dependency installation and fail
when npm hoists dependencies to the workspace root:

1. `test/browser/vite.config.ts` locates Cesium under
   `process.cwd()/node_modules/cesium`.
2. `scripts/test-packed-consumer.mjs` launches Vite by the literal path
   `root/node_modules/vite/bin/vite.js`.

Both paths now locate dependencies through Node's module resolver from the
package config/script, which follows parent workspace `node_modules`. The
packed-consumer check also typechecks an Adapter-free NodeNext consumer and
imports every declared Tiles subpath. `npm run verify` copies only
`git ls-files` entries to a disposable workspace root, installs there, and
runs the package verification suite. No implementation module depends on
the source checkout path or destination monorepo root.

## Destination snapshot

The read-only `origin/main` snapshot in the local Adapter worktree was
`fe7637c`. At that revision the repository-root `package.json` did not declare
`workspaces`; the Adapter package manifest was `packages/package.json`.
Accordingly, staging verified the requested conventional `packages/tiles`
layout under a minimal workspace root, but did not prove how the destination
will configure a Tiles workspace alongside its existing `packages/` Adapter
package. The destination workspace pattern and root install-script policy are
destination-only migration decisions. No Adapter file was changed.

## Roadmap status at audit

T1–T12 remain open and partial as recorded in
[`implementation-status.md`](implementation-status.md). The engine and
explicit resource-provider work is present; real projected multi-node bounds,
live real-source LOD, complete implicit COPC resources, broader A/E and
metadata matrices, full renderer comparison, and T12 distribution/performance
evidence remain incomplete. The package has no migration-specific source
dependency blocker identified by this audit.
