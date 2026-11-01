export type TilesPipelineDiagnostics = Readonly<{
  status: "opening" | "scanning" | "loading" | "ready" | "error" | "closing" | "closed";
  sourceCrs: string;
  boundsSupport: "pending" | "supported" | "unsupported";
  boundsReason: string;
  hierarchyPages: number;
  hierarchyPageBytes: number;
  hierarchyNodes: number;
  requestedTiles: number;
  loadedTiles: number;
  visibleTiles: number;
  renderedPoints: number;
  resourceBytes: number;
  glbRequests: number;
  glbBytes: number;
  sourceGeneration: number | undefined;
  error: string;
}>;

export type TilesViewerCameraState =
  | {
      engine: "cesium";
      longitudeDegrees: number;
      latitudeDegrees: number;
      heightMeters: number;
      headingDegrees: number;
      pitchDegrees: number;
      rollDegrees: number;
    }
  | {
      engine: "three";
      state: {
        position: readonly [number, number, number];
        target: readonly [number, number, number];
      };
    };
