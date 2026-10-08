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
- [Architecture](/ARCHITECTURE)
- [Conformance](/CONFORMANCE)
- [Examples](/EXAMPLES)
- [Roadmap](/ROADMAP)
- [Contest functional-test runbook](/CONTEST-FUNCTIONAL-TEST)

For a more learning-oriented explanation, use the [Korean guide](/ko/).
