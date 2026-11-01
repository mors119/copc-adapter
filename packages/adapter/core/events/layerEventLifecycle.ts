import type { CopcMetadata } from "../copc/types/copc";

/** Why the current view's asynchronous streaming work was invalidated. */
export type CopcViewCancellationReason =
  /** A newer camera state replaced the active view. */
  | "camera-change"
  /** A runtime focus-lens change replaced the active selection. */
  | "focus-change"
  /** The layer was detached from its viewer or scene. */
  | "detach"
  /** Loaded data was released. */
  | "unload"
  /** The configured source is being loaded again. */
  | "reload"
  /** The layer and its owned resources were permanently released. */
  | "destroy";

/** Identifier and cause for one cancelled public view generation. */
export type CopcActiveViewCancellation = {
  /** Monotonically increasing identifier assigned to the view. */
  viewGeneration: number;
  /** Lifecycle change that invalidated the view. */
  reason: CopcViewCancellationReason;
};

/** Tracks public view generations independently from core and adapter tokens. */
export class CopcLayerEventLifecycle {
  private nextViewGeneration = 0;
  private activeViewGeneration?: number;

  beginView(): {
    viewGeneration: number;
    superseded?: CopcActiveViewCancellation;
  } {
    const superseded = this.cancelView("camera-change");
    const viewGeneration = ++this.nextViewGeneration;
    this.activeViewGeneration = viewGeneration;
    return {
      viewGeneration,
      ...(superseded ? { superseded } : {}),
    };
  }

  cancelView(
    reason: CopcViewCancellationReason,
  ): CopcActiveViewCancellation | undefined {
    const viewGeneration = this.activeViewGeneration;
    if (viewGeneration === undefined) {
      return undefined;
    }

    this.activeViewGeneration = undefined;
    return { viewGeneration, reason };
  }

  settleView(viewGeneration: number): boolean {
    return this.finishView(viewGeneration);
  }

  failView(viewGeneration: number): boolean {
    return this.finishView(viewGeneration);
  }

  isActiveView(viewGeneration: number): boolean {
    return this.activeViewGeneration === viewGeneration;
  }

  private finishView(viewGeneration: number): boolean {
    if (this.activeViewGeneration !== viewGeneration) {
      return false;
    }

    this.activeViewGeneration = undefined;
    return true;
  }
}

/** Structured error payload for a layer load or background view update. */
export type CopcLayerErrorEvent = {
  /** Error snapshot; may be a non-Error value thrown by a dependency. */
  error: unknown;
  /** Whether the failure occurred while loading the source or updating a view. */
  phase: "load" | "view";
  /** Load attempt, when the failure belongs to a load operation. */
  loadGeneration?: number;
  /** View generation, when the failure belongs to a streaming update. */
  viewGeneration?: number;
};

/** Defensive immutable metadata snapshot for public lifecycle notifications. */
export function snapshotCopcMetadata(metadata: CopcMetadata): CopcMetadata {
  return Object.freeze({
    ...metadata,
    bounds: Object.freeze({ ...metadata.bounds }),
    cube: Object.freeze({ ...metadata.cube }),
    ...(metadata.scale ? { scale: Object.freeze({ ...metadata.scale }) } : {}),
    ...(metadata.offset
      ? { offset: Object.freeze({ ...metadata.offset }) }
      : {}),
    ...(metadata.extraDimensions
      ? {
          extraDimensions: Object.freeze(
            metadata.extraDimensions.map((dimension) =>
              Object.freeze({ ...dimension }),
            ),
          ),
        }
      : {}),
    ...(metadata.crsDiagnostic
      ? {
          crsDiagnostic: Object.freeze({
            ...metadata.crsDiagnostic,
            wkt: Object.freeze({ ...metadata.crsDiagnostic.wkt }),
            horizontal: Object.freeze({
              ...metadata.crsDiagnostic.horizontal,
              ...(metadata.crsDiagnostic.horizontal.identity
                ? { identity: Object.freeze({ ...metadata.crsDiagnostic.horizontal.identity }) }
                : {}),
              axisOrder: Object.freeze({ ...metadata.crsDiagnostic.horizontal.axisOrder }),
              units: Object.freeze({ ...metadata.crsDiagnostic.horizontal.units }),
            }),
            vertical: Object.freeze({
              ...metadata.crsDiagnostic.vertical,
              ...(metadata.crsDiagnostic.vertical.identity
                ? { identity: Object.freeze({ ...metadata.crsDiagnostic.vertical.identity }) }
                : {}),
              units: Object.freeze({ ...metadata.crsDiagnostic.vertical.units }),
              heightKind: Object.freeze({ ...metadata.crsDiagnostic.vertical.heightKind }),
            }),
            evidence: Object.freeze(metadata.crsDiagnostic.evidence.map((item) => Object.freeze({ ...item }))),
            reasons: Object.freeze(metadata.crsDiagnostic.reasons.map((item) => Object.freeze({ ...item }))),
          }),
        }
      : {}),
    ...(metadata.crsWktProvenance
      ? {
          crsWktProvenance: Object.freeze({
            ...metadata.crsWktProvenance,
            available: Object.freeze([...metadata.crsWktProvenance.available]),
          }),
        }
      : {}),
  });
}

/** Preserve an Error's prototype and cause chain without sharing mutable Error objects. */
export function snapshotCopcError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const descriptors = Object.getOwnPropertyDescriptors(error);
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const snapshot = new DOMException(error.message, error.name);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "stack" || key === "name" || key === "message") {
        continue;
      }
      if (key === "cause" && "value" in descriptor) {
        descriptor.value = snapshotCopcError(descriptor.value);
      }
      Object.defineProperty(snapshot, key, descriptor);
    }
    return Object.freeze(snapshot);
  }
  const cause = descriptors.cause;
  if (cause && "value" in cause) {
    cause.value = snapshotCopcError(cause.value);
  }
  const snapshot = Object.create(Object.getPrototypeOf(error)) as Error;
  Object.defineProperties(snapshot, descriptors);
  return Object.freeze(snapshot);
}

export function reportListenerError(error: unknown): void {
  try {
    console.error("COPC layer event listener failed", error);
  } catch {
    // A replaced console.error must not interrupt streaming lifecycle work.
  }
}
