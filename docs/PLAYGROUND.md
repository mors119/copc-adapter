# Playground and GitHub Pages

The static site keeps documentation and the Playground in one GitHub Pages
deployment:

- Documentation: <https://mors119.github.io/copc-adapter/>
- Korean documentation: <https://mors119.github.io/copc-adapter/ko/>
- Interactive Playground: <https://mors119.github.io/copc-adapter/playground/>

The VitePress site owns the repository Pages root. The Playground is built for
the nested `/copc-adapter/playground/` base and is assembled into the same
artifact under `playground/`; deploying either site therefore retains the
other.

The Playground is the public demo: it loads the built-in Autzen or Chicago
dataset, a directly requested custom HTTP(S) URL, or a local file. It supports
Cesium and Three.js, JavaScript and Rust/WASM backends, common color modes,
point size, streaming limits, and point inspection. The refinement selector
uses the public `foveated` default or legacy `screen-projection` strategy. The
Cesium Focus Lens can boost the center, follow the canvas pointer, or stay
pinned; movement, radius, and detail bias update the loaded layer without
reloading its source. Algorithm changes apply through layer recreation. The
screen-space guide is visual only and does not crop the point cloud. Detailed
worker, cache, and benchmark diagnostics remain in the internal Dev Viewer.

HTTP sources must allow browser CORS and ranged GET requests. The probe reports
the validation evidence available to the browser; that response validation
does not prove remote file authenticity or immutability. Local files are read
in the browser and are not uploaded. The package card reports the installed
adapter version and origin. Public Pages uses an exact published npm version
verified against its lockfile; workspace source and packed candidates have
separate labels in development and candidate validation.

For Playground setup, development, release-candidate validation, and local
Pages builds, see the [Playground README](https://github.com/mors119/copc-adapter/blob/main/apps/playground/README.md).
