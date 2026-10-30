import type { SchemaActionDefinition } from "./types.ts";

/** Host-invoked operations that are not persistent layer configuration values. */
export const ACTION_SCHEMA = [
  {
    id: "source.probe",
    label: "Probe Source",
    description: "Check source metadata and browser-visible Range behavior.",
    section: "source",
    control: "action",
    renderers: ["cesium", "three"],
    requiredCapabilities: ["source.probe"],
    stability: "stable",
  },
  {
    id: "source.load",
    label: "Load Source",
    description: "Apply the pending source and layer configuration.",
    section: "source",
    control: "action",
    renderers: ["cesium", "three"],
    requiredCapabilities: ["source.load"],
    stability: "stable",
  },
  {
    id: "coordinates.terrainAlignment",
    label: "Estimate Terrain Alignment",
    description: "Compare validated ground anchors against the configured Cesium Terrain provider, preview the proposed visual offset, and apply it only with approval.",
    section: "coordinates",
    control: "terrain-alignment",
    renderers: ["cesium", "three"],
    requiredCapabilities: ["cesium.terrain-alignment"],
    stability: "stable",
  },
] as const satisfies readonly SchemaActionDefinition[];
