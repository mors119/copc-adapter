# Live COPC Adapter functional validation

This procedure uses the repository's existing Cesium development viewer. It
does not use a separate demo application or a special scenario URL.

## Clean clone setup

Use Node.js 22 (the repository's CI line), npm, and an installed Rust toolchain
managed by rustup. Setup builds the viewer's bundled WASM asset for the opt-in
Rust backend, while the default live viewer uses `copc-js`. Setup adds only the
`wasm32-unknown-unknown` target and does not install a Rust toolchain for you.

```sh
git clone https://github.com/mors119/copc-adapter.git
cd copc-adapter
npm run setup
npm run dev
```

`npm run setup` installs root and viewer dependencies, verifies the installed
Rust toolchain and WASM target, builds the viewer's WASM asset, downloads and
verifies Autzen, and prepares Playwright Chromium. If rustup is missing,
install it from [rustup.rs](https://rustup.rs/) and run setup again. The sample
is stored under `samples/local/`; Vite serves it directly with same-origin
Range handling, so no manual copy is needed.

Open the default page:

<http://127.0.0.1:4177/>

The root dev command binds only to `127.0.0.1` and fails if port 4177 is
occupied. Stop the process using that port and rerun the command.

## Eight-step live sequence

The runtime panel and Point Inspector appear on the default page. The panel's
validation controls use the same Cesium camera and layer styling actions as
the viewer runtime.

1. **Direct visualization:** confirm the Autzen point cloud is visible and the
   panel reports `Ready`, `copc-js`, and `autzen.copc.laz`.
2. **HTTP Range:** in browser DevTools Network, filter for `autzen.copc.laz`.
   Confirm requests carry `Range: bytes=...` and responses return `206 Partial
   Content` with a matching `Content-Range`.
3. **Hierarchy and node selection:** rotate or move the Cesium camera, then
   show the selected/rendered node and hierarchy request/cache counters
   changing in Core evidence.
4. **LoD:** use `Overview`, then `Near`. Compare the visible level range,
   selected nodes, and streaming update count.
5. **Progressive refinement:** watch active replacement groups, coarse nodes
   retained for coverage, and refinement replacement commits while moving to
   `Near`.
6. **Bounded work and cache reuse:** show the configured and active rendered
   point counts, point-cache bytes and budget, and cache hits/misses. Move to
   `Far`, return to `Near`, and show cache reuse.
7. **Color modes:** select `RGB`, `Elevation`, `Intensity`, and
   `Classification`. The active mode is highlighted in the panel while the
   same loaded layer remains visible.
8. **Point inspection:** click a rendered point and show its Node, Level,
   Index, Longitude, Latitude, Height, Source XYZ, Intensity, Classification,
   and RGB values in Point Inspector. Missing values are labeled `Unavailable`.

The decoded point-cache bytes describe project-owned CPU typed-array
accounting. They are not total browser memory, total Cesium memory, or GPU
memory.

The local Autzen file is served same-origin, and Vite's middleware supplies
real HTTP 206 byte-range responses. This demonstrates that the adapter consumes
proper partial responses. It does not establish that every public hosting
provider has correct Range or CORS configuration.

The panel's Source probe and browser DevTools are available as diagnostics.
Console commands are optional fallback diagnostics; they are not needed to
change camera view or color mode.

## Automated functional gate

From the repository root, run:

```sh
npm run test:functional
```

This runs the focused Playwright sequence against the same default viewer and
UI. It validates direct rendering, actual Range responses, camera-driven
selection and LoD, progressive transition evidence, point budget/cache reuse,
all four visible style controls, point inspection, and final viewer health.

The broader viewer regression suite remains available with
`npm --prefix apps/viewer-web run test:e2e`. Package validation is a separate
boundary and remains available with `npm run test:pack` and
`npm run test:pack:three`.
