import type { ViewVector3 } from './types';

/** Named refinement weighting policies supported by the shared selector. */
export type RefinementAlgorithm = 'foveated' | 'screen-projection';

/** Default refinement weighting used by v0.6.0 and later. */
export const DEFAULT_REFINEMENT_ALGORITHM: RefinementAlgorithm = 'foveated';

/** A circular focus lens in normalized viewer-canvas coordinates. */
export type RefinementFocus = {
  /** Lens shape. */
  type: 'screen-circle';
  /** Center in normalized viewport coordinates: x left→right, y top→bottom. */
  center: { x: number; y: number };
  /** Circle radius as a fraction of the smaller drawing-buffer dimension. */
  radius: number;
  /** Maximum requested refinement-pressure multiplier, in [1, 2]. */
  detailBias: number;
};

/** Maximum explicit focus refinement-pressure multiplier. */
export const MAX_REFINEMENT_FOCUS_DETAIL_BIAS = 2;

/** Validate runtime inputs from JavaScript consumers and detach mutable state. */
export function normalizeRefinementFocus(
  focus: RefinementFocus | undefined,
): RefinementFocus | undefined {
  if (focus === undefined) {
    return undefined;
  }
  if (focus === null || typeof focus !== 'object' || Array.isArray(focus)) {
    throw new TypeError('Refinement focus must be a screen-circle object or undefined');
  }
  if (focus.type !== 'screen-circle') {
    throw new TypeError('Refinement focus type must be "screen-circle"');
  }
  if (focus.center === null || typeof focus.center !== 'object' || Array.isArray(focus.center)) {
    throw new TypeError('Refinement focus center must contain normalized x and y values');
  }
  for (const [name, value] of Object.entries({
    x: focus.center.x,
    y: focus.center.y,
  })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`Refinement focus center.${name} must be finite and between 0 and 1`);
    }
  }
  if (!Number.isFinite(focus.radius) || focus.radius <= 0 || focus.radius > 1) {
    throw new RangeError('Refinement focus radius must be finite and in the interval (0, 1]');
  }
  if (!Number.isFinite(focus.detailBias)
    || focus.detailBias < 1
    || focus.detailBias > MAX_REFINEMENT_FOCUS_DETAIL_BIAS) {
    throw new RangeError(
      `Refinement focus detailBias must be finite and between 1 and ${MAX_REFINEMENT_FOCUS_DETAIL_BIAS}`,
    );
  }

  return {
    type: 'screen-circle',
    center: { x: focus.center.x, y: focus.center.y },
    radius: focus.radius,
    detailBias: focus.detailBias,
  };
}

/** Validate an algorithm supplied through an untyped JavaScript boundary. */
export function resolveRefinementAlgorithm(value: unknown): RefinementAlgorithm {
  if (value === undefined) {
    return DEFAULT_REFINEMENT_ALGORITHM;
  }
  if (value === 'foveated' || value === 'screen-projection') {
    return value;
  }
  throw new TypeError(
    `Unknown refinement algorithm ${JSON.stringify(value)}; choose "foveated" or "screen-projection"`,
  );
}

/** Shared node projection values passed to each internal refinement strategy. */
export type RefinementRelevanceInput = {
  /** Existing signed camera-plane projection in normalized viewport coordinates. */
  screenX?: number;
  screenY?: number;
  /** Existing conservative legacy center relevance. */
  screenProjectionWeight: number;
  /** Existing scheduling-only center relevance. */
  screenProjectionSchedulingWeight: number;
  /** Smallest non-negative angular gap between node sphere and the center ray. */
  angularGapRadians?: number;
  /** Angular falloff radius derived from the current vertical field of view. */
  angularFalloffRadians?: number;
};

/** Bounded automatic relevance outputs used by refinement and scheduling. */
export type RefinementRelevance = {
  refinementWeight: number;
  schedulingWeight: number;
};

/** Internal named policy contract; traversal, SSE, budgets and coverage stay shared. */
export type RefinementRelevanceStrategy = {
  algorithm: RefinementAlgorithm;
  evaluate(input: RefinementRelevanceInput): RefinementRelevance;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) {
    return value <= edge0 ? 0 : 1;
  }
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

const screenProjectionStrategy: RefinementRelevanceStrategy = {
  algorithm: 'screen-projection',
  evaluate(input) {
    return {
      refinementWeight: input.screenProjectionWeight,
      schedulingWeight: input.screenProjectionSchedulingWeight,
    };
  },
};

const foveatedStrategy: RefinementRelevanceStrategy = {
  algorithm: 'foveated',
  evaluate(input) {
    const gap = input.angularGapRadians;
    const falloff = input.angularFalloffRadians;
    if (gap === undefined || falloff === undefined || falloff <= 0) {
      return { refinementWeight: 0, schedulingWeight: 0 };
    }

    const normalizedGap = clamp(gap / falloff, 0, 1);
    // Smooth angular falloff gives the view-direction strategy a distinct,
    // volume-aware profile while keeping the screen-projection baseline exact.
    const refinementWeight = 1 - smoothstep(0, 1, normalizedGap);
    const schedulingWeight = clamp(Math.exp(-0.5 * (gap / falloff) ** 2), 0, 1);
    return { refinementWeight, schedulingWeight };
  },
};

const strategies: Record<RefinementAlgorithm, RefinementRelevanceStrategy> = {
  foveated: foveatedStrategy,
  'screen-projection': screenProjectionStrategy,
};

/** Create the shared selector policy for a validated algorithm name. */
export function createRefinementRelevanceStrategy(
  value: unknown,
): RefinementRelevanceStrategy {
  return strategies[resolveRefinementAlgorithm(value)];
}

/** Dot product helper used by angular focus-ray calculations. */
export function dotViewVectors(left: ViewVector3, right: ViewVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
