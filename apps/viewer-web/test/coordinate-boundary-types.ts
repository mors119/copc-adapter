import {
  intersectsViewFrustum,
} from '../src/index';
import type {
  CopcHierarchyQuery,
  ViewFrustum,
} from '../src/index';

const legacyHierarchyQuery: CopcHierarchyQuery = {
  bounds: {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 1,
    maxY: 1,
    maxZ: 1,
  },
};

const legacyBoundingSphere = {
  center: { x: 0, y: 0, z: 5 },
  radiusMeters: 1,
};

declare const frustum: ViewFrustum;
intersectsViewFrustum(frustum, legacyBoundingSphere);

void legacyHierarchyQuery;
