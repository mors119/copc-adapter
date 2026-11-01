import { createExperimentalETilePointView } from '../../src/input/tilePointView.js';
import type {
  TileConservativeBoundsResult,
  TileConservativeNodeSource,
  TileHierarchyNode,
  TileHierarchyPage,
} from '../../src/source/tileNodeSource.js';

const sourceIdentity = 'browser-fixture-source';
const transformGeneration = 1;

const nodes: readonly TileHierarchyNode[] = Object.freeze([
  Object.freeze({
    key: 'root', level: 0, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 100, pointDataLength: 72,
    children: Object.freeze(['left']), childrenComplete: true,
  }),
  Object.freeze({
    key: 'left', level: 1, x: 0, y: 0, z: 0,
    pointCount: 3, pointDataOffset: 172, pointDataLength: 72,
    children: Object.freeze([]), childrenComplete: true,
  }),
]);

const ecefBounds = Object.freeze({
  root: Object.freeze({ minimum: [6378130, -10, -10], maximum: [6378140, 10, 10] }),
  left: Object.freeze({ minimum: [6378130, -10, -10], maximum: [6378135, 0, 0] }),
});

const sourceBounds = Object.freeze({
  root: Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }),
  left: Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: 0.5, maxY: 0.5, maxZ: 0.5 }),
});

const points = Object.freeze({
  root: new Float64Array([
    6378135, -2, 0,
    6378135, 0, 0,
    6378135, 2, 0,
  ]),
  left: new Float64Array([
    6378132.5, -7, -5,
    6378132.5, -5, -5,
    6378132.5, -3, -5,
  ]),
});

const attributes = Object.freeze({
  root: Object.freeze({
    red: new Uint16Array([65535, 0, 0]),
    green: new Uint16Array([0, 65535, 0]),
    blue: new Uint16Array([0, 0, 65535]),
    intensity: new Uint16Array([100, 200, 300]),
    classification: new Uint8Array([1, 2, 3]),
  }),
  left: Object.freeze({
    red: new Uint16Array([65535, 0, 65535]),
    green: new Uint16Array([65535, 65535, 0]),
    blue: new Uint16Array([0, 65535, 65535]),
    intensity: new Uint16Array([400, 500, 600]),
    classification: new Uint8Array([4, 5, 6]),
  }),
});

const contextFor = (nodeKey: string, generation: number) => Object.freeze({
  sourceIdentity,
  nodeKey,
  sourceGeneration: generation,
  transformGeneration,
  sourceCrs: Object.freeze({ status: 'identified' as const, identifier: 'EPSG:4978', horizontalUnit: 'metre', verticalUnit: 'metre' }),
  verticalDatum: Object.freeze({ status: 'verified' as const, identifier: 'WGS 84 ellipsoidal height', corrections: Object.freeze([]) }),
  heightOffsetMeters: 0,
});

const page = (key: string, pageOffset: number): TileHierarchyPage => Object.freeze({ key, pageOffset, pageLength: 32 });

/** A multi-node source that exercises the same lazy provider used for live COPC requests. */
export function createBrowserFixtureSource(generation: number): TileConservativeNodeSource {
  let current = true;
  const reads = { hierarchyPages: 0, conservativeBounds: 0, nodes: [] as string[] };
  const pages = new Map<string, Readonly<{ nodes: readonly TileHierarchyNode[]; pages: readonly TileHierarchyPage[] }>>([
    ['root-page', Object.freeze({ nodes: Object.freeze([nodes[0]!]), pages: Object.freeze([page('left-page', 32)]) })],
    ['left-page', Object.freeze({ nodes: Object.freeze([nodes[1]!]), pages: Object.freeze([]) })],
  ]);

  return Object.freeze({
    sourceIdentity,
    sourceGeneration: generation,
    transformGeneration,
    isCurrent: () => current,
    get diagnostics() {
      return Object.freeze({ hierarchyPages: reads.hierarchyPages, conservativeBounds: reads.conservativeBounds, nodes: Object.freeze([...reads.nodes]) });
    },
    getRootHierarchyPage: () => page('root-page', 0),
    getNodeCellBounds: (nodeKey: string) => {
      const bounds = sourceBounds[nodeKey as keyof typeof sourceBounds];
      if (!bounds) throw new Error(`Unknown hierarchy node ${nodeKey}.`);
      return bounds;
    },
    getConservativeNodeEcefBounds: (nodeKey: string): TileConservativeBoundsResult => {
      reads.conservativeBounds += 1;
      const sourceCellBounds = sourceBounds[nodeKey as keyof typeof sourceBounds];
      const bounds = ecefBounds[nodeKey as keyof typeof ecefBounds];
      if (!sourceCellBounds || !bounds) throw new Error(`Unknown hierarchy node ${nodeKey}.`);
      return Object.freeze({
        nodeKey,
        sourceCellBounds,
        sourceCoordinateSystem: 'copc-source',
        sourceIdentity,
        sourceGeneration: generation,
        transformGeneration,
        transformPlanIdentity: 'browser-fixture-transform-v1',
        heightOffsetMeters: 0,
        status: 'supported',
        boundsEcef: Object.freeze({
          coordinateSystem: 'wgs84-ecef-meters',
          minX: bounds.minimum[0], minY: bounds.minimum[1], minZ: bounds.minimum[2],
          maxX: bounds.maximum[0], maxY: bounds.maximum[1], maxZ: bounds.maximum[2],
        }),
        coverage: 'full-source-cell-and-descendant-cells',
        method: 'wgs84-geodetic-interval-v1',
        verification: 'analytic-interval',
        verticalReference: 'ellipsoidal',
        sourceVerticalUnitToMeters: 1,
        encoderErrorPaddingRequired: true,
        assumptions: Object.freeze(['bounded browser fixture']),
      });
    },
    loadHierarchyPage: async (hierarchyPage: TileHierarchyPage, signal?: AbortSignal) => {
      if (!current || signal?.aborted) throw new DOMException('Hierarchy read cancelled.', 'AbortError');
      reads.hierarchyPages += 1;
      const result = pages.get(hierarchyPage.key);
      if (!result) throw new Error(`Unknown hierarchy page ${hierarchyPage.key}.`);
      return result;
    },
    loadNode: async (node: TileHierarchyNode, selection: Parameters<TileConservativeNodeSource['loadNode']>[1], signal?: AbortSignal) => {
      if (!current || signal?.aborted) throw new DOMException('Point read cancelled.', 'AbortError');
      reads.nodes.push(node.key);
      const ecef = points[node.key as keyof typeof points];
      const nodeAttributes = attributes[node.key as keyof typeof attributes];
      if (!ecef || !nodeAttributes) throw new Error(`Unknown node content ${node.key}.`);
      const count = node.pointCount;
      const selectedAttributes = selection.attributes;
      return createExperimentalETilePointView({
        pointCount: count,
        ecef,
        height: new Float64Array(count),
        attributes: {
          ...(selectedAttributes?.rgb ? { red: nodeAttributes.red, green: nodeAttributes.green, blue: nodeAttributes.blue } : {}),
          ...(selectedAttributes?.intensity ? { intensity: nodeAttributes.intensity } : {}),
          ...(selectedAttributes?.classification ? { classification: nodeAttributes.classification } : {}),
        },
      }, contextFor(node.key, generation), { sourceIdentity, transformGeneration }, selection);
    },
    close: () => { current = false; },
  });
}
