import type {
  CopcHierarchyNode,
  GeographicCamera,
  GeographicPoint,
  GeographicPointBuffer,
} from '../../copc/types/copc';
import type { BoundingSphere, ViewFrustum } from './view';

export type { BoundingSphere, ViewFrustum, ViewVector3 } from './view';

export type BoundingBox = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type StreamingCameraState = GeographicCamera & {
  viewDistanceMeters: number;
  viewFrustum?: ViewFrustum;
};

export type StreamingSelectionOptions = {
  maxNodes: number;
  maxDepth: number;
  refineDistanceMultiplier: number;
  maxRenderDistanceMeters: number;
  /** Internal release-safety bound; this is not a rendered-point API. */
  maxPointsPerBatch?: number;
};

export type StreamingHierarchyNode = {
  node: CopcHierarchyNode;
  children: string[];
  center: GeographicPoint;
  bounds: BoundingBox;
  approximateSizeMeters: number;
  boundingRadiusMeters: number;
  boundingSphere?: BoundingSphere;
};

export type StreamingSelectionMetrics = {
  candidatesBeforeCulling: number;
  frustumCulledCount: number;
};

export type StreamingLevelRange = {
  min: number;
  max: number;
};

export type StreamingHierarchy = Map<string, StreamingHierarchyNode>;

export type StreamingUpdateResult = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  loadedNodePoints: Map<string, GeographicPointBuffer>;
};

export type StreamingProgress = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  loadedNodePoints: Map<string, GeographicPointBuffer>;
  completedBatchPointCount: number;
};
