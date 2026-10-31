import * as Cesium from "cesium";

const edlFragmentShader = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_strength;
uniform float u_radius;
in vec2 v_textureCoordinates;

float eyeDepthAt(vec2 uv) {
  float depth = czm_readDepth(depthTexture, uv);
  if (depth >= 1.0) return czm_currentFrustum.y;
  vec2 ndcXY = uv * 2.0 - 1.0;
  vec4 eye = czm_inverseProjection * vec4(ndcXY, depth * 2.0 - 1.0, 1.0);
  return max(0.001, -eye.z / eye.w);
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  float centerDepth = eyeDepthAt(v_textureCoordinates);
  vec2 pixel = u_radius / czm_viewport.zw;
  const vec2 directions[4] = vec2[4](
    vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0)
  );
  float response = 0.0;
  for (int index = 0; index < 4; index++) {
    float neighborDepth = eyeDepthAt(v_textureCoordinates + directions[index] * pixel);
    response += max(0.0, log2(centerDepth) - log2(neighborDepth));
  }
  float shade = exp(-u_strength * response * 0.25);
  out_FragColor = vec4(color.rgb * shade, color.a);
}`;

type ProbeApi = {
  cesiumVersion: string;
  dense: boolean;
  pointCounts: [number, number];
  setEdl(enabled: boolean): void;
  setDense(enabled: boolean): void;
  measureFrames(enabled: boolean, durationMs?: number): Promise<{
    frameCount: number;
    p50FrameMs: number;
    p95FrameMs: number;
    maxFrameMs: number;
  }>;
  measureGpu(enabled: boolean, durationMs?: number): Promise<Record<string, unknown>>;
  getCapabilities(): Record<string, unknown>;
};

declare global {
  interface Window {
    __EDL_RESEARCH__?: ProbeApi;
  }
}

const viewer = new Cesium.Viewer("cesium-container", {
  animation: false,
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  timeline: false,
  fullscreenButton: false,
  requestRenderMode: false,
  useBrowserRecommendedResolution: false,
  msaaSamples: 1,
});
if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#415548");
viewer.scene.globe.enableLighting = false;
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.camera.lookAt(
  Cesium.Cartesian3.fromDegrees(-122.7, 44.0, 80),
  new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(20),
    Cesium.Math.toRadians(-52),
    1_700,
  ),
);

const colors = [Cesium.Color.fromCssColorString("#44e0b1"), Cesium.Color.fromCssColorString("#ffb44a")];
const cloudCollections: Cesium.PointPrimitiveCollection[] = [];
let dense = false;
let activeStage: Cesium.PostProcessStage | undefined;
let currentCounts: [number, number] = [0, 0];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createClouds(): void {
  for (const collection of cloudCollections) viewer.scene.primitives.remove(collection);
  cloudCollections.length = 0;
  const pointCount = dense ? 50_000 : 2_500;
  currentCounts = [pointCount, pointCount];

  for (let layerIndex = 0; layerIndex < 2; layerIndex += 1) {
    const points = new Cesium.PointPrimitiveCollection();
    const random = seededRandom(100 + layerIndex);
    for (let index = 0; index < pointCount; index += 1) {
      const longitude = -122.7 + (random() - 0.5) * 0.012 + layerIndex * 0.003;
      const latitude = 44.0 + (random() - 0.5) * 0.008;
      const height = 25 + random() * 180 + layerIndex * 20;
      points.add({
        position: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
        pixelSize: dense ? 3 : 5,
        color: colors[layerIndex],
        disableDepthTestDistance: 0,
      });
    }
    viewer.scene.primitives.add(points);
    cloudCollections.push(points);
  }

  viewer.entities.removeAll();
  viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-122.7, 44.0, 85),
    box: {
      dimensions: new Cesium.Cartesian3(220, 220, 170),
      material: Cesium.Color.fromCssColorString("#c17b58"),
      outline: false,
    },
  });
  updateStatus();
  viewer.scene.requestRender();
}

function setEdl(enabled: boolean): void {
  if (activeStage) {
    viewer.scene.postProcessStages.remove(activeStage);
    activeStage = undefined;
  }
  if (enabled) {
    activeStage = viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: "issue243GlobalSceneEdlPrototype",
        fragmentShader: edlFragmentShader,
        uniforms: { u_strength: 18.0, u_radius: 2.0 },
      }),
    ) as Cesium.PostProcessStage;
  }
  updateStatus();
  viewer.scene.requestRender();
}

function updateStatus(): void {
  document.querySelector("#status")!.textContent =
    ` · ${dense ? "dense" : "sparse"} · ${currentCounts[0] + currentCounts[1]} pts · EDL ${activeStage ? "on (global)" : "off"}`;
}

async function measureFrames(enabled: boolean, durationMs = 5_000) {
  setEdl(enabled);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const frameDurations: number[] = [];
  let previous = performance.now();
  const endAt = previous + durationMs;
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      frameDurations.push(now - previous);
      previous = now;
      if (now >= endAt) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const sorted = frameDurations.slice(5).sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
  return {
    frameCount: frameDurations.length,
    p50FrameMs: percentile(0.5),
    p95FrameMs: percentile(0.95),
    maxFrameMs: percentile(1),
  };
}

async function measureGpu(enabled: boolean, durationMs = 5_000): Promise<Record<string, unknown>> {
  setEdl(enabled);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const canvas = viewer.scene.canvas;
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as
    | WebGL2RenderingContext
    | WebGLRenderingContext
    | null;
  const extension = gl?.getExtension("EXT_disjoint_timer_query_webgl2") as
    | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
    | null;
  if (!gl || !extension || !(gl instanceof WebGL2RenderingContext)) {
    return { supported: false, reason: "EXT_disjoint_timer_query_webgl2 unavailable" };
  }
  const samples: number[] = [];
  const pending: WebGLQuery[] = [];
  let activeQuery: WebGLQuery | undefined;
  let disjoint = false;
  const begin = () => {
    if (activeQuery) return;
    activeQuery = gl.createQuery() ?? undefined;
    if (activeQuery) gl.beginQuery(extension.TIME_ELAPSED_EXT, activeQuery);
  };
  const finish = () => {
    if (activeQuery) {
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      pending.push(activeQuery);
      activeQuery = undefined;
    }
    while (pending.length > 0) {
      const query = pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      disjoint ||= Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT));
      const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      if (!disjoint && Number.isFinite(nanoseconds)) samples.push(nanoseconds / 1_000_000);
      gl.deleteQuery(query);
    }
  };
  const removeBegin = viewer.scene.preRender.addEventListener(begin);
  const removeFinish = viewer.scene.postRender.addEventListener(finish);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  removeBegin();
  removeFinish();
  if (activeQuery) {
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    pending.push(activeQuery);
    activeQuery = undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  finish();
  for (const query of pending) gl.deleteQuery(query);
  const sorted = samples.sort((left, right) => left - right);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
  return {
    supported: true,
    disjoint,
    samples: sorted.length,
    p50GpuMs: percentile(0.5),
    p95GpuMs: percentile(0.95),
    maxGpuMs: percentile(1),
  };
}

function getCapabilities(): Record<string, unknown> {
  const canvas = viewer.scene.canvas;
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const extensions = gl?.getSupportedExtensions() ?? [];
  const rendererInfo = gl?.getExtension("WEBGL_debug_renderer_info") as
    | { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number }
    | null;
  const webgl1Canvas = document.createElement("canvas");
  const webgl1 = webgl1Canvas.getContext("webgl");
  const webgl1Extensions = webgl1?.getSupportedExtensions() ?? [];
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    devicePixelRatio: window.devicePixelRatio,
    viewportCss: `${window.innerWidth}x${window.innerHeight}`,
    drawingBuffer: `${canvas.width}x${canvas.height}`,
    webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext,
    extensions,
    gpuVendor: rendererInfo ? gl?.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) : undefined,
    gpuRenderer: rendererInfo ? gl?.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : undefined,
    maxTextureSize: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl?.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxColorAttachments: gl instanceof WebGL2RenderingContext ? gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) : undefined,
    maxDrawBuffers: gl instanceof WebGL2RenderingContext ? gl.getParameter(gl.MAX_DRAW_BUFFERS) : undefined,
    webgl1MaxVaryingVectors: webgl1?.getParameter(webgl1.MAX_VARYING_VECTORS),
    webgl1Extensions,
    cesiumPointCloudShadingSupported: Cesium.PointCloudShading.isSupported(viewer.scene),
    globeDepthTestAgainstTerrain: viewer.scene.globe.depthTestAgainstTerrain,
  };
}

createClouds();
document.querySelector("#toggle-edl")!.addEventListener("click", () => setEdl(!activeStage));
document.querySelector("#toggle-density")!.addEventListener("click", () => {
  dense = !dense;
  createClouds();
});

window.__EDL_RESEARCH__ = {
  cesiumVersion: (Cesium as typeof Cesium & { VERSION: string }).VERSION,
  get dense() { return dense; },
  get pointCounts() { return currentCounts; },
  setEdl,
  setDense(enabled) { dense = enabled; createClouds(); },
  measureFrames,
  measureGpu,
  getCapabilities,
};
