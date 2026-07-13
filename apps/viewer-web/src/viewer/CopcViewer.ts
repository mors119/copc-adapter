import { createCesiumViewer } from '../cesium/viewer/createViewer';

type CopcViewerOptions = {
  container: string;
  url: string;
};

export class CopcViewer {
  private viewer: any;
  private options: CopcViewerOptions;

  constructor(options: CopcViewerOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    this.viewer = createCesiumViewer(this.options.container);
  }

  async load(): Promise<void> {
    console.log('Loading COPC from:', this.options.url);

    const metadata = await this.loadMetadata();
    console.log('COPC Metadata:', metadata);

    const points = await this.loadPoints();
    this.render(points);
  }

  private async loadMetadata(): Promise<{ pointCount: number; version: string }> {
    // TODO: copc.js or wasm 연결
    return {
      pointCount: 1000000,
      version: '0.0.1',
    };
  }

  private async loadPoints(): Promise<Array<{ x: number; y: number; z: number }>> {
    // MVP: 더미 데이터
    return Array.from({ length: 1000 }, () => ({
      x: -120 + Math.random() * 40, // longitude
      y: 30 + Math.random() * 20, // latitude
      z: Math.random() * 500, // height
    }));
  }

  private render(points: Array<{ x: number; y: number; z: number }>): void {
    if (!this.viewer) {
      throw new Error('Cesium viewer is not initialized');
    }

    console.log('Render points:', points.length);
    // TODO: Cesium 연결
  }
}
