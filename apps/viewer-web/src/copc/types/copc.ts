export type CopcHierarchyNode = {
  key: string;
  level: number;
  x: number;
  y: number;
  z: number;
  pointCount: number;
  pointDataOffset: number;
  pointDataLength: number;
};

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
};

export type CopcPoint = {
  x: number;
  y: number;
  z: number;
};

export type CopcPointView = {
  pointCount: number;
  getter(name: string): (index: number) => number;
};
