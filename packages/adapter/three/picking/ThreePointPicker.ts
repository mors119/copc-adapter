import * as THREE from "three";
import type {
  CopcPointInspection,
  CopcPointPickId,
} from "../../core/copc/points/pointInspection";
import { isCopcPointPickId } from "../../core/copc/points/pointInspection";
import type {
  CopcThreeLayerPickOptions,
  CopcThreeLayerPickPosition,
} from "../layer/types";

type ThreePointPickerOptions = {
  getRoot: () => THREE.Group;
  inspectPoint: (pickId: CopcPointPickId) => CopcPointInspection | undefined;
  hasNode: (nodeKey: string) => boolean;
  getLoadGeneration: () => number;
  pickingThreshold?: number;
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
};

function isPickOptions(value: unknown): value is CopcThreeLayerPickOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    ("raycaster" in value || "threshold" in value)
  );
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-three-layer-${nextPickOwnerId}`;
}

/** Owns Three.js point hit testing and the selected point's live cache identity. */
export class ThreePointPicker {
  /** Identity attached to rendered point IDs so ray hits from other layers are ignored. */
  readonly ownerId = createPickOwnerId();

  private selectedPointPickId?: CopcPointPickId;
  private selectedPointLoadGeneration = 0;
  private readonly options: ThreePointPickerOptions;

  constructor(options: ThreePointPickerOptions) {
    this.options = options;
  }

  /** Return the selected point while its node and decoded buffer remain live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    if (
      !pickId ||
      this.selectedPointLoadGeneration !== this.options.getLoadGeneration()
    ) {
      if (pickId) {
        this.clear();
      }
      return undefined;
    }

    const inspection = this.options.hasNode(pickId.nodeKey)
      ? this.options.inspectPoint(pickId)
      : undefined;
    if (!inspection) {
      this.clear();
    }
    return inspection;
  }

  /** Raycast against this layer's root and resolve the first live owned hit. */
  pick(
    position: CopcThreeLayerPickPosition,
    camera: THREE.Camera,
    raycasterOrOptions?: THREE.Raycaster | CopcThreeLayerPickOptions,
  ): CopcPointInspection | undefined {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      this.clear();
      return undefined;
    }

    const options = isPickOptions(raycasterOrOptions)
      ? raycasterOrOptions
      : undefined;
    const raycaster =
      options?.raycaster ??
      (raycasterOrOptions && !isPickOptions(raycasterOrOptions)
        ? raycasterOrOptions
        : new THREE.Raycaster());
    const threshold = options?.threshold ?? this.options.pickingThreshold ?? 1;
    if (!isFinitePositive(threshold)) {
      throw new Error(
        "CopcThreeLayer pick threshold must be a positive finite number",
      );
    }

    raycaster.params.Points.threshold = threshold;
    raycaster.setFromCamera(new THREE.Vector2(position.x, position.y), camera);
    const intersections = raycaster.intersectObject(
      this.options.getRoot(),
      true,
    );
    for (const intersection of intersections) {
      const pointObject = this.getOwnedPointObject(intersection.object);
      const pointIndex = intersection.index;
      if (
        !pointObject ||
        pointIndex === undefined ||
        !Number.isSafeInteger(pointIndex) ||
        pointIndex < 0
      ) {
        continue;
      }

      const pointIdFactory = pointObject.userData.copcPointId;
      const pickId =
        typeof pointIdFactory === "function"
          ? pointIdFactory(pointIndex)
          : undefined;
      if (!this.isOwnedPickId(pickId)) {
        continue;
      }

      const inspection = this.options.inspectPoint(pickId);
      if (!inspection || !this.options.hasNode(pickId.nodeKey)) {
        continue;
      }

      this.selectedPointPickId = {
        nodeKey: pickId.nodeKey,
        pointIndex: pickId.pointIndex,
        ownerId: pickId.ownerId,
      };
      this.selectedPointLoadGeneration = this.options.getLoadGeneration();
      this.options.onPointPicked?.(inspection);
      return inspection;
    }

    this.clear();
    return undefined;
  }

  /** Return the selected identifier for style and node-removal coordination. */
  getSelectedPickId(): CopcPointPickId | undefined {
    return this.selectedPointPickId;
  }

  /** Clear selection when its rendered node is removed. */
  clearIfNode(nodeKey: string): void {
    if (this.selectedPointPickId?.nodeKey === nodeKey) {
      this.clear();
    }
  }

  /** Clear the selected point and report the lifecycle change once. */
  clear(): void {
    if (!this.selectedPointPickId) {
      return;
    }
    this.selectedPointPickId = undefined;
    this.selectedPointLoadGeneration = 0;
    this.options.onPointPicked?.(undefined);
  }

  private isOwnedPickId(value: unknown): value is CopcPointPickId {
    return isCopcPointPickId(value) && value.ownerId === this.ownerId;
  }

  private getOwnedPointObject(
    object: THREE.Object3D,
  ): THREE.Object3D | undefined {
    const root = this.options.getRoot();
    let candidate: THREE.Object3D | null = object;
    while (candidate && candidate.parent && candidate.parent !== root) {
      candidate = candidate.parent;
    }
    if (!candidate || candidate.parent !== root) {
      return undefined;
    }
    const nodeKey = candidate.userData.copcNodeKey;
    return typeof nodeKey === "string" && this.options.hasNode(nodeKey)
      ? candidate
      : undefined;
  }
}
