---
layout: home

hero:
  name: COPC Adapter
  text: Stream COPC directly in the browser
  tagline: Load Cloud Optimized Point Cloud data in CesiumJS without converting it to renderer-specific tiles.
  actions:
    - theme: brand
      text: Korean guide
      link: /ko/
    - theme: alt
      text: Public API
      link: /API

features:
  - title: Direct COPC streaming
    details: Read the original COPC source through HTTP Range requests instead of preprocessing it into Cesium-specific tiles.
  - title: View-driven LoD
    details: Select hierarchy nodes from the active camera view using frustum filtering, screen-space error, workload limits, and progressive replacement.
  - title: Reusable Cesium layer
    details: Attach COPC data to an application-owned Cesium Viewer through a typed public API.
  - title: Validation evidence
    details: Keep browser, package, CRS, Worker, cache, cancellation, and multi-GB validation results alongside the implementation.
---

# Documentation

The detailed English technical documents remain the canonical low-level reference:

- [Public API](/API)
- [Issue #239 layer API semantics](/proposals/issue-239-layer-api)
- [Issue #244 vertical CRS and geoid-grid decision](/proposals/issue-244-vertical-crs-geoid-grid)
- [Issue #404 dataset-relative and HAG color semantics](/proposals/issue-404-relative-and-hag-color-semantics)
- [Architecture](/ARCHITECTURE)
- [Conformance](/CONFORMANCE)
- [Examples](/EXAMPLES)
- [HTTP Range / CORS hosting guide](/source-hosting)
- [Roadmap](/ROADMAP)
- [Contest functional-test runbook](/CONTEST-FUNCTIONAL-TEST)
- [Playground and Pages deployment](/PLAYGROUND)

For a more learning-oriented explanation, use the [Korean guide](/ko/).
