import type { ViewFrustum, ViewVector3 } from "./view";

/** Fixed camera-orientation prediction horizon used by refinement, in milliseconds. */
export const MOTION_LOOKAHEAD_HORIZON_MS = 200;
/** Motion weight reaches exactly zero this long after the last accepted movement sample. */
export const MOTION_LOOKAHEAD_DECAY_MS = 600;
/** A recently accepted sample marks motion as active before the decay phase. */
const MOTION_LOOKAHEAD_ACTIVE_WINDOW_MS = 100;

const MIN_SAMPLE_INTERVAL_MS = 4;
const MAX_SAMPLE_GAP_MS = 2_000;
const POST_IDLE_SAMPLE_INTERVAL_MS = 1000 / 60;
const SMOOTHING_TIME_CONSTANT_MS = 55;
const MIN_ANGULAR_SPEED_RADIANS_PER_SECOND = (0.75 * Math.PI) / 180;
const MIN_ANGULAR_DISPLACEMENT_RADIANS = (0.05 * Math.PI) / 180;
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

/** Current estimator state for bounded runtime diagnostics. */
export type CameraMotionLiveDiagnostics = CameraMotionPrediction & {
  /** Active while samples arrive, decaying during the 600 ms settle window, then stationary. */
  state: "disabled" | "active" | "decaying" | "stationary";
  /** Time since the last accepted movement sample; absent before the first accepted sample. */
  millisecondsSinceLastAcceptedMovement?: number;
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

function isFiniteVector(
  vector: ViewVector3 | undefined,
): vector is ViewVector3 {
  return (
    vector !== undefined &&
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
  );
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

function normalizeBasis(
  frustum: ViewFrustum | undefined,
): CameraBasis | undefined {
  if (
    !frustum ||
    !isFiniteVector(frustum.position) ||
    !isFiniteVector(frustum.direction) ||
    !isFiniteVector(frustum.right) ||
    !isFiniteVector(frustum.up)
  ) {
    return undefined;
  }

  const direction = normalize(frustum.direction);
  const right = normalize(frustum.right);
  const up = normalize(frustum.up);
  if (
    !direction ||
    !right ||
    !up ||
    Math.abs(dot(direction, right)) > 0.1 ||
    Math.abs(dot(direction, up)) > 0.1 ||
    Math.abs(dot(right, up)) > 0.1
  ) {
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
  const horizontalDelta =
    next.predictedHorizontalDisplacementDegrees -
    previous.predictedHorizontalDisplacementDegrees;
  const verticalDelta =
    next.predictedVerticalDisplacementDegrees -
    previous.predictedVerticalDisplacementDegrees;
  return (
    Math.hypot(horizontalDelta, verticalDelta) >=
      MEANINGFUL_DISPLACEMENT_CHANGE_RADIANS * (180 / Math.PI) ||
    (previous.activity > 0 && next.activity === 0)
  );
}

/**
 * Estimate short-horizon camera rotation from bounded renderer-neutral snapshots.
 *
 * The estimator stores one basis, one timestamp, two filtered angular speeds,
 * a bounded pending angular delta, and the latest movement time. Sub-threshold
 * deltas accumulate until meaningful, while an idle gap starts a fresh sample
 * so idle time cannot dilute its velocity. Pass explicit timestamps to
 * `observe()` and `getPrediction()` for deterministic tests or a monotonic clock
 * in production.
 */
export class CameraMotionLookaheadEstimator {
  private readonly enabled: boolean;
  private previousBasis?: CameraBasis;
  private previousTimestamp?: number;
  private lastMovementTimestamp?: number;
  private horizontalVelocity = 0;
  private verticalVelocity = 0;
  private pendingHorizontalDelta = 0;
  private pendingVerticalDelta = 0;
  private pendingIntervalMilliseconds = 0;
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
    if (
      !this.enabled ||
      !Number.isFinite(timestampMilliseconds) ||
      timestampMilliseconds < 0
    ) {
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
      return {
        valid: true,
        sampledMovement: false,
        priorityChanged: false,
        prediction,
      };
    }

    const intervalMilliseconds = timestampMilliseconds - this.previousTimestamp;
    if (!Number.isFinite(intervalMilliseconds) || intervalMilliseconds <= 0) {
      return invalid();
    }

    const timeSinceLastMovement =
      timestampMilliseconds -
      (this.lastMovementTimestamp ?? this.previousTimestamp);
    const resumedAfterIdle = timeSinceLastMovement >= MOTION_LOOKAHEAD_DECAY_MS;
    const hadRecentMovement =
      this.lastMovementTimestamp !== undefined && !resumedAfterIdle;
    if (resumedAfterIdle) {
      // A camera may emit no events while still. Expire directional state on
      // the first later observation and avoid carrying tiny deltas across rest.
      this.horizontalVelocity = 0;
      this.verticalVelocity = 0;
      this.clearPendingDelta();
    }

    const cosine = clamp(
      dot(this.previousBasis.direction, basis.direction),
      -1,
      1,
    );
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

    // Keep tiny but positive event intervals. Renderer callbacks can arrive
    // within the same frame (for example, a programmatic pitch followed by a
    // heading change); dropping them can lose the final orientation entirely.
    // A minimum interval bounds apparent velocity, while the angular
    // displacement threshold below still rejects sub-pixel camera jitter.
    // After a quiet period the observation only tells us that the camera moved,
    // not how long the movement took. Treat it as one representative 60 Hz
    // camera event instead of spreading the rotation over the idle interval.
    const sampleIntervalMilliseconds = resumedAfterIdle
      ? POST_IDLE_SAMPLE_INTERVAL_MS
      : clamp(intervalMilliseconds, MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_GAP_MS);
    const pendingDirectionDot =
      this.pendingHorizontalDelta * horizontalDelta +
      this.pendingVerticalDelta * verticalDelta;
    if (pendingDirectionDot < 0) {
      // Drop an unfinished direction as soon as the camera reverses, before
      // micro-deltas have crossed the accumulation threshold.
      this.clearPendingDelta();
    }
    this.pendingHorizontalDelta += horizontalDelta;
    this.pendingVerticalDelta += verticalDelta;
    this.pendingIntervalMilliseconds = Math.min(
      this.pendingIntervalMilliseconds + sampleIntervalMilliseconds,
      MAX_SAMPLE_GAP_MS,
    );

    const angularDisplacement = Math.hypot(
      this.pendingHorizontalDelta,
      this.pendingVerticalDelta,
    );
    const accumulatedSeconds = this.pendingIntervalMilliseconds / 1000;
    const rawHorizontalVelocity =
      this.pendingHorizontalDelta / accumulatedSeconds;
    const rawVerticalVelocity = this.pendingVerticalDelta / accumulatedSeconds;
    const rawSpeed = Math.hypot(rawHorizontalVelocity, rawVerticalVelocity);
    let sampledMovement = false;

    if (angularDisplacement >= MIN_ANGULAR_DISPLACEMENT_RADIANS) {
      if (
        Number.isFinite(rawSpeed) &&
        rawSpeed >= MIN_ANGULAR_SPEED_RADIANS_PER_SECOND
      ) {
        const scale =
          rawSpeed > MAX_ANGULAR_SPEED_RADIANS_PER_SECOND
            ? MAX_ANGULAR_SPEED_RADIANS_PER_SECOND / rawSpeed
            : 1;
        const horizontal = rawHorizontalVelocity * scale;
        const vertical = rawVerticalVelocity * scale;
        const previousSpeed = Math.hypot(
          this.horizontalVelocity,
          this.verticalVelocity,
        );
        const reversed =
          previousSpeed > 0 &&
          this.horizontalVelocity * horizontal +
            this.verticalVelocity * vertical <
            0;
        const alpha =
          1 -
          Math.exp(
            -this.pendingIntervalMilliseconds / SMOOTHING_TIME_CONSTANT_MS,
          );
        if (reversed || !hadRecentMovement) {
          // Drop stale directional momentum immediately; filtering same-direction
          // samples still smooths ordinary event jitter. The first movement after
          // rest starts from its measured velocity rather than a stale EMA value.
          this.horizontalVelocity = horizontal;
          this.verticalVelocity = vertical;
        } else {
          this.horizontalVelocity +=
            (horizontal - this.horizontalVelocity) * alpha;
          this.verticalVelocity += (vertical - this.verticalVelocity) * alpha;
        }
        this.lastMovementTimestamp = timestampMilliseconds;
        sampledMovement = true;
        this.clearPendingDelta();
      } else {
        // A completed tiny vector below the minimum angular speed is jitter,
        // rather than motion to accumulate indefinitely.
        this.clearPendingDelta();
      }
    }

    const prediction = this.getPrediction(timestampMilliseconds);
    const priorityChanged = predictionChanged(
      this.lastReportedPrediction,
      prediction,
    );
    this.lastReportedPrediction = prediction;
    return { valid: true, sampledMovement, priorityChanged, prediction };
  }

  /** Return the exponentially decayed prediction without changing sample history. */
  getPrediction(timestampMilliseconds: number): CameraMotionPrediction {
    if (
      !this.enabled ||
      !Number.isFinite(timestampMilliseconds) ||
      timestampMilliseconds < 0 ||
      this.lastMovementTimestamp === undefined
    ) {
      return this.zeroPrediction();
    }

    const elapsedMilliseconds =
      timestampMilliseconds - this.lastMovementTimestamp;
    if (
      !Number.isFinite(elapsedMilliseconds) ||
      elapsedMilliseconds < 0 ||
      elapsedMilliseconds >= MOTION_LOOKAHEAD_DECAY_MS
    ) {
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
      horizontalAngularVelocityDegreesPerSecond:
        horizontalVelocity * (180 / Math.PI),
      verticalAngularVelocityDegreesPerSecond:
        verticalVelocity * (180 / Math.PI),
      horizonMilliseconds: MOTION_LOOKAHEAD_HORIZON_MS,
      predictedHorizontalDisplacementDegrees:
        horizontalDisplacement * (180 / Math.PI),
      predictedVerticalDisplacementDegrees:
        verticalDisplacement * (180 / Math.PI),
      activity: clamp(speed / ACTIVITY_FULL_SPEED_RADIANS_PER_SECOND, 0, 1),
    };
  }

  /** Return the current decayed prediction and bounded activity state. */
  getDiagnostics(timestampMilliseconds: number): CameraMotionLiveDiagnostics {
    const prediction = this.getPrediction(timestampMilliseconds);
    const rawAge =
      timestampMilliseconds -
      (this.lastMovementTimestamp ?? timestampMilliseconds);
    const age =
      this.lastMovementTimestamp !== undefined &&
      Number.isFinite(rawAge) &&
      rawAge >= 0
        ? rawAge
        : undefined;
    const state = !this.enabled
      ? "disabled"
      : age === undefined || age >= MOTION_LOOKAHEAD_DECAY_MS
        ? "stationary"
        : age <= MOTION_LOOKAHEAD_ACTIVE_WINDOW_MS
          ? "active"
          : "decaying";

    return {
      ...prediction,
      state,
      ...(age === undefined
        ? {}
        : { millisecondsSinceLastAcceptedMovement: age }),
    };
  }

  /** Clear all bounded camera history and predicted motion. */
  reset(): void {
    this.previousBasis = undefined;
    this.previousTimestamp = undefined;
    this.lastMovementTimestamp = undefined;
    this.horizontalVelocity = 0;
    this.verticalVelocity = 0;
    this.clearPendingDelta();
    this.lastReportedPrediction = this.zeroPrediction();
  }

  private clearPendingDelta(): void {
    this.pendingHorizontalDelta = 0;
    this.pendingVerticalDelta = 0;
    this.pendingIntervalMilliseconds = 0;
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
