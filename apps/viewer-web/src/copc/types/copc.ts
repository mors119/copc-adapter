export type {
  CopcHierarchyNode,
  CopcHierarchyPage,
  CopcHierarchyTree,
} from '../hierarchy/types';

export type CopcMetadata = {
  pointCount: number;
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  spacing?: number;
  scale?: {
    x: number;
    y: number;
    z: number;
  };
  offset?: {
    x: number;
    y: number;
    z: number;
  };
  cube: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
  wkt?: string;
};

export type CopcPoint = {
  x: number;
  y: number;
  z: number;
};

export type CopcPointAttributes = {
  intensity?: Uint16Array;
  classification?: Uint8Array;
  red?: Uint16Array;
  green?: Uint16Array;
  blue?: Uint16Array;
};

export type CopcPointBuffer = {
  pointCount: number;
  coordinates: Float64Array;
  attributes?: CopcPointAttributes;
};

export type GeographicPoint = {
  longitude: number;
  latitude: number;
  height: number;
};

export type GeographicCamera = GeographicPoint;

export type GeographicPointBuffer = {
  pointCount: number;
  coordinates: Float64Array;
  attributes?: CopcPointAttributes;
};

export type CopcPointView = {
  pointCount: number;
  getter(name: string): (index: number) => number;
};
