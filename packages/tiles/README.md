# COPC Tiles

Create standard 3D Tiles 1.1 point-cloud content from COPC sources. COPC Tiles
is an optional companion to [COPC Adapter](https://github.com/mors119/copc-adapter)
for applications that need the 3D Tiles format. The source-neutral engine has
no runtime dependencies; the Adapter connector is optional.

> **Version 0.1.1 · Experimental release candidate, not yet published.** The
> live provider reads bounded hierarchy metadata before the first render and
> serves point content on demand. Some projected sources do not have certified
> bounds and need explicit content
> preprocessing. See [Known limits](#known-limits).

## Install

```sh
npm install @frillab/copc-tiles
```

To read COPC through the built-in Adapter connector, also install:

```sh
npm install @frillab/copc-adapter
```

Applications using their own node source can use the Tiles engine without
installing COPC Adapter, CesiumJS, or Three.js.

## Quick start

The provider exposes a standard Tileset and an HTTP request handler. Mount the
handler in your application server, then point a 3D Tiles renderer at its
Tileset URL.

```ts
import { createCopcCoreNodeSource } from '@frillab/copc-tiles/adapter/copc-core';
import {
  createCopcTileResourceProvider,
  createTileResourceServer,
} from '@frillab/copc-tiles/resources';

const source = await createCopcCoreNodeSource({
  input: 'https://example.com/data.copc.laz',
  sourceIdentity: 'catalog:my-copc-dataset', // stable app-owned ID, not a signed URL
});

const provider = await createCopcTileResourceProvider(source, {
  scanCompleteHierarchy: true,
});
const server = createTileResourceServer(provider, {
  closeProviderOnShutdown: true,
});

// Mount server.handle(request) in your HTTP server and use its Tileset URL.
// On shutdown:
await server.close();
source.close();
```

Remote COPC sources must allow HTTP Range requests and browser CORS from your
application's origin. The complete setup, custom node sources, bounds options,
and renderer integration are in the
[usage guide](https://github.com/mors119/copc-adapter/blob/main/packages/tiles/docs/usage.md).

## What it provides

- A source-neutral engine for precision-aware point GLBs and 3D Tiles Tilesets.
- On-demand node reads, resource serving, cancellation, and bounded caching.
- An optional connector to the public `@frillab/copc-adapter/core` API.
- Compatibility with Adapter `0.7.1` and `0.8.x`; renderer compatibility
  depends on the standard 3D Tiles support of the consuming viewer.

## Known limits

- `scanCompleteHierarchy: true` opts into a bounded scan of all hierarchy
  metadata before the Tileset is returned. This is not lazy subtree discovery.
- Conservative source-cell bounds fail closed when the Adapter cannot certify
  them. An explicitly generated decoded-content index can support some such
  sources, but it bounds observed point content, not unobserved source cells.
- Full decoded-content preprocessing is explicit, defaults to 4 million points,
  and has a 20-million-point hard limit.
- Vertical placement may be reported as unverified when source metadata or
  transforms do not establish it. A finite position is not a survey datum
  guarantee.
- Fixture-based implicit Tileset generation is available; a live COPC implicit
  subtree provider is not.

See the [3D Tiles demo guide](https://github.com/mors119/copc-adapter/blob/main/apps/dev-viewer/docs/3d-tiles-demo.md)
for a runnable CesiumJS and Three.js example, and the
[API reference](https://github.com/mors119/copc-adapter/tree/main/packages/tiles/docs)
for detailed options. Licensed under [Apache-2.0](LICENSE).
