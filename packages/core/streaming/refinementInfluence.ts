import { MAX_REFINEMENT_FOCUS_DETAIL_BIAS } from './refinementStrategies';

/**
 * The maximum amount of refinement pressure that passive gaze (and future
 * bounded signals) may add to raw screen-space error.
 *
 * A 25% ceiling is deliberately conservative: it is large enough to move a
 * near-threshold centre candidate ahead of an equivalent peripheral one, but
 * a genuinely large raw visual error still wins over a modest centre bias.
 */
export const DEFAULT_MAX_REFINEMENT_DETAIL_BIAS = 1.25;

export type RefinementInfluenceInput = {
  rawScreenSpaceError: number;
  gazeWeight?: number;
  manualFocusWeight?: number;
  /** Optional explicit-focus ceiling; omitted keeps the historical 1.25× policy. */
  manualFocusDetailBias?: number;
  motionWeight?: number;
};

export type RefinementInfluence = {
  gazeWeight: number;
  manualFocusWeight: number;
  motionWeight: number;
  combinedWeight: number;
  detailBias: number;
  rawScreenSpaceError: number;
  effectiveScreenSpaceError: number;
  /** True when an invalid or out-of-range input was safely bounded. */
  wasClamped: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function boundedWeight(value: number | undefined): { value: number; wasClamped: boolean } {
  if (value === undefined) {
    return { value: 0, wasClamped: false };
  }
  if (!Number.isFinite(value)) {
    return { value: 0, wasClamped: true };
  }

  const bounded = clamp(value, 0, 1);
  return { value: bounded, wasClamped: bounded !== value };
}

/**
 * Combine optional positive influences into one globally bounded pressure.
 *
 * Signals add into a shared [0, 1] envelope instead of multiplying one
 * another. This keeps future focus/motion inputs composable without allowing
 * an influence chain to make refinement priority unbounded.
 */
export function calculateRefinementInfluence(
  input: RefinementInfluenceInput,
): RefinementInfluence {
  const rawScreenSpaceError = Number.isFinite(input.rawScreenSpaceError)
    ? Math.max(input.rawScreenSpaceError, 0)
    : 0;
  const rawWasClamped = rawScreenSpaceError !== input.rawScreenSpaceError;
  const gaze = boundedWeight(input.gazeWeight);
  const manualFocus = boundedWeight(input.manualFocusWeight);
  const motion = boundedWeight(input.motionWeight);
  const combinedWeight = clamp(
    gaze.value + manualFocus.value + motion.value,
    0,
    1,
  );
  const manualFocusBias = input.manualFocusDetailBias;
  const hasManualFocusBias = manualFocusBias !== undefined && Number.isFinite(manualFocusBias);
  const focusBiasWasClamped = manualFocusBias !== undefined
    && (!Number.isFinite(manualFocusBias)
      || manualFocusBias < 1
      || manualFocusBias > MAX_REFINEMENT_FOCUS_DETAIL_BIAS);
  const boundedManualFocusBias = hasManualFocusBias
    ? clamp(manualFocusBias, 1, MAX_REFINEMENT_FOCUS_DETAIL_BIAS)
    : DEFAULT_MAX_REFINEMENT_DETAIL_BIAS;
  const detailBias = hasManualFocusBias
    ? clamp(
      1
        + gaze.value * (DEFAULT_MAX_REFINEMENT_DETAIL_BIAS - 1)
        + manualFocus.value * (boundedManualFocusBias - 1)
        + motion.value * (DEFAULT_MAX_REFINEMENT_DETAIL_BIAS - 1),
      1,
      Math.max(DEFAULT_MAX_REFINEMENT_DETAIL_BIAS, boundedManualFocusBias),
    )
    : 1 + combinedWeight * (DEFAULT_MAX_REFINEMENT_DETAIL_BIAS - 1);
  const multipliedScreenSpaceError = rawScreenSpaceError * detailBias;
  const effectiveScreenSpaceError = Number.isFinite(multipliedScreenSpaceError)
    ? multipliedScreenSpaceError
    : Number.MAX_VALUE;

  return {
    gazeWeight: gaze.value,
    manualFocusWeight: manualFocus.value,
    motionWeight: motion.value,
    combinedWeight,
    detailBias,
    rawScreenSpaceError,
    effectiveScreenSpaceError,
    wasClamped: rawWasClamped
      || gaze.wasClamped
      || manualFocus.wasClamped
      || focusBiasWasClamped
      || motion.wasClamped
      || !Number.isFinite(multipliedScreenSpaceError)
      || combinedWeight < gaze.value + manualFocus.value + motion.value,
  };
}
