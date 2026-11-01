# npm Workspaces development

The repository root is private and defines two npm package workspaces:

| Package | Path | Version | Role |
| --- | --- | --- | --- |
| `@frillab/copc-adapter` | `packages/adapter` | `0.7.1` | COPC Core, Cesium, and Three APIs |
| `@frillab/copc-tiles` | `packages/tiles` | `0.1.0` | Source-neutral 3D Tiles engine and optional Adapter Core connector |

They are independent npm distributions. Tiles may depend on public Adapter
Core APIs; Adapter must not depend on Tiles. The root `package-lock.json` is
the authoritative install lock for both workspaces. Apps are not package
workspaces and retain app-specific lockfiles.

The workspace lock was regenerated from the two package manifests. Runtime
dependency versions for the published distributions remain unchanged. The
combined development graph resolves a small number of transitive development
dependencies to compatible versions already used elsewhere in the root lock
(for example `rollup`, `postcss`, `@types/node`, and `tslib`); this changes
development resolution only. `npm ci` and both package test/build suites
validate the resulting lock. The full audit reports 11 dev-only findings
(6 moderate, 5 high); the production dependency audit reports none. No
automatic dependency fixes were applied as part of this migration.

## Candidate artifact comparison

The Adapter candidate built from this repository is 654,469 bytes packed and
2,322,555 bytes unpacked (129 entries). The existing npm
`@frillab/copc-adapter@0.7.1` artifact is 646,494 bytes packed and 2,289,736
bytes unpacked (127 entries), so the candidate is 7,975 bytes larger packed
and 32,819 bytes larger unpacked. The candidate adds two terrain declaration
files and has changed generated chunks and declarations. Those API and runtime
source changes were already present on destination `main` at the recorded
migration baseline; the package move itself changes only asset-copy script
paths. The manifest remains `0.7.1` as required, so this candidate is not a
replacement artifact to publish over the existing registry version.

The Tiles candidate is 98,968 bytes packed and 377,803 bytes unpacked (50
entries), compared with 98,100 packed and 375,100 unpacked in the source
repository's pre-import pack record. The size increase is documentation and
package metadata; runtime source and runtime dependencies are unchanged.

## Migration baseline

The migration starts from destination `main` commit
`8b9142e051e0d96b893e1dc8088a4f16ccbd3f7a` and imports Tiles `main` commit
`5297405def349e83298ea41e2f21549e6d8e25e9`, after merged PRs #18, #19, and
#20. The source repository remains unchanged.

## Install and develop

Install the workspace packages from the repository root:

```bash
npm ci
```

Adapter scripts run in the Adapter workspace, and Tiles scripts run in the
Tiles workspace:

```bash
npm run typecheck -w @frillab/copc-adapter
npm test -w @frillab/copc-adapter
npm run build -w @frillab/copc-adapter

npm run typecheck -w @frillab/copc-tiles
npm run typecheck:adapter-core -w @frillab/copc-tiles
npm test -w @frillab/copc-tiles
npm run build -w @frillab/copc-tiles
```

The Dev Viewer uses the local Adapter package and its TypeScript aliases point
to `packages/adapter`. Install its app dependencies after the root workspace
install:

```bash
npm ci --prefix apps/dev-viewer --workspaces=false
npm --prefix apps/dev-viewer run typecheck
npm --prefix apps/dev-viewer run build
```

The public Playground has a different release contract. It installs the exact
published `@frillab/copc-adapter@0.7.1` tarball from npm using
`apps/playground/package-lock.json`. Do not add the Playground to the root
workspaces or replace that dependency with a local workspace link.

```bash
npm ci --prefix apps/playground --workspaces=false
npm run playground:verify-release
npm run playground:build
```

The Playground provenance checks verify its manifest, lockfile, resolved
package path, and bundle sources. The root workspace install alone does not
replace its app-local install.

## Validate package isolation

Build and pack either workspace independently. These commands create local
tarballs only:

```bash
npm pack --workspace @frillab/copc-adapter --pack-destination /tmp/copc-adapter-pack
npm pack --workspace @frillab/copc-tiles --pack-destination /tmp/copc-tiles-pack
```

The Tiles packed-consumer script packs Tiles, then installs it into clean
temporary consumers outside the workspace alongside the exact published
Adapter 0.7.1 package. The consumer lock confirms a registry URL and no
workspace link. Checks cover renderer-free Adapter Core, Adapter root/Cesium/
Three entrypoints, Adapter-free Tiles Engine, Tiles with Adapter Core, strict
NodeNext and Bundler declarations, runtime ESM imports, and renderer bundle
graphs:

```bash
npm run test:packed-consumer -w @frillab/copc-tiles
```

`npm run verify -w @frillab/copc-tiles` stages only tracked Tiles package
files into a disposable workspace and runs the complete package verification
suite against the published Adapter contract. It verifies that root workspace
symlinks are not required to build, test, and pack Tiles.

## Independent publication

Only the package workspaces are publishable. Build, review, and publish them
independently after maintainer approval:

```bash
npm publish --workspace @frillab/copc-adapter
npm publish --workspace @frillab/copc-tiles
```

Never publish the repository root. This migration keeps Adapter `0.7.1` and
Tiles `0.1.0`; it does not publish, create tags, or change release versions.
Tiles currently declares Adapter `0.7.1` as both an optional peer and a
development dependency. Any later compatibility-range change requires its
own evidence and review.

## Current limits

The package move does not complete the Tiles roadmap. Projected CRS conservative
bounds for Autzen EPSG:2992 and SoFi EPSG:32611 remain unsupported, and real
multi-node Tiles LOD is not complete. Live resource hierarchy scans require
the explicit `scanCompleteHierarchy: true` option and remain bounded. T1–T12
issues remain open and were not transferred or closed; issue ownership may
need a later maintainer decision. See the original
[Tiles implementation-status record](https://github.com/FrilLab/copc-tiles/blob/main/docs/implementation-status.md)
and [Tiles issue tracker](https://github.com/FrilLab/copc-tiles/issues).
