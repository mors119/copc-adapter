# T8 — URL resources, cancellation, and bounded cache

`createTileResourceServer(provider, options)` exposes a standard Fetch
`Request -> Response` handler. Mount it at an HTTP route in the host
application; it does not import Cesium or Three internals. The root URL maps to
`tileset.json`, and relative paths map directly to tile resources. `GET` and
`HEAD` are supported. MIME types include `application/json` for tilesets and
subtree JSON, `model/gltf-binary` for GLB, and `application/octet-stream` for
binary subtrees and buffers.

The provider contract is source-neutral: opaque source identity, safe
generation, optional `isCurrent()`, cancellable `getResource(uri, signal)`,
and optional `close()`. A provider must honor `AbortSignal` for prompt
cancellation. Concurrent requests for one generation and URI share one load;
aborting one subscriber does not abort the shared provider call while another
subscriber remains. The final subscriber abort cancels that call. Source
switches and generation changes clear the in-memory cache and cancel old
loads. Old-generation completions receive `410 Gone` and are not cached.

Default limits are 64 MiB per response, 64 MiB and 512 entries in the LRU
cache, 8 concurrent distinct loads, 64 queued distinct loads, and 32
subscribers per shared resource. Hard maxima are enforced. Queue saturation
returns `503`; invalid provider output returns `502`. Unsafe, encoded
separator, traversal, and double-encoded paths fail closed. Responses use
`Cache-Control: no-store` so an application switching source generations
cannot accidentally reuse stale browser data. In-memory reuse is handled by
the generation-keyed server cache.

`createStaticTileResourceProvider` is intended for deterministic fixtures or
small prebuilt datasets. It snapshots at most 512 resources and 64 MiB by
default. `createCopcTileResourceProvider` is the live Adapter-backed explicit
Tileset provider. It requires `scanCompleteHierarchy: true` to authorize the
bounded metadata-only scan needed to prove direct-child completeness. Without
that opt-in it rejects before reading hierarchy pages or point data. The scan
obtains conservative bounds for discovered cells; point data is read only when
a non-empty content URI is requested. It is bounded by `TileNodeReaderLimits`,
which default to at most 512 hierarchy pages and 64 MiB of hierarchy page
bytes. Providers are caller-owned by default; set
`closeProviderOnShutdown: true` for the server to close its provider once on
shutdown or replacement.

The live provider accepts only supported Adapter conservative ECEF bounds. It
preserves unsupported results and reasons, including projected CRS rejections,
and never substitutes decoded-point bounds. Before content reads it derives a
Float32 reconstruction envelope for each content-bearing cell and propagates
the largest descendant padding to ancestor volumes, including empty nodes. It
checks decoded points against Adapter's bound and actual GLB error against the
envelope. Maximum accepted padding defaults to 1 cm. `ownsSource: true`
transfers source closure to the provider; otherwise the caller retains
ownership. Closing the provider aborts active
content reads.

`npm run validate:resources` covers MIME types, URL addressing, HEAD/404/405,
traversal and encoded paths, concurrent deduplication, LRU bounds, active
cancellation, generation switching, queue saturation, response-size limits,
and provider cleanup. `test/copcTileResourceProvider.test.mjs` exercises a live
two-node source through metadata-only hierarchy creation, on-demand GLB
requests, cancellation, unsupported bounds, precision padding and official
validators. Browser Cesium and Three fixtures consume this same live provider.
Real Autzen is rejected before point reads because EPSG:2992 bounds are
unsupported; real SoFi's selected nodes render in both consumers, but its
EPSG:32611 bounds are also unsupported. These real projected datasets do not
demonstrate safe live multi-node Tiles LOD. Implicit COPC subtree generation
and renderer-driven real-source refinement/cancellation remain outstanding in
T5/T6/T9/T10.
