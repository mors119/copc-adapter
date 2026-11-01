export type TilesPipelineDiagnostics = Readonly<{
  status: "opening" | "scanning" | "loading" | "ready" | "error" | "closing" | "closed";
  sourceCrs: string;
  boundsSupport: "pending" | "supported" | "unsupported";
  boundsReason: string;
  boundsStrategy: "conservative-source-cell" | "decoded-content";
  boundsCoverage: "source-cell-and-descendants" | "rendered-content-only" | "pending";
  metadataOnlySourceCellStatus: "not-checked" | "supported" | "unsupported";
  metadataOnlySourceCellReason: string;
  geometryBoundsStatus: "pending" | "conservative-source-cell" | "complete-decoded-content";
  sourceToEcefStatus: "not-yet-prepared" | "prepared-by-core";
  transformPlanIdentity: string;
  contentScanPhase: "not-started" | "hierarchy" | "preflight" | "points" | "complete";
  contentNodesScanned: number;
  contentNodesTotal: number;
  contentPointsScanned: number;
  contentPointsTotal: number;
  contentPointDataBytes: number;
  contentEcefBytesScanned: number;
  peakDecodedEcefBufferBytes: number;
  sourceRangeBytesObserved: number;
  scanDurationMilliseconds: number;
  verticalPlacementStatus: "verified" | "unverified" | "not-reported";
  verticalPlacementReason: string;
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
