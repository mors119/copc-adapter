import * as Cesium from "cesium";
import * as THREE from "three";
import type {
  CopcMetadata,
  CopcPointBuffer,
} from "../../../packages/core/copc/types/copc";
import { performanceNow } from "../../../packages/core/copc/performance";
import { transformPointBufferToPreparedPointData } from "../../../packages/core/coordinates/transform/createPointTransformer";
import { createCompactEPointCacheNode } from "../../../packages/core/point/compactEPointCache";
import {
  ThreePointRenderer,
  type ThreePointRendererPerformanceStage,
} from "../../../packages/three/render/ThreePointRenderer";
import {
  PointPrimitiveRenderer,
  type CesiumPointRenderer,
  type CopcCesiumPointRendererOptions,
  type CopcPointRendererPerformanceStage,
} from "../../../packages/cesium/render/CopcPointRenderer";
import { BatchedGeometryPointRenderer } from "@frillab/copc-adapter/cesium";

export type RendererBenchmarkKind = "point-primitive" | "batched-geometry";

type BenchmarkStage = CopcPointRendererPerformanceStage | "nodeReplacement";

export type BenchmarkRange = {
  minMs: number;
  medianMs: number;
  maxMs: number;
};

export type RendererPerformanceBenchmarkRow = {
  renderer: RendererBenchmarkKind;
  cacheLayout: "A" | "E";
  pointCount: number;
  crsTransform: BenchmarkRange;
  representationMaterialization: BenchmarkRange;
  geographicToCartesian: BenchmarkRange;
  worldToCartesian: BenchmarkRange;
  pointStylePreparation: BenchmarkRange;
  pointCollectionCreation: BenchmarkRange;
  pointAdd: BenchmarkRange;
  rendererPreparation: BenchmarkRange;
  nodeReplacement: BenchmarkRange;
  styleUpdate: BenchmarkRange;
  nodeRemoval: BenchmarkRange;
};

export type RendererPerformanceBenchmarkOptions = {
  viewer?: Cesium.Viewer;
  pointCounts?: readonly number[];
  repetitions?: number;
  warmups?: number;
  colorMode?: CopcCesiumPointRendererOptions["colorMode"];
  renderer?: RendererBenchmarkKind;
  /** Internal cache-layout comparison; A remains the default benchmark path. */
  cacheLayout?: "A" | "E";
};

const SYNTHETIC_METADATA: CopcMetadata = {
  pointCount: 100_000,
  bounds: {
    minX: -13_600_000,
    minY: 5_400_000,
    minZ: 0,
    maxX: -13_590_000,
    maxY: 5_410_000,
    maxZ: 100,
  },
  cube: {
    minX: -13_600_000,
    minY: 5_400_000,
    minZ: 0,
    maxX: -13_590_000,
    maxY: 5_410_000,
    maxZ: 100,
  },
  wkt: 'PROJCS["WGS 84 / Pseudo-Mercator", GEOGCS["WGS 84", DATUM["WGS_1984", SPHEROID["WGS 84",6378137,298.257223563]], PRIMEM["Greenwich",0], UNIT["degree",0.0174532925199433]], PROJECTION["Mercator_1SP"], PARAMETER["central_meridian",0], PARAMETER["scale_factor",1], PARAMETER["false_easting",0], PARAMETER["false_northing",0], UNIT["metre",1]]',
};

const DEFAULT_POINT_COUNTS = [1_000, 10_000, 50_000, 100_000];

/** Deterministic projected coordinates and all supported style attributes. */
export function createDeterministicPointBuffer(
  pointCount: number,
): CopcPointBuffer {
  const coordinates = new Float64Array(pointCount * 3);
  const intensity = new Uint16Array(pointCount);
  const classification = new Uint8Array(pointCount);
  const red = new Uint16Array(pointCount);
  const green = new Uint16Array(pointCount);
  const blue = new Uint16Array(pointCount);

  for (let index = 0; index < pointCount; index += 1) {
    const offset = index * 3;
    coordinates[offset] = -13_600_000 + (index % 1_000) * 10;
    coordinates[offset + 1] = 5_400_000 + ((index * 7) % 1_000) * 10;
    coordinates[offset + 2] = index % 100;
    intensity[index] = index % 65_536;
    classification[index] = index % 19;
    red[index] = index % 256;
    green[index] = (index * 3) % 256;
    blue[index] = (index * 7) % 256;
  }

  return {
    pointCount,
    coordinates,
    attributes: { intensity, classification, red, green, blue },
  };
}

function createHeadlessViewer(): Cesium.Viewer {
  const collections: Cesium.PointPrimitiveCollection[] = [];
  return {
    scene: {
      primitives: {
        add(collection: Cesium.PointPrimitiveCollection) {
          collections.push(collection);
          return collection;
        },
        remove(collection: Cesium.PointPrimitiveCollection) {
          const index = collections.indexOf(collection);
          if (index >= 0) {
            collections.splice(index, 1);
          }
          return true;
        },
      },
    },
  } as unknown as Cesium.Viewer;
}

function summarize(values: number[]): BenchmarkRange {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function recordStage(
  values: Partial<Record<BenchmarkStage, number[]>>,
  stage: BenchmarkStage,
  durationMs: number,
): void {
  (values[stage] ??= []).push(durationMs);
}

function rendererOptions(
  colorMode: CopcCesiumPointRendererOptions["colorMode"],
  values: Partial<Record<BenchmarkStage, number[]>>,
): CopcCesiumPointRendererOptions {
  return {
    pointSize: 2,
    colorMode,
    onPerformance: (stage, durationMs) =>
      recordStage(values, stage, durationMs),
  };
}

/**
 * Run the same renderer path used by the layer against repeatable buffers.
 * Browser callers should provide the real viewer to include its Cesium scene;
 * Node callers get a collection-only headless scene by default.
 */
export function runSyntheticRendererPerformanceBenchmark(
  options: RendererPerformanceBenchmarkOptions = {},
): RendererPerformanceBenchmarkRow[] {
  const viewer = options.viewer ?? createHeadlessViewer();
  const repetitions = Math.max(1, Math.floor(options.repetitions ?? 7));
  const warmups = Math.max(0, Math.floor(options.warmups ?? 2));
  const pointCounts = options.pointCounts ?? DEFAULT_POINT_COUNTS;
  const colorMode = options.colorMode ?? "rgb";
  const rendererKind = options.renderer ?? "point-primitive";
  const cacheLayout = options.cacheLayout ?? "A";
  const rows: RendererPerformanceBenchmarkRow[] = [];

  for (const pointCount of pointCounts) {
    const points = createDeterministicPointBuffer(pointCount);
    const crsValues: number[] = [];
    const materializationValues: number[] = [];
    const styleUpdateValues: number[] = [];
    const stages: Partial<Record<BenchmarkStage, number[]>> = {};

    for (
      let repetition = 0;
      repetition < warmups + repetitions;
      repetition += 1
    ) {
      const crsStartedAt = performanceNow();
      const preparedPoints = transformPointBufferToPreparedPointData(
        SYNTHETIC_METADATA,
        points,
      );
      const crsDuration = performanceNow() - crsStartedAt;
      const materializationStartedAt = performanceNow();
      const rendererPoints =
        cacheLayout === "E"
          ? createCompactEPointCacheNode(preparedPoints, {
              nodeKey: "synthetic-node",
              provenance: {
                sourceIdentity: "deterministic renderer benchmark input",
                sourceCrsWkt: SYNTHETIC_METADATA.wkt,
                transformGeneration: 0,
                heightOffsetMeters: 0,
                verticalDatum: { status: "no-validated-grid-correction" },
              },
            })
          : preparedPoints;
      const materializationDuration =
        performanceNow() - materializationStartedAt;
      const firstStages: Partial<Record<BenchmarkStage, number[]>> = {};
      const renderer: CesiumPointRenderer =
        rendererKind === "batched-geometry"
          ? new BatchedGeometryPointRenderer()
          : new PointPrimitiveRenderer();
      renderer.attachTo(viewer);

      renderer.addOrUpdateNode(
        "synthetic-node",
        rendererPoints,
        rendererOptions(colorMode, firstStages),
      );

      const replacementStartedAt = performanceNow();
      const replacementStages: Partial<Record<BenchmarkStage, number[]>> = {};
      renderer.addOrUpdateNode(
        "synthetic-node",
        rendererPoints,
        rendererOptions(colorMode, replacementStages),
      );
      const replacementDuration = performanceNow() - replacementStartedAt;

      const styleUpdateStartedAt = performanceNow();
      renderer.updateNodeStyle?.(
        "synthetic-node",
        rendererPoints,
        rendererOptions(colorMode === "fixed" ? "rgb" : "fixed", {}),
      );
      const styleUpdateDuration = performanceNow() - styleUpdateStartedAt;

      renderer.removeNode("synthetic-node");
      renderer.destroy();

      if (repetition < warmups) {
        continue;
      }

      crsValues.push(crsDuration);
      materializationValues.push(materializationDuration);
      styleUpdateValues.push(styleUpdateDuration);
      for (const [stage, values] of Object.entries(firstStages)) {
        const duration = values?.[0];
        if (duration !== undefined) {
          recordStage(stages, stage as BenchmarkStage, duration);
        }
      }
      recordStage(stages, "nodeReplacement", replacementDuration);
      const removalDuration = replacementStages.nodeRemoval?.[0];
      if (removalDuration !== undefined) {
        recordStage(stages, "nodeRemoval", removalDuration);
      }
    }

    const range = (stage: BenchmarkStage): BenchmarkRange =>
      summarize(stages[stage] ?? []);
    rows.push({
      renderer: rendererKind,
      cacheLayout,
      pointCount,
      crsTransform: summarize(crsValues),
      representationMaterialization: summarize(materializationValues),
      geographicToCartesian: range("geographicToCartesian"),
      worldToCartesian: range("worldToCartesian"),
      pointStylePreparation: range("pointStylePreparation"),
      pointCollectionCreation: range("pointCollectionCreation"),
      pointAdd: range("pointAdd"),
      rendererPreparation: range("rendererPreparation"),
      nodeReplacement: range("nodeReplacement"),
      styleUpdate: summarize(styleUpdateValues),
      nodeRemoval: range("nodeRemoval"),
    });
  }

  return rows;
}

/**
 * Run the Three.js renderer preparation path in the browser without requiring
 * a mounted COPC layer. This measures CPU-side geometry/color preparation;
 * actual GPU upload and frame timing require a rendered streaming scenario.
 */
export function runSyntheticThreeCacheLayoutBenchmark(options: {
  pointCount?: number;
  repetitions?: number;
  warmups?: number;
} = {}): Array<{
  cacheLayout: "A" | "E";
  pointCount: number;
  crsTransform: BenchmarkRange;
  representationMaterialization: BenchmarkRange;
  rendererPreparation: BenchmarkRange;
  worldToLocal: BenchmarkRange;
  geometryCreation: BenchmarkRange;
  materialCreation: BenchmarkRange;
  nodeRemoval: BenchmarkRange;
}> {
  const pointCount = options.pointCount ?? 100_000;
  const repetitions = Math.max(1, Math.floor(options.repetitions ?? 5));
  const warmups = Math.max(0, Math.floor(options.warmups ?? 2));
  const results = [];

  for (const cacheLayout of ["A", "E"] as const) {
    const samples = {
      crsTransform: [] as number[],
      representationMaterialization: [] as number[],
      rendererPreparation: [] as number[],
      worldToLocal: [] as number[],
      geometryCreation: [] as number[],
      materialCreation: [] as number[],
      nodeRemoval: [] as number[],
    };

    for (let repetition = 0; repetition < warmups + repetitions; repetition += 1) {
      const pointBuffer = createDeterministicPointBuffer(pointCount);
      const crsStartedAt = performanceNow();
      const prepared = transformPointBufferToPreparedPointData(
        SYNTHETIC_METADATA,
        pointBuffer,
      );
      const crsDuration = performanceNow() - crsStartedAt;
      const materializationStartedAt = performanceNow();
      const rendererPoints =
        cacheLayout === "E"
          ? createCompactEPointCacheNode(prepared, {
              nodeKey: "synthetic-three-node",
              provenance: {
                sourceIdentity: "deterministic renderer benchmark input",
                sourceCrsWkt: SYNTHETIC_METADATA.wkt,
                transformGeneration: 0,
                heightOffsetMeters: 0,
                verticalDatum: { status: "no-validated-grid-correction" },
              },
            })
          : prepared;
      const materializationDuration =
        performanceNow() - materializationStartedAt;
      const stages: Partial<
        Record<ThreePointRendererPerformanceStage, number[]>
      > = {};
      const renderer = new ThreePointRenderer({
        localOrigin: {
          coordinateSystem: "wgs84-ecef-meters",
          x: prepared.world.coordinates[0],
          y: prepared.world.coordinates[1],
          z: prepared.world.coordinates[2],
        },
      });
      renderer.attachTo(new THREE.Scene());
      const onPerformance = (
        stage: ThreePointRendererPerformanceStage,
        durationMs: number,
      ): void => {
        (stages[stage] ??= []).push(durationMs);
      };
      renderer.addOrUpdateNode("synthetic-three-node", rendererPoints, {
        pointSize: 2,
        colorMode: "rgb",
        onPerformance,
      });
      renderer.removeNode("synthetic-three-node");
      renderer.destroy();

      if (repetition >= warmups) {
        samples.crsTransform.push(crsDuration);
        samples.representationMaterialization.push(materializationDuration);
        for (const name of [
          "rendererPreparation",
          "worldToLocal",
          "geometryCreation",
          "materialCreation",
          "nodeRemoval",
        ] as const) {
          const value = stages[name]?.[0];
          if (value !== undefined) samples[name].push(value);
        }
      }
    }

    results.push({
      cacheLayout,
      pointCount,
      crsTransform: summarize(samples.crsTransform),
      representationMaterialization: summarize(
        samples.representationMaterialization,
      ),
      rendererPreparation: summarize(samples.rendererPreparation),
      worldToLocal: summarize(samples.worldToLocal),
      geometryCreation: summarize(samples.geometryCreation),
      materialCreation: summarize(samples.materialCreation),
      nodeRemoval: summarize(samples.nodeRemoval),
    });
  }

  return results;
}
