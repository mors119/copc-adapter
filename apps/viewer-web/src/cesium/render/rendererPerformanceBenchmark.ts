import * as Cesium from 'cesium';
import type { CopcMetadata, CopcPointBuffer } from '../../copc/types/copc';
import { performanceNow } from '../../copc/performance';
import { transformPointBuffer } from '../../coordinates/transform/createPointTransformer';
import {
  PointPrimitiveRenderer,
  type CopcPointRenderer,
  type CopcPointRendererOptions,
  type CopcPointRendererPerformanceStage,
} from './CopcPointRenderer';

type BenchmarkStage = CopcPointRendererPerformanceStage | 'nodeReplacement';

export type BenchmarkRange = {
  minMs: number;
  medianMs: number;
  maxMs: number;
};

export type RendererPerformanceBenchmarkRow = {
  pointCount: number;
  crsTransform: BenchmarkRange;
  geographicToCartesian: BenchmarkRange;
  pointStylePreparation: BenchmarkRange;
  pointCollectionCreation: BenchmarkRange;
  pointAdd: BenchmarkRange;
  rendererPreparation: BenchmarkRange;
  nodeReplacement: BenchmarkRange;
  nodeRemoval: BenchmarkRange;
};

export type RendererPerformanceBenchmarkOptions = {
  viewer?: Cesium.Viewer;
  pointCounts?: readonly number[];
  repetitions?: number;
  warmups?: number;
  colorMode?: CopcPointRendererOptions['colorMode'];
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
export function createDeterministicPointBuffer(pointCount: number): CopcPointBuffer {
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
  colorMode: CopcPointRendererOptions['colorMode'],
  values: Partial<Record<BenchmarkStage, number[]>>,
): CopcPointRendererOptions {
  return {
    pointSize: 2,
    colorMode,
    onPerformance: (stage, durationMs) => recordStage(values, stage, durationMs),
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
  const colorMode = options.colorMode ?? 'rgb';
  const rows: RendererPerformanceBenchmarkRow[] = [];

  for (const pointCount of pointCounts) {
    const points = createDeterministicPointBuffer(pointCount);
    const crsValues: number[] = [];
    const stages: Partial<Record<BenchmarkStage, number[]>> = {};

    for (let repetition = 0; repetition < warmups + repetitions; repetition += 1) {
      const crsStartedAt = performanceNow();
      const geographicPoints = transformPointBuffer(SYNTHETIC_METADATA, points);
      const crsDuration = performanceNow() - crsStartedAt;
      const firstStages: Partial<Record<BenchmarkStage, number[]>> = {};
      const renderer: CopcPointRenderer = new PointPrimitiveRenderer();
      renderer.attachTo(viewer);

      renderer.addOrUpdateNode(
        'synthetic-node',
        geographicPoints,
        rendererOptions(colorMode, firstStages),
      );

      const replacementStartedAt = performanceNow();
      const replacementStages: Partial<Record<BenchmarkStage, number[]>> = {};
      renderer.addOrUpdateNode(
        'synthetic-node',
        geographicPoints,
        rendererOptions(colorMode, replacementStages),
      );
      const replacementDuration = performanceNow() - replacementStartedAt;

      renderer.removeNode('synthetic-node');
      renderer.destroy();

      if (repetition < warmups) {
        continue;
      }

      crsValues.push(crsDuration);
      for (const [stage, values] of Object.entries(firstStages)) {
        const duration = values?.[0];
        if (duration !== undefined) {
          recordStage(stages, stage as BenchmarkStage, duration);
        }
      }
      recordStage(stages, 'nodeReplacement', replacementDuration);
      const removalDuration = replacementStages.nodeRemoval?.[0];
      if (removalDuration !== undefined) {
        recordStage(stages, 'nodeRemoval', removalDuration);
      }
    }

    const range = (stage: BenchmarkStage): BenchmarkRange =>
      summarize(stages[stage] ?? []);
    rows.push({
      pointCount,
      crsTransform: summarize(crsValues),
      geographicToCartesian: range('geographicToCartesian'),
      pointStylePreparation: range('pointStylePreparation'),
      pointCollectionCreation: range('pointCollectionCreation'),
      pointAdd: range('pointAdd'),
      rendererPreparation: range('rendererPreparation'),
      nodeReplacement: range('nodeReplacement'),
      nodeRemoval: range('nodeRemoval'),
    });
  }

  return rows;
}
