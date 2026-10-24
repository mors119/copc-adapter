import type {
  CopcCesiumLayerOptions,
  RefinementFocus,
} from "@frillab/copc-adapter/cesium";
import type { CopcThreeLayerOptions } from "@frillab/copc-adapter/three";
import type { WorkbenchRenderer } from "../../shared/workbench-config";
import type { PlaygroundConfig } from "./playgroundConfig";
import type { PlaygroundRefinementConfig } from "./refinementConfig";

export type IntegrationCodeConfig = PlaygroundConfig & {
  readonly refinementConfig: PlaygroundRefinementConfig;
};

export type IntegrationCodeOptions = {
  readonly config: IntegrationCodeConfig;
  readonly source?: string | File;
  readonly includeExactSource?: boolean;
  readonly mode?: "minimal" | "explicit";
  readonly adapterVersion: string;
  readonly refinementFocus?: RefinementFocus;
};

export const PLAYGROUND_INSTALL_COMMANDS: Readonly<Record<WorkbenchRenderer, string>> = {
  cesium: "npm install @frillab/copc-adapter cesium",
  three: "npm install @frillab/copc-adapter three",
};

const DEFAULTS = {
  backend: "copc-js",
  colorMode: "fixed",
  pointSize: 3,
  maxRenderedPoints: 250_000,
  maxPointCacheBytes: 256 * 1024 * 1024,
  maxNodes: 24,
  maxDepth: 6,
  maxScreenSpaceError: 8,
  maxRenderDistanceMeters: 12_000,
  refinementAlgorithm: "foveated",
  motionLookahead: true,
} as const;

/** Conservatively flag source URLs with credentials, query strings, or fragments. */
export function isPotentiallySensitiveSource(source: string): boolean {
  try {
    const url = new URL(source);
    return (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      source.includes("?")
    );
  } catch {
    return true;
  }
}

function isFileSource(source: string | File | undefined): source is File {
  return typeof File !== "undefined" && source instanceof File;
}

function quote(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}'`;
}

function resolveCodeSource(options: IntegrationCodeOptions): {
  sourceValue: string | File;
  expression: string;
  setup: string[];
} {
  if (isFileSource(options.source)) {
    return {
      sourceValue: options.source,
      expression: "sourceFile",
      setup: [
        "// Add <input id=\"copc-file-input\" type=\"file\" accept=\".copc.laz\"> to your page.",
        "const fileInput = document.querySelector<HTMLInputElement>('#copc-file-input');",
        "const sourceFile = fileInput?.files?.[0];",
        "if (!sourceFile) throw new Error('Choose a COPC file first.');",
      ],
    };
  }

  const source = options.source;
  const useActualSource =
    source !== undefined &&
    (options.includeExactSource ?? !isPotentiallySensitiveSource(source));
  const value = useActualSource ? source : "https://example.com/data.copc.laz";
  return {
    sourceValue: value,
    expression: "sourceUrl",
    setup: [
      ...(useActualSource
        ? []
        : ["// Replace this placeholder with a browser-readable COPC URL."]),
      `const sourceUrl = ${quote(value)};`,
    ],
  };
}

function buildOptions(
  config: IntegrationCodeConfig,
  sourceValue: string | File,
  mode: "minimal" | "explicit",
): CopcCesiumLayerOptions | CopcThreeLayerOptions {
  if (config.renderer === "three" && config.classificationFilter !== undefined) {
    throw new Error(
      "The installed Three.js layer has no public classification style setter; classification filters can only be generated for Cesium.",
    );
  }

  const explicit = mode === "explicit";
  const maxDepth = config.maxDepth ?? DEFAULTS.maxDepth;
  const maxScreenSpaceError =
    config.maxScreenSpaceError ?? DEFAULTS.maxScreenSpaceError;
  const maxRenderDistanceMeters =
    config.maxRenderDistanceMeters ?? DEFAULTS.maxRenderDistanceMeters;
  const motionLookahead = config.motionLookahead ?? DEFAULTS.motionLookahead;
  const streaming = {
    ...(explicit || config.maxNodes !== DEFAULTS.maxNodes
      ? { maxNodes: config.maxNodes }
      : {}),
    ...(explicit || maxDepth !== DEFAULTS.maxDepth ? { maxDepth } : {}),
    ...(explicit || maxScreenSpaceError !== DEFAULTS.maxScreenSpaceError
      ? { maxScreenSpaceError }
      : {}),
    ...(explicit || maxRenderDistanceMeters !== DEFAULTS.maxRenderDistanceMeters
      ? { maxRenderDistanceMeters }
      : {}),
    ...(explicit || config.refinementAlgorithm !== DEFAULTS.refinementAlgorithm
      ? { refinementAlgorithm: config.refinementAlgorithm }
      : {}),
    ...(explicit || motionLookahead !== DEFAULTS.motionLookahead
      ? { motionLookahead }
      : {}),
  };

  const common = {
    url: sourceValue,
    ...(explicit || config.backend !== DEFAULTS.backend
      ? { backend: config.backend }
      : {}),
    ...(config.renderer === "three" &&
    (explicit || config.colorMode !== DEFAULTS.colorMode)
      ? { colorMode: config.colorMode }
      : {}),
    ...(explicit || config.pointSize !== DEFAULTS.pointSize
      ? { pointSize: config.pointSize }
      : {}),
    ...(explicit || config.maxRenderedPoints !== DEFAULTS.maxRenderedPoints
      ? { maxRenderedPoints: config.maxRenderedPoints }
      : {}),
    ...(explicit || config.maxPointCacheBytes !== DEFAULTS.maxPointCacheBytes
      ? { maxPointCacheBytes: config.maxPointCacheBytes }
      : {}),
    ...(Object.keys(streaming).length > 0 ? { streaming } : {}),
  };

  if (config.renderer === "cesium") {
    const options: CopcCesiumLayerOptions = common;
    return options;
  }
  const options: CopcThreeLayerOptions = common;
  return options;
}

function formatOptions(
  options: CopcCesiumLayerOptions | CopcThreeLayerOptions,
  sourceExpression: string,
): string {
  const lines = Object.entries(options).map(([key, value]) => {
    if (key === "url") return `  url: ${sourceExpression},`;
    if (key === "streaming" && value && typeof value === "object") {
      const streamingLines = Object.entries(value).map(([option, setting]) =>
        typeof setting === "string"
          ? `    ${option}: ${quote(setting)},`
          : `    ${option}: ${String(setting)},`,
      );
      return `  streaming: {\n${streamingLines.join("\n")}\n  },`;
    }
    return typeof value === "string"
      ? `  ${key}: ${quote(value)},`
      : `  ${key}: ${String(value)},`;
  });
  return `const options = {\n${lines.join("\n")}\n}`;
}

function runtimeStyleLines(options: IntegrationCodeOptions): string[] {
  const { config, refinementFocus } = options;
  const lines: string[] = [];
  if (config.renderer === "cesium") {
    const styleProperties: string[] = [];
    if (options.mode === "explicit" || config.colorMode !== DEFAULTS.colorMode) {
      styleProperties.push(`colorMode: ${quote(config.colorMode)}`);
    }
    if (config.classificationFilter !== undefined) {
      styleProperties.push(
        `classificationFilter: ${JSON.stringify(config.classificationFilter)}`,
      );
    }
    if (styleProperties.length > 0) {
      lines.push(`layer.setStyle({ ${styleProperties.join(", ")} });`);
    }
    if (refinementFocus) {
      lines.push(
        `layer.setRefinementFocus({ type: 'screen-circle', center: { x: ${refinementFocus.center.x.toFixed(4)}, y: ${refinementFocus.center.y.toFixed(4)} }, radius: ${refinementFocus.radius.toFixed(4)}, detailBias: ${refinementFocus.detailBias.toFixed(2)} });`,
      );
    }
  }
  return lines;
}

/** Generate a deterministic TypeScript example against the selected public renderer entrypoint. */
export function generateIntegrationCode(options: IntegrationCodeOptions): string {
  const mode = options.mode ?? "minimal";
  const source = resolveCodeSource(options);
  const layerOptions = buildOptions(options.config, source.sourceValue, mode);
  const codeHeader = `// Generated against @frillab/copc-adapter v${options.adapterVersion}.\n`;
  const runtimeStyles = runtimeStyleLines(options);

  if (options.config.renderer === "cesium") {
    const optionType = "CopcCesiumLayerOptions";
    const lines = [
      codeHeader.trimEnd(),
      "import * as Cesium from 'cesium';",
      "import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';",
      `import type { ${optionType} } from '@frillab/copc-adapter/cesium';`,
      "",
      ...source.setup,
      "// Provide an element with this id in your page.",
      "const viewer = new Cesium.Viewer('cesium-container');",
      formatOptions(layerOptions, source.expression) +
        ` satisfies ${optionType};`,
      "const layer = new CopcCesiumLayer(options);",
      "await layer.load();",
      "layer.attachTo(viewer);",
      ...runtimeStyles,
    ];
    return lines.join("\n");
  }

  const optionType = "CopcThreeLayerOptions";
  return [
    codeHeader.trimEnd(),
    "import * as THREE from 'three';",
    "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
    "import { CopcThreeLayer } from '@frillab/copc-adapter/three';",
    `import type { ${optionType} } from '@frillab/copc-adapter/three';`,
    "",
    ...source.setup,
    "const scene = new THREE.Scene();",
    "const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 250_000);",
    "camera.position.set(0, -3_000, 1_200);",
    "camera.lookAt(0, 0, 0);",
    "const renderer = new THREE.WebGLRenderer({ antialias: true });",
    "renderer.setSize(window.innerWidth, window.innerHeight);",
    "document.body.appendChild(renderer.domElement);",
    "const controls = new OrbitControls(camera, renderer.domElement);",
    formatOptions(layerOptions, source.expression) + ` satisfies ${optionType};`,
    "const layer = new CopcThreeLayer(options);",
    "layer.attachTo({ scene, camera, renderer });",
    "await layer.load();",
    "await layer.update();",
    "controls.addEventListener('change', () => { void layer.update(); });",
    "const resize = () => {",
    "  camera.aspect = window.innerWidth / window.innerHeight;",
    "  camera.updateProjectionMatrix();",
    "  renderer.setSize(window.innerWidth, window.innerHeight);",
    "  void layer.update();",
    "};",
    "window.addEventListener('resize', resize);",
    "const render = () => {",
    "  requestAnimationFrame(render);",
    "  controls.update();",
    "  renderer.render(scene, camera);",
    "};",
    "render();",
  ].join("\n");
}
