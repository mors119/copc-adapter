import type {
  CopcHierarchyNode,
  GeographicCamera,
  GeographicPoint,
  GeographicPointBuffer,
} from '../../copc/types/copc';

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
};

export type StreamingSelectionOptions = {
  maxNodes: number;
  maxDepth: number;
  refineDistanceMultiplier: number;
  maxRenderDistanceMeters: number;
};

export type StreamingHierarchyNode = {
  node: CopcHierarchyNode;
  children: string[];
  center: GeographicPoint;
  bounds: BoundingBox;
  approximateSizeMeters: number;
  boundingRadiusMeters: number;
};

export type StreamingHierarchy = Map<string, StreamingHierarchyNode>;

export type StreamingUpdateResult = {
  selectedNodeKeys: string[];
  removedNodeKeys: string[];
  loadedNodePoints: Map<string, GeographicPointBuffer>;
};
