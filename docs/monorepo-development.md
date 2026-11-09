# npm Workspace development

COPC Adapter is an independent npm distribution maintained in this repository.
The private repository root defines a single workspace:

| Package | Path | Responsibility |
| --- | --- | --- |
| `@frillab/copc-adapter` | `packages/adapter` | COPC Core, CesiumJS, and Three.js adapters |

`package-lock.json` is the authoritative root workspace lock. The Dev Viewer
and public Playground are applications outside the package workspace and have
separate lockfiles. The Dev Viewer links the local Adapter source; the public
Playground installs an exact published npm release.

## Install and develop

```bash
npm ci
npm ci --prefix apps/dev-viewer --workspaces=false
npm ci --prefix apps/playground --workspaces=false

npm run typecheck -w @frillab/copc-adapter
npm test -w @frillab/copc-adapter
npm run build -w @frillab/copc-adapter
npm --prefix apps/dev-viewer run typecheck
npm --prefix apps/dev-viewer run build
npm run playground:verify-release
npm run playground:build
```

Run the fast workspace manifest and lockfile assertions before expensive
browser, Rust, or package-consumer jobs:

```bash
node scripts/verify-adapter-workspace.mjs
```

## Package isolation and publication

Build and pack only the Adapter workspace:

```bash
npm pack --workspace @frillab/copc-adapter --pack-destination /tmp/copc-adapter-pack
npm run test:pack
```

The packed-consumer gate installs and tests the Adapter artifact in a separate
consumer. The root repository is private and must not be published. Verify
versioning, export contracts, and release notes before publishing Adapter.

## Companion 3D Tiles project

`@frillab/copc-tiles` is maintained independently at
[FrilLab/copc-tiles](https://github.com/FrilLab/copc-tiles).
It generates standard 3D Tiles and has its own release, CI, Codecov, and
package-consumer tests. The optional connector imports only the documented
public `@frillab/copc-adapter/core` API, so Adapter does not have a Tiles
package or renderer dependency.

For Tiles-specific bounds, GLB, provider, or validation work, use the
[standalone Tiles documentation](https://github.com/FrilLab/copc-tiles/tree/main/docs)
and [issue tracker](https://github.com/FrilLab/copc-tiles/issues).
