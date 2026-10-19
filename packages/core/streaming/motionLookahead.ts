import type { ViewFrustum, ViewVector3 } from './view';

/** Fixed camera-orientation prediction horizon used by refinement, in milliseconds. */
export const MOTION_LOOKAHEAD_HORIZON_MS = 200;
/** Motion weight reaches exactly zero this long after the last accepted movement sample. */
export const MOTION_LOOKAHEAD_DECAY_MS = 600;

const MIN_SAMPLE_INTERVAL_MS = 4;
const MAX_SAMPLE_GAP_MS = 2_000;
const SMOOTHING_TIME_CONSTANT_MS = 55;
const MIN_ANGULAR_SPEED_RADIANS_PER_SECOND = (0.75 * Math.PI) / 180;
const MAX_ANGULAR_SPEED_RADIANS_PER_SECOND = (90 * Math.PI) / 180;
const ACTIVITY_FULL_SPEED_RADIANS_PER_SECOND = (30 * Math.PI) / 180;
const MAX_PREDICTED_COMPONENT_RADIANS = (18 * Math.PI) / 180;
const MEANINGFUL_DISPLACEMENT_CHANGE_RADIANS = (0.25 * Math.PI) / 180;

type CameraBasis = {
  position: ViewVector3;
  direction: ViewVector3;
  right: ViewVector3;
  up: ViewVector3;
};

/** Normalized renderer-neutral camera motion prediction for the current view. */
export type CameraMotionPrediction = {
  /** Whether the owning layer enabled camera motion lookahead. */
  enabled: boolean;
  /** Smoothed horizontal camera angular velocity, positive toward screen-right, in degrees/second. */
  horizontalAngularVelocityDegreesPerSecond: number;
  /** Smoothed vertical camera angular velocity, positive toward screen-up, in degrees/second. */
  verticalAngularVelocityDegreesPerSecond: number;
  /** Fixed lookahead duration, in milliseconds. */
  horizonMilliseconds: number;
  /** Predicted camera viewing-direction shift toward screen-right, in degrees. */
  predictedHorizontalDisplacementDegrees: number;
  /** Predicted camera viewing-direction shift toward screen-up, in degrees. */
  predictedVerticalDisplacementDegrees: number;
  /** Bounded motion confidence used to scale node relevance, in [0, 1]. */
  activity: number;
};

/** Result of accepting or rejecting one camera view observation. */
export type CameraMotionObservation = {
  /** False when the timestamp or camera basis was invalid or unusable. */
  valid: boolean;
  /** True when this sample contained meaningful angular movement. */
  sampledMovement: boolean;
  /** True when the predicted priority field changed enough to warrant reselection. */
  priorityChanged: boolean;
  /** Detached bounded prediction after this observation. */
  prediction: CameraMotionPrediction;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteVector(vector: ViewVector3 | undefined): vector is ViewVector3 {
  return vector !== undefined
    && Number.isFinite(vector.x)
    && Number.isFinite(vector.y)
    && Number.isFinite(vector.z);
}

function dot(left: ViewVector3, right: ViewVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function normalize(vector: ViewVector3): ViewVector3 | undefined {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 1e-9) {
    return undefined;
  }
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function normalizeBasis(frustum: ViewFrustum | undefined): CameraBasis | undefined {
  if (!frustum
    || !isFiniteVector(frustum.position)
    || !isFiniteVector(frustum.direction)
    || !isFiniteVector(frustum.right)
    || !isFiniteVector(frustum.up)) {
    return undefined;
  }

  const direction = normalize(frustum.direction);
  const right = normalize(frustum.right);
  const up = normalize(frustum.up);
  if (!direction || !right || !up
    || Math.abs(dot(direction, right)) > 0.1
    || Math.abs(dot(direction, up)) > 0.1
    || Math.abs(dot(right, up)) > 0.1) {
    return undefined;
  }

  return {
    position: frustum.position,
    direction,
    right,
    up,
  };
}

function predictionChanged(
  previous: CameraMotionPrediction,
  next: CameraMotionPrediction,
): boolean {
  const horizontalDelta = next.predictedHorizontalDisplacementDegrees
    - previous.predictedHorizontalDisplacementDegrees;
  const verticalDelta = next.predictedVerticalDisplacementDegrees
    - previous.predictedVerticalDisplacementDegrees;
  return Math.hypot(horizontalDelta, verticalDelta)
      >= MEANINGFUL_DISPLACEMENT_CHANGE_RADIANS * (180 / Math.PI)
    || (previous.activity > 0 && next.activity === 0);
}

/**
 * Estimate short-horizon camera rotation from bounded renderer-neutral snapshots.
 *
 * The estimator stores one basis, one timestamp, two filtered angular speeds,
 * and the latest movement time. Pass an explicit timestamp to `observe()` and
 * `getPrediction()` for deterministic tests or a monotonic clock in production.
 */
export class CameraMotionLookaheadEstimator {
  private readonly enabled: boolean;
  private previousBasis?: CameraBasis;
  private previousTimestamp?: number;
  private lastMovementTimestamp?: number;
  private horizontalVelocity = 0;
  private verticalVelocity = 0;
  private lastReportedPrediction: CameraMotionPrediction;

  /** Create an estimator with one fixed enable/disable policy. */
  constructor(enabled = true) {
    this.enabled = enabled;
    this.lastReportedPrediction = this.zeroPrediction();
  }

  /** Observe a perspective camera basis at a monotonic timestamp in milliseconds. */
  observe(
    frustum: ViewFrustum | undefined,
    timestampMilliseconds: number,
  ): CameraMotionObservation {
    const invalid = (): CameraMotionObservation => ({
      valid: false,
      sampledMovement: false,
      priorityChanged: false,
      prediction: this.getPrediction(timestampMilliseconds),
    });
    if (!this.enabled || !Number.isFinite(timestampMilliseconds) || timestampMilliseconds < 0) {
      return invalid();
    }

    const basis = normalizeBasis(frustum);
    if (!basis) {
      return invalid();
    }

    if (!this.previousBasis || this.previousTimestamp === undefined) {
      this.previousBasis = basis;
      this.previousTimestamp = timestampMilliseconds;
      const prediction = this.getPrediction(timestampMilliseconds);
      this.lastReportedPrediction = prediction;
      return { valid: true, sampledMovement: false, priorityChanged: false, prediction };
    }

    const intervalMilliseconds = timestampMilliseconds - this.previousTimestamp;
    if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds <= 0) {
      return invalid();
    }
    if (intervalMilliseconds < MIN_SAMPLE_INTERVAL_MS) {
      return invalid();
    }

    const cosine = clamp(dot(this.previousBasis.direction, basis.direction), -1, 1);
    // Project the old viewing ray onto the current screen axes. The negative
    // sign converts old-ray displacement into the direction the camera moved.
    const horizontalDelta = Math.atan2(
      -dot(this.previousBasis.direction, basis.right),
      cosine,
    );
    const verticalDelta = Math.atan2(
      -dot(this.previousBasis.direction, basis.up),
      cosine,
    );
    this.previousBasis = basis;
    this.previousTimestamp = timestampMilliseconds;

    // A large gap can mean the camera was stationary and only emitted a new
    // event when it moved again. Use a bounded interval for the new direction
    // change instead of discarding that first movement sample or deriving an
    // arbitrarily small velocity from a long idle period.
    const sampleIntervalMilliseconds = Math.min(intervalMilliseconds, MAX_SAMPLE_GAP_MS);
    const seconds = sampleIntervalMilliseconds / 1000;
    const rawHorizontalVelocity = horizontalDelta / seconds;
    const rawVerticalVelocity = verticalDelta / seconds;
    const rawSpeed = Math.hypot(rawHorizontalVelocity, rawVerticalVelocity);
    let sampledMovement = false;

    if (Number.isFinite(rawSpeed)
      && rawSpeed >= MIN_ANGULAR_SPEED_RADIANS_PER_SECOND) {
      const scale = rawSpeed > MAX_ANGULAR_SPEED_RADIANS_PER_SECOND
        ? MAX_ANGULAR_SPEED_RADIANS_PER_SECOND / rawSpeed
        : 1;
      const horizontal = rawHorizontalVelocity * scale;
      const vertical = rawVerticalVelocity * scale;
      const previousSpeed = Math.hypot(this.horizontalVelocity, this.verticalVelocity);
      const reversed = previousSpeed > 0
        && this.horizontalVelocity * horizontal + this.verticalVelocity * vertical < 0;
      const alpha = 1 - Math.exp(-sampleIntervalMilliseconds / SMOOTHING_TIME_CONSTANT_MS);
      if (reversed) {
        // Drop stale directional momentum immediately; filtering same-direction
        // samples still smooths ordinary event jitter.
        this.horizontalVelocity = horizontal;
        this.verticalVelocity = vertical;
      } else {
        this.horizontalVelocity += (horizontal - this.horizontalVelocity) * alpha;
        this.verticalVelocity += (vertical - this.verticalVelocity) * alpha;
      }
      this.lastMovementTimestamp = timestampMilliseconds;
      sampledMovement = true;
    }

    const prediction = this.getPrediction(timestampMilliseconds);
    const priorityChanged = predictionChanged(this.lastReportedPrediction, prediction);
    this.lastReportedPrediction = prediction;
    return { valid: true, sampledMovement, priorityChanged, prediction };
  }

  /** Return the exponentially decayed prediction without changing sample history. */
  getPrediction(timestampMilliseconds: number): CameraMotionPrediction {
    if (!this.enabled
      || !Number.isFinite(timestampMilliseconds)
      || timestampMilliseconds < 0
      || this.lastMovementTimestamp === undefined) {
      return this.zeroPrediction();
    }

    const elapsedMilliseconds = timestampMilliseconds - this.lastMovementTimestamp;
    if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0
      || elapsedMilliseconds >= MOTION_LOOKAHEAD_DECAY_MS) {
      return this.zeroPrediction();
    }

    const decay = Math.exp(-elapsedMilliseconds / 180);
    const horizontalVelocity = this.horizontalVelocity * decay;
    const verticalVelocity = this.verticalVelocity * decay;
    const speed = Math.hypot(horizontalVelocity, verticalVelocity);
    const horizonSeconds = MOTION_LOOKAHEAD_HORIZON_MS / 1000;
    const horizontalDisplacement = clamp(
      horizontalVelocity * horizonSeconds,
      -MAX_PREDICTED_COMPONENT_RADIANS,
      MAX_PREDICTED_COMPONENT_RADIANS,
    );
    const verticalDisplacement = clamp(
      verticalVelocity * horizonSeconds,
      -MAX_PREDICTED_COMPONENT_RADIANS,
      MAX_PREDICTED_COMPONENT_RADIANS,
    );

    return {
      enabled: true,
      horizontalAngularVelocityDegreesPerSecond: horizontalVelocity * (180 / Math.PI),
      verticalAngularVelocityDegreesPerSecond: verticalVelocity * (180 / Math.PI),
      horizonMilliseconds: MOTION_LOOKAHEAD_HORIZON_MS,
      predictedHorizontalDisplacementDegrees: horizontalDisplacement * (180 / Math.PI),
      predictedVerticalDisplacementDegrees: verticalDisplacement * (180 / Math.PI),
      activity: clamp(speed / ACTIVITY_FULL_SPEED_RADIANS_PER_SECOND, 0, 1),
    };
  }

  /** Clear all bounded camera history and predicted motion. */
  reset(): void {
    this.previousBasis = undefined;
    this.previousTimestamp = undefined;
    this.lastMovementTimestamp = undefined;
    this.horizontalVelocity = 0;
    this.verticalVelocity = 0;
    this.lastReportedPrediction = this.zeroPrediction();
  }

  private zeroPrediction(): CameraMotionPrediction {
    return {
      enabled: this.enabled,
      horizontalAngularVelocityDegreesPerSecond: 0,
      verticalAngularVelocityDegreesPerSecond: 0,
      horizonMilliseconds: MOTION_LOOKAHEAD_HORIZON_MS,
      predictedHorizontalDisplacementDegrees: 0,
      predictedVerticalDisplacementDegrees: 0,
      activity: 0,
    };
  }
}
