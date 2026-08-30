import type { CopcBackendName } from '../backend/selection';
import type { GeographicPointBuffer } from '../types/copc';

/** Small project-owned reference carried by a rendered Cesium point. */
export type CopcPointPickId = Readonly<{
  nodeKey: string;
  pointIndex: number;
  /** Layer-local token used when multiple COPC layers share a viewer. */
  ownerId?: string;
}>;

export type CopcPointInspection = {
  nodeKey: string;
  level: number;
  pointIndex: number;
  longitude: number;
  latitude: number;
  height: number;
  source?: { x: number; y: number; z: number };
  intensity?: number;
  classification?: number;
  classificationLabel?: string;
  rgb?: { red: number; green: number; blue: number };
  backend: CopcBackendName | 'custom';
};

const ASPRS_CLASSIFICATION_LABELS: Readonly<Record<number, string>> = {
  0: 'Never Classified',
  1: 'Unclassified',
  2: 'Ground',
  3: 'Low Vegetation',
  4: 'Medium Vegetation',
  5: 'High Vegetation',
  6: 'Building',
};

export function isCopcPointPickId(value: unknown): value is CopcPointPickId {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CopcPointPickId>;
  const pointIndex = candidate.pointIndex;
  return typeof candidate.nodeKey === 'string'
    && candidate.nodeKey.length > 0
    && typeof pointIndex === 'number'
    && Number.isSafeInteger(pointIndex)
    && pointIndex >= 0;
}

function getClassificationLabel(code: number): string | undefined {
  return ASPRS_CLASSIFICATION_LABELS[code];
}

/**
 * Map a rendered point reference to the current project-owned point buffer.
 * Undefined fields intentionally mean unavailable or unrequested.
 */
export function inspectCopcPoint(
  pickId: CopcPointPickId,
  node: { level: number },
  points: GeographicPointBuffer,
  backend: CopcBackendName | 'custom',
): CopcPointInspection | undefined {
  if (!isCopcPointPickId(pickId)
    || !Number.isSafeInteger(node.level)
    || pickId.pointIndex >= points.pointCount
    || pickId.pointIndex * 3 + 2 >= points.coordinates.length) {
    return undefined;
  }

  const offset = pickId.pointIndex * 3;
  const inspection: CopcPointInspection = {
    nodeKey: pickId.nodeKey,
    level: node.level,
    pointIndex: pickId.pointIndex,
    longitude: points.coordinates[offset],
    latitude: points.coordinates[offset + 1],
    height: points.coordinates[offset + 2],
    backend,
  };

  if (points.sourceCoordinates && points.sourceCoordinates.length >= offset + 3) {
    inspection.source = {
      x: points.sourceCoordinates[offset],
      y: points.sourceCoordinates[offset + 1],
      z: points.sourceCoordinates[offset + 2],
    };
  }

  const { intensity, classification, red, green, blue } = points.attributes ?? {};
  if (intensity && pickId.pointIndex < intensity.length) {
    inspection.intensity = intensity[pickId.pointIndex];
  }
  if (classification && pickId.pointIndex < classification.length) {
    inspection.classification = classification[pickId.pointIndex];
    inspection.classificationLabel = getClassificationLabel(
      classification[pickId.pointIndex],
    );
  }
  if (red && green && blue
    && pickId.pointIndex < red.length
    && pickId.pointIndex < green.length
    && pickId.pointIndex < blue.length) {
    inspection.rgb = {
      red: red[pickId.pointIndex],
      green: green[pickId.pointIndex],
      blue: blue[pickId.pointIndex],
    };
  }

  return inspection;
}
