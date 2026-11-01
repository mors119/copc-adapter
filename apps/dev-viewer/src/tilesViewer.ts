import * as Cesium from "cesium";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TilesRenderer } from "3d-tiles-renderer";
import {
  GLTFMeshFeaturesExtension,
  GLTFStructuralMetadataExtension,
} from "3d-tiles-renderer/three/plugins";
import type {
  CopcBackendName,
  CopcMetadata,
  GtxGeoidGrid,
} from "@frillab/copc-adapter/core";
import { CopcCoreNodeSource } from "@frillab/copc-tiles/adapter/copc-core";
import {
  createCopcTileResourceProvider,
  createTileResourceServer,
  type DecodedContentScanProgress,
  type TileResourceServer,
} from "@frillab/copc-tiles";
import { registerTileResourceRoute, type TileResourceRoute } from "./tileResourceRoute";
import { registerCesiumTileXhrRoute } from "./cesiumTileXhrRoute";
import { createCesiumViewer } from "./createViewer";
import type {
  TilesPipelineDiagnostics,
  TilesViewerCameraState,
} from "./tilesViewerTypes";

export type TilesViewerSession = Readonly<{
  renderer: "cesium" | "three";
  metadata: CopcMetadata;
  getTilesetUrl(): string;
  getDiagnostics(): TilesPipelineDiagnostics;
  getCameraState(): TilesViewerCameraState;
  setCameraState(state: TilesViewerCameraState): void;
  setCameraDistance(distance: number): void;
  setCameraPreset(preset: "overview" | "far" | "near"): void;
  destroy(): void;
}>;

export type CreateTilesViewerOptions = Readonly<{
  container: HTMLElement;
  source: string | File;
  backend: CopcBackendName;
  rangeValidation: "head-fallback" | "strict";
  heightOffsetMeters: number;
  verticalGrid?: GtxGeoidGrid;
  boundsStrategy: "conservative-source-cell" | "decoded-content";
  renderer: "cesium" | "three";
  signal: AbortSignal;
  isCurrent(): boolean;
  onDiagnostics(value: TilesPipelineDiagnostics): void;
  onError(error: unknown): void;
}>;

const EMPTY_ROUTE_METRICS = Object.freeze({
  requestCount: 0,
  responseBytes: 0,
  failedRequestCount: 0,
  tilesetRequestCount: 0,
  glbRequestCount: 0,
  glbBytes: 0,
});

function publishDecodedContentProgress(
  progress: DecodedContentScanProgress,
  publish: (update: Partial<TilesPipelineDiagnostics>) => void,
): void {
  const datum = progress.verticalDatum;
  publish({
    status: progress.phase === "complete" ? "loading" : "scanning",
    boundsStrategy: "decoded-content",
    boundsCoverage: "rendered-content-only",
    geometryBoundsStatus: progress.phase === "complete" ? "complete-decoded-content" : "pending",
    sourceToEcefStatus: progress.scannedPoints > 0 ? "prepared-by-core" : "not-yet-prepared",
    transformPlanIdentity: progress.transformPlanIdentity ?? "Plan is established when the first content node is prepared",
    contentScanPhase: progress.phase,
    hierarchyNodes: progress.hierarchyNodes,
    hierarchyPages: progress.hierarchyPages,
    hierarchyPageBytes: progress.hierarchyPageBytes,
    contentNodesScanned: progress.scannedNodes,
    contentNodesTotal: progress.contentNodes,
    contentPointsScanned: progress.scannedPoints,
    contentPointsTotal: progress.totalPoints,
    contentPointDataBytes: progress.totalPointDataBytes,
    contentEcefBytesScanned: progress.decodedEcefBytesScanned,
    peakDecodedEcefBufferBytes: progress.peakDecodedEcefBufferBytes,
    verticalPlacementStatus: datum?.status === "verified"
      ? "verified"
      : progress.scannedPoints > 0 ? "unverified" : "not-reported",
    verticalPlacementReason: datum?.status === "verified"
      ? `Adapter Core reports verified vertical datum${datum.identifier ? ` ${datum.identifier}` : ""}.`
      : datum?.identifier
        ? `Vertical datum ${datum.identifier} is not verified for authoritative placement.`
        : progress.scannedPoints > 0
          ? "Vertical datum provenance is unknown; this is diagnostic ECEF placement only."
          : "Vertical datum provenance is reported after the first prepared content node.",
    boundsReason: progress.phase === "complete"
      ? `All ${progress.scannedPoints.toLocaleString()} content points in the complete bounded hierarchy were prepared; source-cell coverage is not claimed.`
      : `Decoded-content ${progress.phase}: ${progress.scannedPoints.toLocaleString()}/${progress.totalPoints.toLocaleString()} points across ${progress.scannedNodes.toLocaleString()}/${progress.contentNodes.toLocaleString()} content nodes.`,
    scanDurationMilliseconds: progress.elapsedMilliseconds,
  });
}

/**
 * Build a live COPC → public Tiles provider → generated GLB → renderer path.
 * The adapter remains the only owner of COPC, LAZ, CRS, and ECEF preparation.
 */
export async function createTilesViewerSession(
  options: CreateTilesViewerOptions,
): Promise<TilesViewerSession> {
  let diagnostics: TilesPipelineDiagnostics = Object.freeze({
    status: "opening",
    sourceCrs: "Not read",
    boundsSupport: "pending",
    boundsReason: "The source metadata and conservative bounds have not been checked yet.",
    boundsStrategy: options.boundsStrategy,
    boundsCoverage: "pending",
    metadataOnlySourceCellStatus: "not-checked",
    metadataOnlySourceCellReason: "No metadata-only source-cell check has been recorded.",
    geometryBoundsStatus: "pending",
    sourceToEcefStatus: "not-yet-prepared",
    transformPlanIdentity: "Not prepared",
    contentScanPhase: "not-started",
    contentNodesScanned: 0,
    contentNodesTotal: 0,
    contentPointsScanned: 0,
    contentPointsTotal: 0,
    contentPointDataBytes: 0,
    contentEcefBytesScanned: 0,
    peakDecodedEcefBufferBytes: 0,
    sourceRangeBytesObserved: 0,
    scanDurationMilliseconds: 0,
    verticalPlacementStatus: "not-reported",
    verticalPlacementReason: "Prepared points have not been scanned.",
    hierarchyPages: 0,
    hierarchyPageBytes: 0,
    hierarchyNodes: 0,
    requestedTiles: 0,
    loadedTiles: 0,
    visibleTiles: 0,
    renderedPoints: 0,
    resourceBytes: 0,
    glbRequests: 0,
    glbBytes: 0,
    sourceGeneration: undefined,
    error: "",
  });
  const publish = (update: Partial<TilesPipelineDiagnostics>): void => {
    if (Object.entries(update).every(([key, value]) =>
      diagnostics[key as keyof TilesPipelineDiagnostics] === value
    )) return;
    diagnostics = Object.freeze({ ...diagnostics, ...update });
    if (options.isCurrent()) options.onDiagnostics(diagnostics);
  };
  const assertCurrent = (): void => {
    if (options.signal.aborted) throw abortError(options.signal.reason);
    if (!options.isCurrent()) throw new DOMException("Tiles source generation was superseded.", "AbortError");
  };

  let context:
    | Awaited<
        ReturnType<
          typeof import("@frillab/copc-adapter/core").createCopcContext
        >
      >
    | undefined;
  let connector: CopcCoreNodeSource | undefined;
  let provider: Awaited<ReturnType<typeof createCopcTileResourceProvider>> | undefined;
  let server: TileResourceServer | undefined;
  let route: TileResourceRoute | undefined;
  let cesiumXhrRoute: Readonly<{ close(): void }> | undefined;
  let rendererCleanup: (() => void) | undefined;
  let closeRouteOnAbort: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let destroyed = false;
  const closeServerAndRoutes = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (!server) {
      route?.close();
      cesiumXhrRoute?.close();
      return Promise.resolve();
    }
    closePromise = server.close().finally(() => {
      route?.close();
      cesiumXhrRoute?.close();
    });
    return closePromise;
  };
  try {
    const { createCopcContext } = await import("@frillab/copc-adapter/core");
    context = await createCopcContext(options.source, options.backend, {
      signal: options.signal,
      rangeValidation: options.rangeValidation,
      heightOffsetMeters: options.heightOffsetMeters,
      verticalGrid: options.verticalGrid,
      maxConcurrentRangeRequests: 3,
    });
    assertCurrent();
    const metadata = context.getMetadata();
    const sourceCrs = getSourceCrsLabel(metadata);
    let sourceRangeBytesObserved = 0;
    context.setPerformanceObserver?.((event) => {
      if (event.stage !== "rangeFetch" || event.bytes === undefined) return;
      sourceRangeBytesObserved += event.bytes;
      publish({ sourceRangeBytesObserved });
    });
    publish({
      status: "scanning",
      sourceCrs,
      sourceGeneration: context.sourceGeneration,
      boundsSupport: "pending",
      boundsReason: options.boundsStrategy === "decoded-content"
        ? "Adapter Core will prepare every actual point in the complete bounded hierarchy; source-cell coverage remains a separate criterion."
        : "Adapter is checking full-cell WGS 84 ECEF bounds before Tileset creation.",
      boundsStrategy: options.boundsStrategy,
      boundsCoverage: "pending",
      geometryBoundsStatus: "pending",
      sourceToEcefStatus: "not-yet-prepared",
      contentScanPhase: options.boundsStrategy === "decoded-content" ? "hierarchy" : "not-started",
      verticalPlacementStatus: "not-reported",
      verticalPlacementReason: "Prepared points have not been scanned.",
    });

    connector = new CopcCoreNodeSource({
      source: context,
      sourceIdentity: `dev-viewer-tiles-${crypto.randomUUID()}`,
      ownsSource: true,
      isCurrent: options.isCurrent,
    });
    context = undefined;
    const decodedContent = options.boundsStrategy === "decoded-content";
    provider = await createCopcTileResourceProvider(connector, {
      scanCompleteHierarchy: true,
      ...(decodedContent ? {
        boundsStrategy: "decoded-content" as const,
        allowDecodedContentBounds: true as const,
        onDecodedContentProgress: (progress: DecodedContentScanProgress) => {
          publishDecodedContentProgress(progress, publish);
        },
      } : { boundsStrategy: "conservative-source-cell" as const }),
      signal: options.signal,
      ownsSource: true,
      readerLimits: {
        maxHierarchyPages: 128,
        maxHierarchyPageBytes: 1024 * 1024,
        maxTotalHierarchyPageBytes: 8 * 1024 * 1024,
        maxHierarchyNodes: 4096,
        maxNodesPerPage: 8192,
        ...(decodedContent ? {
          maxRequestedNodes: 512,
          maxPointsPerNode: 2_000_000,
          maxTotalPoints: 4_000_000,
          maxPointDataBytesPerNode: 128 * 1024 * 1024,
          maxTotalPointDataBytes: 256 * 1024 * 1024,
          maxDecodedBytesPerNode: 192 * 1024 * 1024,
          maxTotalDecodedBytes: 384 * 1024 * 1024,
        } : {
          maxRequestedNodes: 32,
          maxPointsPerNode: 200_000,
          maxTotalPoints: 250_000,
          maxPointDataBytesPerNode: 8 * 1024 * 1024,
          maxTotalPointDataBytes: 32 * 1024 * 1024,
          maxDecodedBytesPerNode: 16 * 1024 * 1024,
          maxTotalDecodedBytes: 64 * 1024 * 1024,
        }),
        maxConcurrentNodeReads: 2,
      },
      tilesetOptions: { maxNodes: 4096, maxTotalPoints: decodedContent ? 4_000_000 : 250_000 },
      selection: { attributes: { rgb: true } },
      maxEncoderPaddingMeters: 0.01,
      maxGlbBytes: 16 * 1024 * 1024,
      maxTilesetBytes: 4 * 1024 * 1024,
    });
    assertCurrent();
    connector = undefined;
    const tilesetNodes = countTilesetNodes(provider.tileset);
    server = createTileResourceServer(provider, {
      maxResourceBytes: 16 * 1024 * 1024,
      maxCacheBytes: 32 * 1024 * 1024,
      maxCacheEntries: 64,
      maxConcurrentLoads: 2,
      maxQueuedLoads: 4,
      closeProviderOnShutdown: true,
    });
    route = registerTileResourceRoute(server, () => syncRouteMetrics());
    if (options.renderer === "cesium") {
      cesiumXhrRoute = registerCesiumTileXhrRoute(Cesium.Resource, route.url);
    }
    closeRouteOnAbort = (): void => {
      void closeServerAndRoutes();
    };
    options.signal.addEventListener("abort", closeRouteOnAbort, { once: true });
    const decodedSummary = provider.decodedContentScan;
    publish({
      status: "loading",
      sourceCrs,
      boundsSupport: "supported",
      boundsReason: decodedSummary
        ? `Every content-bearing node was scanned (${decodedSummary.scannedPoints.toLocaleString()} points); bounds do not cover unobserved source cells. Transform plan ${decodedSummary.transformPlanIdentity}.`
        : "Every scanned hierarchy cell has Adapter-certified WGS 84 ECEF bounds.",
      boundsStrategy: provider.boundsStrategy,
      boundsCoverage: decodedSummary ? "rendered-content-only" : "source-cell-and-descendants",
      metadataOnlySourceCellStatus: decodedSummary?.metadataOnlySourceCellStatus ?? "not-checked",
      metadataOnlySourceCellReason: decodedSummary?.metadataOnlySourceCellReasonCode
        ? `${decodedSummary.metadataOnlySourceCellReasonCode}: ${decodedSummary.metadataOnlySourceCellReason ?? "No reason was provided."}`
        : decodedSummary?.metadataOnlySourceCellReason ??
          (decodedSummary?.metadataOnlySourceCellStatus === "supported"
            ? "Core returned a supported metadata-only source-cell bound."
            : decodedSummary
              ? "No metadata-only result is available from this node source."
              : "The conservative-source-cell result is the active geometry bound."),
      geometryBoundsStatus: decodedSummary ? "complete-decoded-content" : "conservative-source-cell",
      sourceToEcefStatus: decodedSummary ? "prepared-by-core" : "not-yet-prepared",
      transformPlanIdentity: decodedSummary?.transformPlanIdentity ?? "Adapter source-cell operation",
      contentScanPhase: decodedSummary ? "complete" : "not-started",
      contentNodesScanned: decodedSummary?.contentNodes ?? 0,
      contentNodesTotal: decodedSummary?.contentNodes ?? 0,
      contentPointsScanned: decodedSummary?.scannedPoints ?? 0,
      contentPointsTotal: decodedSummary?.totalPoints ?? 0,
      contentPointDataBytes: decodedSummary?.totalPointDataBytes ?? 0,
      contentEcefBytesScanned: decodedSummary?.decodedEcefBytesScanned ?? 0,
      peakDecodedEcefBufferBytes: decodedSummary?.peakDecodedEcefBufferBytes ?? 0,
      sourceRangeBytesObserved,
      scanDurationMilliseconds: decodedSummary?.scanDurationMilliseconds ?? 0,
      verticalPlacementStatus: decodedSummary?.verticalPlacement ?? "not-reported",
      verticalPlacementReason: decodedSummary
        ? decodedSummary.verticalPlacement === "verified"
          ? decodedSummary.verticalDatum.corrections.some(({ kind }) => kind === "validated-grid")
            ? `Adapter Core reports a validated vertical-grid operation for ${decodedSummary.verticalDatum.identifier ?? "the declared source datum"}. This validates the configured operation and coverage, not survey accuracy of the source.`
            : decodedSummary.verticalDatum.identifier === "WGS 84 ellipsoidal height"
              ? "Source WKT explicitly declares WGS 84 ellipsoidal height; the vertical operation is identity. This does not claim survey-grade accuracy or a coordinate epoch."
              : `Adapter Core reports verified vertical datum provenance${decodedSummary.verticalDatum.identifier ? ` for ${decodedSummary.verticalDatum.identifier}` : ""}. This does not by itself establish survey-grade accuracy.`
          : decodedSummary.verticalDatum.identifier
            ? `Vertical datum ${decodedSummary.verticalDatum.identifier} is not verified for authoritative placement.`
            : "Vertical datum provenance is unknown; this is a diagnostic ECEF placement only."
        : "Conservative source-cell result carries its own vertical proof metadata.",
      hierarchyPages: provider.hierarchyPagesRead,
      hierarchyPageBytes: provider.hierarchyPageBytesRead,
      hierarchyNodes: tilesetNodes,
      sourceGeneration: provider.generation,
    });

    const activeServer = server;
    const activeRoute = route;
    const complete = options.renderer === "cesium"
      ? await createCesiumTilesRenderer(options, activeRoute, publish)
      : await createThreeTilesRenderer(options, activeRoute, activeServer, publish);
    rendererCleanup = complete.destroy;
    assertCurrent();
    publish({ status: "ready", error: "" });

    return Object.freeze({
      renderer: options.renderer,
      metadata,
      getTilesetUrl: () => activeRoute.url,
      getDiagnostics: () => diagnostics,
      getCameraState: complete.getCameraState,
      setCameraState: complete.setCameraState,
      setCameraDistance: complete.setCameraDistance,
      setCameraPreset: complete.setCameraPreset,
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        if (closeRouteOnAbort) options.signal.removeEventListener("abort", closeRouteOnAbort);
        publish({ status: "closing" });
        rendererCleanup?.();
        rendererCleanup = undefined;
        void closeServerAndRoutes().finally(() => {
          if (options.isCurrent()) publish({ status: "closed" });
        });
      },
    });
  } catch (error) {
    if (closeRouteOnAbort) options.signal.removeEventListener("abort", closeRouteOnAbort);
    const bounds = getConservativeBoundsError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (bounds) {
      publish({
        status: "error",
        boundsSupport: "unsupported",
        boundsReason: `${bounds.reasonCode}: ${bounds.reason}`,
        error: message,
      });
    } else if (!options.signal.aborted) {
      publish({ status: "error", error: message });
    }
    rendererCleanup?.();
    if (server) {
      await closeServerAndRoutes();
    } else if (provider) {
      await provider.close?.();
    } else if (connector) {
      await connector.close();
    } else {
      context?.close();
    }
    throw error;
  }

  function syncRouteMetrics(): void {
    const metrics = route?.getMetrics() ?? EMPTY_ROUTE_METRICS;
    publish({
      requestedTiles: metrics.glbRequestCount,
      resourceBytes: metrics.responseBytes,
      glbRequests: metrics.glbRequestCount,
      glbBytes: metrics.glbBytes,
    });
  }
}

type RendererCamera = Readonly<{
  getCameraState(): TilesViewerCameraState;
  setCameraState(state: TilesViewerCameraState): void;
  setCameraDistance(distance: number): void;
  setCameraPreset(preset: "overview" | "far" | "near"): void;
  destroy(): void;
}>;

async function createCesiumTilesRenderer(
  options: CreateTilesViewerOptions,
  route: TileResourceRoute,
  publish: (update: Partial<TilesPipelineDiagnostics>) => void,
): Promise<RendererCamera> {
  const viewer = createCesiumViewer(options.container, {
    scene3DOnly: true,
    useBrowserRecommendedResolution: false,
    preserveDrawingBuffer: true,
  });
  viewer.scene.globe.show = false;
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  let tileset: Cesium.Cesium3DTileset | undefined;
  let destroyed = false;
  let initialDistance = 300;
  const initialHeading = 0;
  const initialPitch = Cesium.Math.toRadians(-38);
  let renderedPoints = 0;
  let added = false;
  let lastTileFailure = "";
  const loaded = new Set<object>();
  const visible = new Map<object, number>();
  const onLoad = (tile: Cesium.Cesium3DTile): void => {
    loaded.add(tile);
    publish({ loadedTiles: loaded.size });
  };
  const onVisible = (tile: Cesium.Cesium3DTile): void => {
    const points = tile.content?.pointsLength ?? 0;
    if (points > 0) visible.set(tile, points);
    else visible.delete(tile);
    renderedPoints = [...visible.values()].reduce((sum, count) => sum + count, 0);
    publish({ visibleTiles: visible.size, renderedPoints });
  };
  const onFailed = (event: { message?: string }): void => {
    const error = new Error(event.message ?? "Cesium reported a 3D Tiles request failure.");
    lastTileFailure = error.message;
    publish({ status: "error", error: error.message });
    options.onError(error);
  };
  const onCameraMove = (): void => {
    visible.clear();
    renderedPoints = 0;
    publish({ visibleTiles: 0, renderedPoints: 0 });
  };
  try {
    tileset = await Cesium.Cesium3DTileset.fromUrl(route.url, {
      maximumScreenSpaceError: 8,
      dynamicScreenSpaceError: false,
      foveatedScreenSpaceError: false,
    });
    if (options.signal.aborted || !options.isCurrent()) {
      tileset.destroy();
      throw abortError(options.signal.reason);
    }
    tileset.tileLoad.addEventListener(onLoad);
    tileset.tileVisible.addEventListener(onVisible);
    tileset.tileFailed.addEventListener(onFailed);
    viewer.camera.changed.addEventListener(onCameraMove);
    viewer.scene.primitives.add(tileset);
    added = true;
    const sphere = tileset.boundingSphere;
    initialDistance = Math.max(80, sphere.radius * 4);
    await viewer.zoomTo(
      tileset,
      new Cesium.HeadingPitchRange(initialHeading, initialPitch, initialDistance),
    );
    await waitFor(
      () => [...visible.values()].some((count) => count > 0),
      options.signal,
      45_000,
      () => {
        const metrics = route.getMetrics();
        const position = viewer.camera.positionWC;
        const direction = viewer.camera.directionWC;
        const up = viewer.camera.upWC;
        const frustum = viewer.camera.frustum.computeCullingVolume(position, direction, up);
        const sphere = tileset!.boundingSphere;
        const canvas = viewer.scene.canvas;
        return `Cesium did not make a generated COPC GLB visible (GLBs=${metrics.glbRequestCount}, GLB bytes=${metrics.glbBytes}, loaded tiles=${loaded.size}, visible tiles=${visible.size}, tile error=${lastTileFailure || "none"}, sphere=${JSON.stringify({ center: [sphere.center.x, sphere.center.y, sphere.center.z], radius: sphere.radius, visibility: frustum.computeVisibility(sphere) })}, camera=${JSON.stringify({ position: [position.x, position.y, position.z], direction: [direction.x, direction.y, direction.z], canvas: [canvas.width, canvas.height] })}).`;
      },
    );
    publish({
      loadedTiles: loaded.size,
      visibleTiles: visible.size,
      renderedPoints: [...visible.values()].reduce((sum, count) => sum + count, 0),
    });
  } catch (error) {
    if (tileset && !tileset.isDestroyed()) {
      if (added) viewer.scene.primitives.remove(tileset);
      else tileset.destroy();
    }
    if (!viewer.isDestroyed()) viewer.destroy();
    throw error;
  }

  return {
    getCameraState: () => {
      const position = viewer.camera.positionCartographic;
      return {
        engine: "cesium",
        longitudeDegrees: Cesium.Math.toDegrees(position.longitude),
        latitudeDegrees: Cesium.Math.toDegrees(position.latitude),
        heightMeters: position.height,
        headingDegrees: Cesium.Math.toDegrees(viewer.camera.heading),
        pitchDegrees: Cesium.Math.toDegrees(viewer.camera.pitch),
        rollDegrees: Cesium.Math.toDegrees(viewer.camera.roll),
      };
    },
    setCameraState(state) {
      if (state.engine !== "cesium") return;
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          state.longitudeDegrees,
          state.latitudeDegrees,
          state.heightMeters,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(state.headingDegrees),
          pitch: Cesium.Math.toRadians(state.pitchDegrees),
          roll: Cesium.Math.toRadians(state.rollDegrees),
        },
      });
    },
    setCameraDistance(distance) {
      setCameraDistance(distance);
    },
    setCameraPreset(preset) {
      const distance = initialDistance * (preset === "near" ? 0.55 : preset === "far" ? 2.5 : 1);
      viewer.camera.flyToBoundingSphere(tileset!.boundingSphere, {
        duration: 0,
        offset: new Cesium.HeadingPitchRange(
          initialHeading,
          initialPitch,
          distance,
        ),
      });
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      viewer.camera.changed.removeEventListener(onCameraMove);
      if (tileset) {
        tileset.tileLoad.removeEventListener(onLoad);
        tileset.tileVisible.removeEventListener(onVisible);
        tileset.tileFailed.removeEventListener(onFailed);
        viewer.scene.primitives.remove(tileset);
        tileset = undefined;
      }
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };

  function setCameraDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    const position = viewer.camera.positionCartographic;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromRadians(
        position.longitude,
        position.latitude,
        distance,
      ),
      orientation: {
        heading: viewer.camera.heading,
        pitch: viewer.camera.pitch,
        roll: viewer.camera.roll,
      },
    });
  }
}

async function createThreeTilesRenderer(
  options: CreateTilesViewerOptions,
  route: TileResourceRoute,
  _server: TileResourceServer,
  publish: (update: Partial<TilesPipelineDiagnostics>) => void,
): Promise<RendererCamera> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#08111d");
  const canvas = document.createElement("canvas");
  canvas.className = "tiles-renderer-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Interactive 3D Tiles COPC point cloud");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(options.container.clientWidth, options.container.clientHeight);
  renderer.setClearColor(0x08111d, 1);
  options.container.replaceChildren(canvas);

  const camera = new THREE.PerspectiveCamera(
    45,
    Math.max(1, options.container.clientWidth) / Math.max(1, options.container.clientHeight),
    0.1,
    500_000,
  );
  const tiles = new TilesRenderer(route.url);
  tiles.errorTarget = 8;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  const loader = new GLTFLoader(tiles.manager);
  loader.register(() => new GLTFMeshFeaturesExtension());
  loader.register(() => new GLTFStructuralMetadataExtension());
  tiles.manager.addHandler(/\.(gltf|glb)$/i, loader);
  scene.add(tiles.group);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  let destroyed = false;
  let animationFrame = 0;
  let baseDistance = 200;
  let loadedTileCount = 0;
  const loadedUrls = new Set<string>();
  const visibleScenes = new Map<object, THREE.Object3D>();
  const getVisiblePointCount = (): number =>
    [...visibleScenes.values()].reduce((sum, model) => sum + countPointObjects(model), 0);
  const onModel = (event: { url?: string; scene?: THREE.Object3D }): void => {
    loadedUrls.add(event.url ?? `model-${loadedUrls.size + 1}`);
    loadedTileCount = loadedUrls.size;
    publish({ loadedTiles: loadedTileCount });
  };
  const onTileVisibilityChange = (event: {
    tile?: object;
    scene?: THREE.Object3D;
    visible?: boolean;
  }): void => {
    if (!event.tile || !event.scene) return;
    if (event.visible && countPointObjects(event.scene) > 0) {
      visibleScenes.set(event.tile, event.scene);
    } else {
      visibleScenes.delete(event.tile);
    }
    publish({
      visibleTiles: visibleScenes.size,
      renderedPoints: getVisiblePointCount(),
    });
  };
  const onError = (event: { error?: unknown }): void => {
    const error = event.error instanceof Error ? event.error : new Error(String(event.error ?? "Three 3D Tiles request failed."));
    publish({ status: "error", error: error.message });
    options.onError(error);
  };
  tiles.addEventListener("load-model", onModel);
  tiles.addEventListener("tile-visibility-change", onTileVisibilityChange);
  tiles.addEventListener("load-error", onError);

  const onResize = (): void => {
    const width = options.container.clientWidth;
    const height = options.container.clientHeight;
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    tiles.setResolutionFromRenderer(camera, renderer);
  };
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(options.container);

  const updateFrame = (): void => {
    if (destroyed) return;
    animationFrame = requestAnimationFrame(updateFrame);
    controls.update();
    camera.updateMatrixWorld();
    tiles.update();
    renderer.render(scene, camera);
    publish({
      visibleTiles: visibleScenes.size,
      renderedPoints: getVisiblePointCount(),
    });
  };
  updateFrame();
  try {
    const boundingSphere = new THREE.Sphere();
    await waitFor(() => tiles.getBoundingSphere(boundingSphere) && boundingSphere.radius > 0, options.signal, 30_000,
      "Three TilesRenderer did not load the generated Tileset bounds.");
    const target = boundingSphere.center.clone();
    const up = target.clone().normalize();
    baseDistance = Math.max(80, boundingSphere.radius * 4);
    camera.up.copy(up);
    camera.position.copy(target).addScaledVector(up, baseDistance);
    camera.lookAt(target);
    controls.target.copy(target);
    controls.update();
    camera.updateMatrixWorld();

    await waitFor(() => getVisiblePointCount() > 0, options.signal, 45_000,
      "Three TilesRenderer did not make a generated COPC GLB visible.");
    publish({
      status: "ready",
      loadedTiles: loadedTileCount,
      visibleTiles: visibleScenes.size,
      renderedPoints: getVisiblePointCount(),
    });
  } catch (error) {
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    resizeObserver.disconnect();
    tiles.removeEventListener("load-model", onModel);
    tiles.removeEventListener("tile-visibility-change", onTileVisibilityChange);
    tiles.removeEventListener("load-error", onError);
    tiles.dispose();
    controls.dispose();
    renderer.dispose();
    canvas.remove();
    throw error;
  }

  return {
    getCameraState: () => ({
      engine: "three",
      state: {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [controls.target.x, controls.target.y, controls.target.z],
      },
    }),
    setCameraState(state) {
      if (state.engine !== "three") return;
      camera.position.set(...state.state.position);
      controls.target.set(...state.state.target);
      camera.lookAt(controls.target);
      controls.update();
    },
    setCameraDistance(distance) {
      setCameraDistance(distance);
    },
    setCameraPreset(preset) {
      const distance = baseDistance * (preset === "near" ? 0.55 : preset === "far" ? 2.5 : 1);
      setCameraDistance(distance);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      tiles.removeEventListener("load-model", onModel);
      tiles.removeEventListener("tile-visibility-change", onTileVisibilityChange);
      tiles.removeEventListener("load-error", onError);
      tiles.dispose();
      controls.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };

  function setCameraDistance(distance: number): void {
    if (!Number.isFinite(distance) || distance <= 0) return;
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    controls.update();
  }
}

function countPointObjects(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if (object instanceof THREE.Points) {
      const positions = object.geometry.getAttribute("position");
      if (positions) count += positions.count;
    }
  });
  return count;
}

function getSourceCrsLabel(metadata: CopcMetadata): string {
  const identity = metadata.crsDiagnostic?.horizontal.identity;
  if (identity?.authority && identity.code) return `${identity.authority}:${identity.code}`;
  if (identity?.name) return identity.name;
  return metadata.crsDiagnostic?.wkt.metadataSupport === "missing"
    ? "Unknown · source WKT missing"
    : "Unknown · see source diagnostics";
}

function countTilesetNodes(tileset: Readonly<Record<string, unknown>>): number {
  const root = tileset.root;
  let count = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    count += 1;
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) children.forEach(visit);
  };
  visit(root);
  return count;
}

function getConservativeBoundsError(error: unknown):
  | { reasonCode: string; reason: string }
  | undefined {
  if (!error || typeof error !== "object") return undefined;
  const result = (error as { conservativeBoundsResult?: unknown }).conservativeBoundsResult;
  if (!result || typeof result !== "object") return undefined;
  const candidate = result as { status?: unknown; reasonCode?: unknown; reason?: unknown };
  return candidate.status === "unsupported" && typeof candidate.reasonCode === "string" && typeof candidate.reason === "string"
    ? { reasonCode: candidate.reasonCode, reason: candidate.reason }
    : undefined;
}

async function waitFor(
  predicate: () => boolean,
  signal: AbortSignal,
  timeoutMs: number,
  message: string | (() => string),
): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (signal.aborted) throw abortError(signal.reason);
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(typeof message === "function" ? message() : message);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
}

function abortError(reason?: unknown): DOMException {
  return reason instanceof DOMException && reason.name === "AbortError"
    ? reason
    : new DOMException(reason instanceof Error ? reason.message : "Operation aborted.", "AbortError");
}
