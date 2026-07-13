import * as Cesium from 'cesium';
import { renderCopcPoints } from '../cesium/render/renderPoints';
import { createCesiumViewer } from '../cesium/viewer/createViewer';
import { loadRootHierarchy } from '../copc/hierarchy/loadRootHierarchy';
import { loadCopcMetadata } from '../copc/metadata/loadMetadata';
import { loadCopcPoints } from '../copc/points/loadPointData';
import { createPointTransformer } from '../coordinates/transform/createPointTransformer';
import type { CopcHierarchyNode, CopcMetadata, GeographicPoint } from '../copc/types/copc';

type CopcViewerOptions = {
  container: string;
  url: string;
};

export class CopcViewer {
  private viewer?: Cesium.Viewer;
  private pointCollection?: Cesium.PointPrimitiveCollection;
  private options: CopcViewerOptions;

  constructor(options: CopcViewerOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    this.viewer = createCesiumViewer(this.options.container);
  }

  async load(): Promise<void> {
    const metadata = await this.loadMetadata();
    const node = await this.loadRenderNode();
    const points = await this.loadPoints(node);
    const transformPoint = createPointTransformer(metadata);
    const geographicPoints = points.map(transformPoint);
    this.render(points);

    this.renderGeographicPoints(geographicPoints);
  }

  private async loadMetadata(): Promise<CopcMetadata> {
    return loadCopcMetadata(this.options.url);
  }

  private async loadRenderNode(): Promise<CopcHierarchyNode> {
    const nodes = await loadRootHierarchy(this.options.url);
    const rootNode = nodes.find((node) => node.key === '0-0-0-0');

    if (rootNode) {
      return rootNode;
    }

    const largestNode = [...nodes].sort((left, right) => right.pointCount - left.pointCount)[0];

    if (!largestNode) {
      throw new Error('COPC hierarchy does not contain any renderable nodes');
    }

    return largestNode;
  }

  private async loadPoints(node: CopcHierarchyNode): Promise<Array<{ x: number; y: number; z: number }>> {
    return loadCopcPoints(this.options.url, node);
  }

  private render(points: Array<{ x: number; y: number; z: number }>): void {
    console.log('Render points:', points.length);
  }

  private renderGeographicPoints(points: GeographicPoint[]): void {
    if (!this.viewer) {
      throw new Error('Cesium viewer is not initialized');
    }

    this.pointCollection = renderCopcPoints(
      this.viewer,
      points,
      this.pointCollection,
    );
  }
}
