import * as Cesium from 'cesium';
import type {
  CopcPointInspection,
  CopcPointPickId,
} from '../../core/copc/points/pointInspection';
import { isCopcPointPickId } from '../../core/copc/points/pointInspection';

type CesiumPointPickerOptions = {
  inspectPoint: (pickId: CopcPointPickId) => CopcPointInspection | undefined;
  hasNode: (nodeKey: string) => boolean;
  onPointPicked?: (point: CopcPointInspection | undefined) => void;
};

let nextPickOwnerId = 0;

function createPickOwnerId(): string {
  nextPickOwnerId += 1;
  return `copc-layer-${nextPickOwnerId}`;
}

/** Owns Cesium screen-space input and the selected point's live cache identity. */
export class CesiumPointPicker {
  /** Identity attached to rendered point IDs so clicks from other layers are ignored. */
  readonly ownerId = createPickOwnerId();

  private readonly options: CesiumPointPickerOptions;
  private selectedPointPickId?: CopcPointPickId;
  private handler?: Cesium.ScreenSpaceEventHandler;

  constructor(options: CesiumPointPickerOptions) {
    this.options = options;
  }

  /** Attach the layer's left-click picking handler to one Cesium Viewer. */
  attach(viewer: Cesium.Viewer): void {
    this.detachHandler();
    const canvas = viewer.scene.canvas;
    if (!canvas) {
      return;
    }

    this.handler = new Cesium.ScreenSpaceEventHandler(canvas);
    this.handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      this.pick(viewer, movement.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  /** Remove the handler without changing the selected point. */
  detach(): void {
    this.detachHandler();
  }

  /** Return the selected point while its node and decoded buffer remain live. */
  getSelectedPoint(): CopcPointInspection | undefined {
    const pickId = this.selectedPointPickId;
    if (!pickId) {
      return undefined;
    }
    if (!this.options.hasNode(pickId.nodeKey)) {
      this.clear();
      return undefined;
    }

    const inspection = this.options.inspectPoint(pickId);
    if (!inspection) {
      this.clear();
    }
    return inspection;
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
    this.options.onPointPicked?.(undefined);
  }

  /** @internal Process one screen-space hit; exposed for the layer's test seam. */
  pick(viewer: Cesium.Viewer, position: Cesium.Cartesian2): void {
    const picked = viewer.scene.pick(position) as { id?: unknown } | undefined;
    if (!picked || !isCopcPointPickId(picked.id)
      || picked.id.ownerId !== this.ownerId) {
      this.clear();
      return;
    }

    const pickId = picked.id;
    const inspection = this.options.inspectPoint(pickId);
    if (!inspection || !this.options.hasNode(pickId.nodeKey)) {
      this.clear();
      return;
    }

    this.selectedPointPickId = {
      nodeKey: pickId.nodeKey,
      pointIndex: pickId.pointIndex,
      ...(pickId.ownerId === undefined ? {} : { ownerId: pickId.ownerId }),
    };
    this.options.onPointPicked?.(inspection);
  }

  private detachHandler(): void {
    this.handler?.destroy();
    this.handler = undefined;
  }
}
