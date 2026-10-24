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

The Playground is the public demo: it offers the built-in Autzen or Chicago
dataset, a custom HTTP(S) URL, or a local file. For remote sources, **Probe
source** calls the public `probeCopcSource()` API and shows the browser-visible
HTTP status, CORS readability, Range support, COPC detection, point format,
size, validation level, and warnings. It does not create or replace a layer.
The matching **Load source** action is enabled only for that exact probed URL
and is disabled for known incompatibilities. Unknown checks are shown as
unknown; Load is then an explicit attempt and can still fail. Editing the URL
invalidates its probe. Local files bypass the HTTP probe and remain in the
browser.

After load, the source panel displays point count, point format, source bounds,
source-provided WKT availability, active backend, and renderer when available.
Bounds remain in source CRS units. The Playground does not infer a CRS,
vertical datum, or height reference from location.

The controls include renderer, backend, color mode, point size, rendered-point
and CPU cache budgets, max nodes, max depth, screen-space error, maximum render
distance, refinement algorithm, and Focus Lens. Constructor changes are
Pending until **Apply changes** replaces the layer successfully. The old layer
stays active if replacement fails, and the camera is preserved when possible.
The rendered-point budget estimates active-view workload, not GPU memory; the
cache budget covers decoded CPU point buffers and is entered in MiB before
conversion to integer bytes. Max nodes limits frontier pressure, max depth
caps hierarchy refinement, lower SSE generally requests finer LoD, and render
distance limits far visibility. Cesium color and
classification changes use the public `getStyle()` and `setStyle()` methods
without replacing the layer. Classification values are LAS codes 0–255; an
empty include list hides every point, excludes apply after includes, and Clear
removes the filter. The published Three.js layer has no runtime style setter,
so its color changes require Apply and classification is disabled. Clear a
Cesium filter before switching to Three.js. The Cesium Focus Lens updates the
active layer, while algorithm changes use Apply. The guide is visual only and
does not crop the point cloud.

During replacement, the Playground creates a hidden candidate runtime and
keeps the active runtime visible until the candidate loads. A successful swap
then disposes the previous runtime; a failed or superseded candidate is
disposed while the active runtime remains. Cesium replacements may briefly
use two viewer instances.

**Reset to defaults** restores Playground defaults while preserving source
selection. Cesium runtime styles reset through the public setter; constructor
settings remain Pending until Apply. Generated code represents only the last
successfully applied settings and style. It uses public constructor options
and Cesium `setStyle()` calls and compiles against the pinned npm package.
Minimal and Explicit modes are available. Detailed worker, cache, and
benchmark diagnostics remain in the internal Dev Viewer.

Canonical share links include normalized control settings but omit the source
by default. An optional source is included only when it is a query-free
HTTP(S) URL. Credentials, query strings, fragments, local paths, and file
contents are excluded. Opening a link restores settings; a safe included URL
still needs a fresh Probe and explicit Load. Settings-only links do not claim a
layer is loaded.

HTTP sources must allow browser CORS and usable byte-range requests. The probe
reports evidence available to the browser and preserves the package's response
validation policy; it does not prove remote file authenticity or immutability.
When a browser hides the cause of a failed request, check the URL, host CORS,
Range handling, and access policy. Sources are requested directly without a
proxy or upload. The package card reports the installed adapter version and
origin. Public Pages uses an exact published npm version verified against its
lockfile; workspace source and packed candidates have separate labels in
development and candidate validation.

For Playground setup, development, release-candidate validation, and local
Pages builds, see the [Playground README](https://github.com/mors119/copc-adapter/blob/main/apps/playground/README.md).
