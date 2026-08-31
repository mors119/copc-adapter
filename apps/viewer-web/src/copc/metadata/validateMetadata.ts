import { createPointTransformer } from '../../coordinates/transform/createPointTransformer';
import type { CopcMetadata } from '../types/copc';

/** Internal validation detail used to produce actionable public metadata errors. */
export class CopcMetadataValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CopcMetadataValidationError';
  }
}

function assertFiniteValues(label: string, values: number[]): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new CopcMetadataValidationError(
      `COPC ${label} must contain only finite numbers.`,
    );
  }
}

function assertOrderedBounds(
  label: string,
  bounds: CopcMetadata['bounds'] | CopcMetadata['cube'],
): void {
  assertFiniteValues(label, [
    bounds.minX,
    bounds.minY,
    bounds.minZ,
    bounds.maxX,
    bounds.maxY,
    bounds.maxZ,
  ]);

  if (
    bounds.minX > bounds.maxX ||
    bounds.minY > bounds.maxY ||
    bounds.minZ > bounds.maxZ
  ) {
    throw new CopcMetadataValidationError(
      `COPC ${label} minimum values must not exceed maximum values.`,
    );
  }
}

/** Validate metadata required by hierarchy selection and geographic rendering. */
export function validateCopcMetadata(metadata: CopcMetadata): void {
  if (!Number.isSafeInteger(metadata.pointCount) || metadata.pointCount < 0) {
    throw new CopcMetadataValidationError(
      'COPC pointCount must be a non-negative safe integer.',
    );
  }

  assertOrderedBounds('bounds', metadata.bounds);
  assertOrderedBounds('cube', metadata.cube);

  if (
    metadata.spacing !== undefined &&
    (!Number.isFinite(metadata.spacing) || metadata.spacing <= 0)
  ) {
    throw new CopcMetadataValidationError(
      'COPC spacing must be a positive finite number.',
    );
  }

  try {
    const transformPoint = createPointTransformer(metadata);
    const transformed = transformPoint({
      x: (metadata.bounds.minX + metadata.bounds.maxX) / 2,
      y: (metadata.bounds.minY + metadata.bounds.maxY) / 2,
      z: (metadata.bounds.minZ + metadata.bounds.maxZ) / 2,
    });

    assertFiniteValues('CRS transformation result', [
      transformed.longitude,
      transformed.latitude,
      transformed.height,
    ]);
  } catch (error: unknown) {
    if (error instanceof CopcMetadataValidationError) {
      throw error;
    }

    const detail = error instanceof Error
      ? error.message
      : 'unknown CRS error';

    throw new CopcMetadataValidationError(
      `COPC CRS is missing, malformed, or unsupported: ${detail}`,
      { cause: error },
    );
  }
}
