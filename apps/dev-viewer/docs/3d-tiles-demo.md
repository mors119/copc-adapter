# Record the experimental 3D Tiles demo

This Dev Viewer demo runs a generated 131,072-point COPC through the public
Adapter Core and Tiles workspace APIs, scans its complete hierarchy, serves the
generated Tileset and GLBs locally, and displays them with Cesium or Three.js.
The fixture is real COPC data with supported WGS 84 geographic coordinates
(`EPSG:4326`), LAS X/Y values in the WKT-declared latitude/longitude axis
order, and explicit ellipsoidal height; it is synthetic terrain and is not a
survey dataset. Its generated file stays under the ignored
`samples/local/` directory.

## Start the demo

Use the repository's Node.js LTS version, install the workspace and Dev Viewer
dependencies, and make sure PDAL has its COPC writer enabled. From the
repository root run:

```sh
npm ci
npm ci --prefix apps/dev-viewer --workspaces=false
npm --prefix apps/dev-viewer run demo:tiles
```

The command generates the fixture with PDAL, prepares the Adapter's local
browser assets, and starts the Dev Viewer at
`http://127.0.0.1:4177/?source=/samples/demo-wgs84.copc.laz`. The initial
pipeline is Direct COPC.

## Record a 30–45 second GIF

1. (5 seconds) Open the URL above in Chromium at a desktop size such as
   1440×900 and show **Direct COPC (default)**.
2. (5 seconds) Select **3D Tiles (Experimental)** and press **Apply Settings**.
3. (10 seconds) Open **Health** in the right panel. Wait until the pipeline says `ready`, the
   conservative bounds say `supported`, and GLB requests, visible tiles, and
   visible points are greater than zero.
4. (10–20 seconds) Choose **Near**, orbit the point cloud, then choose
   **Overview** so the GIF ends on the full generated surface.

For a Three.js recording, open the same URL with `&renderer=three` added, then
repeat steps 3–5. The pipeline selector is independent of the renderer.

Run the focused browser regression from the repository root with:

```sh
npm --prefix apps/dev-viewer run test:e2e:tiles
```

This also regenerates the ignored WGS 84 and projected fixtures before launching
Chromium; the projected fixture verifies the visible fail-closed diagnostic.

## Scope

The demo deliberately uses a small bounded fixture and a complete hierarchy
scan. It demonstrates the COPC → Tileset → GLB → rendered-point path; it is not
a public package release or a production adaptive-LOD benchmark. The adapter
continues to own COPC decoding, coordinate transforms, and conservative ECEF
bounds. A selected vertical grid is passed to Adapter Core only after the
Dev Viewer verifies it through the pinned public GTX loaders. Unsupported
projected conservative bounds stop Tileset creation before content GLBs are
requested. Autzen (EPSG:2992) and SoFi (EPSG:32611) therefore remain fail-closed;
use Direct COPC for those sources in the Dev Viewer.

The selector is local to this developer host. It does not add a public
Playground option or an npm installation path for `@frillab/copc-tiles`.
Appearance controls are disabled while Tiles is selected; switch back to
Direct COPC to use them. Direct streaming controls are unavailable in Tiles mode.
