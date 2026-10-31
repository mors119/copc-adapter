import {
  buildSchemaApplicationPlan,
  isWorkbenchConfigurationDirty,
  normalizeWorkbenchOptionValues,
  type WorkbenchConfigurationState,
  type SchemaApplicationPlan,
} from "../config/index.ts";
import {
  getOptionApplyMode,
  getOptionDefault,
  getSupportedOptions,
  isKnownManifest,
  isOptionAvailable,
  resolveOptionDefault,
} from "../schema/capabilities.ts";
import { isOptionConditionMet, OPTION_SCHEMA } from "../schema/options.ts";
import { isNgaEgm2008Grid } from "../workbench/verticalGridResource.ts";
import { NPM_0_7_1_OPACITY_RESET_VALUES } from "../schema/manifests.ts";
import type {
  AdapterManifest,
  CapabilityContext,
  SchemaHostValidators,
  SchemaOption,
  SchemaRenderer,
} from "../schema/types.ts";

export type IntegrationCodeMode = "minimal" | "explicit";

export type IntegrationCodeGenerationOptions = {
  readonly renderer: SchemaRenderer;
  /** Legacy/nested host config or stable schema-ID keyed option values. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly source?: string | Blob;
  readonly includeExactSource?: boolean;
  /** Include the public Cesium Terrain estimate/approval recipe when supported. */
  readonly includeTerrainAlignmentRecipe?: boolean;
  /** Provenance for a Terrain estimate that the user explicitly approved. */
  readonly approvedTerrainAlignment?: {
    readonly residualMeters: number;
    readonly finalHeightOffsetMeters: number;
  };
  readonly mode?: IntegrationCodeMode;
  readonly manifest: AdapterManifest;
  readonly runtimeCapabilities?: readonly string[];
  readonly adapterVersion: string;
  /** Human-readable origin that truthfully identifies npm/workspace/candidate. */
  readonly packageOriginLabel: string;
  /** Host checks for loaded resources represented in the applied snapshot. */
  readonly hostValidators?: SchemaHostValidators;
  readonly schema?: readonly SchemaOption[];
};

export type IntegrationCodeGenerationResult = {
  readonly code: string;
  readonly warnings: readonly string[];
};

export type AppliedIntegrationCodeGenerationOptions = Omit<
  IntegrationCodeGenerationOptions,
  "values" | "source" | "renderer"
> & {
  /** The shared configuration state keeps pending edits separate from applied values. */
  readonly state: WorkbenchConfigurationState;
  /** Time of the last successful apply, when the host tracks it. */
  readonly appliedAt?: number;
};

export type AppliedIntegrationCodeGenerationResult = IntegrationCodeGenerationResult & {
  readonly appliedRevision: number;
  readonly pendingChanges: boolean;
  readonly appliedAt?: number;
};

type CodeExpression = { readonly __integrationCodeExpression: string };
type CodeObject = Record<string, unknown | CodeExpression>;

const PLACEHOLDER_SOURCE = "https://example.com/data.copc.laz";

/** Conservatively flag URLs with credentials, query strings, fragments, or invalid syntax. */
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

function isBlobSource(source: unknown): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

function quote(value: string): string {
  return "'" + value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029") + "'";
}

function isCodeExpression(value: unknown): value is CodeExpression {
  return typeof value === "object" && value !== null &&
    Object.hasOwn(value, "__integrationCodeExpression");
}

function expression(value: string): CodeExpression {
  return { __integrationCodeExpression: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function literal(value: unknown): string {
  if (isCodeExpression(value)) return value.__integrationCodeExpression;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Generated integration values must contain finite numbers.");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "[" + value.map(literal).join(", ") + "]";
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => compareKeys(left, right));
    if (entries.length === 0) return "{}";
    return "{ " + entries.map(([key, entry]) =>
      (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : quote(key)) +
      ": " + literal(entry)
    ).join(", ") + " }";
  }
  throw new TypeError("Generated integration values must be serializable data.");
}

function runtimePatchLiteral(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => key + ": " + literal(entry));
  return "{ " + entries.join(", ") + " }";
}

function renderObject(value: Readonly<Record<string, unknown>>, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const lines = Object.entries(value)
    .sort(([left], [right]) => compareKeys(left, right))
    .map(([key, entry]) => {
      const rendered = isRecord(entry) && !isCodeExpression(entry)
        ? renderObject(entry, depth + 1)
        : literal(entry);
      return childIndent + key + ": " + rendered + ",";
    });
  if (lines.length === 0) return "{}";
  return "{\n" + lines.join("\n") + "\n" + indent + "}";
}

function readPath(target: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = target;
  for (const segment of path.split(".")) {
    if (
      segment === "__proto__" || segment === "prototype" || segment === "constructor" ||
      !isRecord(current) || !Object.hasOwn(current, segment)
    ) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(target: CodeObject, path: string, value: unknown): void {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      !/^[A-Za-z][A-Za-z0-9_]*$/u.test(segment) ||
      segment === "__proto__" || segment === "prototype" || segment === "constructor"
    )
  ) throw new TypeError("The option schema contains an unsafe integration API path.");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) current[segment] = {};
    else if (!isRecord(child) || isCodeExpression(child)) {
      throw new TypeError("Generated options conflict at " + path + ".");
    }
    current = current[segment] as CodeObject;
  }
  current[segments.at(-1)!] = value;
}

function deletePath(target: CodeObject, path: string): void {
  const segments = path.split(".");
  let current: CodeObject = target;
  const parents: { object: CodeObject; key: string }[] = [];
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!isRecord(child) || isCodeExpression(child)) return;
    parents.push({ object: current, key: segment });
    current = child as CodeObject;
  }
  delete current[segments.at(-1)!];
  for (const parent of parents.reverse()) {
    const child = parent.object[parent.key];
    if (isRecord(child) && Object.keys(child).length === 0) delete parent.object[parent.key];
    else break;
  }
}

function cloneOptionTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneOptionTree);
  if (!isRecord(value) || isCodeExpression(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneOptionTree(entry)]),
  );
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => equalValue(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && equalValue(left[key], right[key]),
  );
}

function getSource(values: Readonly<Record<string, unknown>>, explicit?: string | Blob): unknown {
  if (explicit !== undefined) return explicit;
  if (Object.hasOwn(values, "source.url")) return values["source.url"];
  return values.source;
}

function resolveSource(
  sourceValue: unknown,
  includeExactSource: boolean | undefined,
): { readonly source: string | Blob; readonly expression: string; readonly setup: readonly string[] } {
  if (isBlobSource(sourceValue)) {
    return {
      source: sourceValue,
      expression: "sourceFile",
      setup: [
        '// Add <input id="copc-file-input" type="file" accept=".copc.laz"> to your page.',
        "const fileInput = document.querySelector<HTMLInputElement>('#copc-file-input');",
        "const sourceFile = fileInput?.files?.[0];",
        "if (!sourceFile) throw new Error('Choose a COPC file first.');",
      ],
    };
  }
  const source = typeof sourceValue === "string" ? sourceValue : undefined;
  const useActualSource = source !== undefined &&
    (includeExactSource ?? !isPotentiallySensitiveSource(source));
  const safeSource = useActualSource ? source! : PLACEHOLDER_SOURCE;
  return {
    source: safeSource,
    expression: "sourceUrl",
    setup: [
      ...(!useActualSource
        ? ["// Replace this placeholder with a browser-readable COPC URL."]
        : []),
      "const sourceUrl = " + quote(safeSource) + ";",
    ],
  };
}

function assertKnownInputIds(
  values: Readonly<Record<string, unknown>>,
  schema: readonly SchemaOption[],
): void {
  const knownIds = new Set(schema.map(({ id }) => id));
  const schemaOnly = values.schemaOptionValues;
  if (isRecord(schemaOnly)) {
    const unknown = Object.keys(schemaOnly).find((id) => !knownIds.has(id));
    if (unknown) throw new TypeError("Cannot generate code for unregistered option " + unknown + ".");
  }
  for (const id of Object.keys(values)) {
    if (id.includes(".") && !knownIds.has(id)) {
      throw new TypeError("Cannot generate code for unregistered option " + id + ".");
    }
  }
}

function normalizeInputValues(
  input: IntegrationCodeGenerationOptions,
  schema: readonly SchemaOption[],
  source: string | Blob,
): Record<string, unknown> {
  assertKnownInputIds(input.values, schema);
  const values = normalizeWorkbenchOptionValues(input.values, schema);
  const schemaOnly = input.values.schemaOptionValues;
  if (isRecord(schemaOnly)) Object.assign(values, schemaOnly);
  values["renderer.engine"] = input.renderer;
  values["source.url"] = source;
  return values;
}

function fillExplicitDefaults(
  values: Record<string, unknown>,
  context: CapabilityContext,
  schema: readonly SchemaOption[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const currentContext = { ...context, values };
    for (const option of getSupportedOptions(currentContext, schema)) {
      if (
        Object.hasOwn(values, option.id) ||
        !isOptionAvailable(option, currentContext, schema) ||
        !isOptionConditionMet(option, values, (dependencyId) =>
          resolveOptionDefault(dependencyId, context.manifest, new Set(), schema, values)
        )
      ) continue;
      const defaultValue = getOptionDefault(option.id, context.manifest);
      if (defaultValue?.kind === "value") {
        values[option.id] = defaultValue.value;
        changed = true;
      }
    }
  }
}

function removeDefaults(
  options: CodeObject,
  values: Readonly<Record<string, unknown>>,
  context: CapabilityContext,
  schema: readonly SchemaOption[],
): void {
  const fullContext = { ...context, values };
  for (const option of getSupportedOptions(fullContext, schema)) {
    if (getOptionApplyMode(option, context.renderer) !== "constructor") continue;
    if (option.codeGeneration.kind === "none") {
      if (option.apiPath) deletePath(options, option.apiPath);
      continue;
    }
    if (
      option.codeGeneration.kind !== "constructor-option" &&
      option.codeGeneration.kind !== "specialized"
    ) {
      if (option.apiPath) deletePath(options, option.apiPath);
      continue;
    }
    if (!option.apiPath) continue;
    const active = isOptionAvailable(option, fullContext, schema) &&
      isOptionConditionMet(option, values, (dependencyId) =>
        resolveOptionDefault(dependencyId, context.manifest, new Set(), schema, values)
      );
    if (!active || !Object.hasOwn(values, option.id) || values[option.id] === undefined) {
      deletePath(options, option.apiPath);
      continue;
    }
    const defaultValue = resolveOptionDefault(
      option.id, context.manifest, new Set(), schema, values,
    );
    if (defaultValue !== undefined && equalValue(values[option.id], defaultValue)) {
      deletePath(options, option.apiPath);
    }
  }
}

function buildConstructorOptions(
  plan: SchemaApplicationPlan,
  schema: readonly SchemaOption[],
): {
  readonly options: CodeObject;
  readonly imports: readonly string[];
  readonly warnings: readonly string[];
  readonly verticalGridSetup: readonly string[];
} {
  const options = structuredClone(plan.constructorOptions) as CodeObject;
  const imports = new Set<string>();
  const warnings: string[] = [];
  const verticalGridSetup: string[] = [];
  const supported = new Set(
    getSupportedOptions({ manifest: plan.manifest, renderer: plan.renderer }, schema)
      .map(({ id }) => id),
  );

  for (const option of schema) {
    if (!supported.has(option.id) || !option.apiPath) continue;
    if (
      option.codeGeneration.kind === "none" ||
      (option.codeGeneration.kind === "runtime-method" &&
        getOptionApplyMode(option, plan.renderer) === "constructor")
    ) deletePath(options, option.apiPath);
  }

  for (const specialized of plan.specializedOptions) {
    switch (specialized.handler) {
      case "copc-js-extra-dimensions": {
        const option = schema.find(({ id }) => id === specialized.optionId);
        const wildcard = option?.validation.kind === "string-array"
          ? option.validation.wildcard
          : undefined;
        const isSupportedValue = Array.isArray(specialized.value) ||
          (wildcard !== undefined && specialized.value === wildcard);
        if (
          specialized.optionId !== "attributes.extraDimensions" ||
          specialized.apiPath !== "backend.extraDimensions" ||
          !isSupportedValue
        ) {
          throw new TypeError("Extra Dimensions has an invalid public constructor mapping.");
        }
        imports.add("CopcJsBackend");
        setPath(options, "backend", expression(
          "new CopcJsBackend({ extraDimensions: " + literal(specialized.value) + " })",
        ));
        break;
      }
      case "cesium-point-fields": {
        const option = schema.find(({ id }) => id === specialized.optionId);
        const allowed = option?.validation.kind === "string-array"
          ? option.validation.values
          : undefined;
        if (
          plan.renderer !== "cesium" ||
          specialized.optionId !== "attributes.pointFields" ||
          specialized.apiPath !== "pointFields" ||
          !Array.isArray(specialized.value) ||
          !allowed ||
          specialized.value.some((field) => typeof field !== "string" || !allowed.includes(field))
        ) {
          throw new TypeError("Additional standard fields have an invalid public constructor mapping.");
        }
        setPath(options, "pointFields", expression(
          "new Set(" + literal(specialized.value) + " as const)",
        ));
        break;
      }
      case "cesium-point-renderer": {
        if (plan.renderer !== "cesium" || specialized.apiPath !== "renderer") {
          throw new TypeError("The selected point renderer has no supported constructor mapping.");
        }
        if (specialized.value === "point-primitive") {
          deletePath(options, "renderer");
        } else if (specialized.value === "batched-geometry") {
          imports.add("BatchedGeometryPointRenderer");
          setPath(options, "renderer", expression("new BatchedGeometryPointRenderer()"));
        } else {
          throw new TypeError("The selected Cesium point renderer is unavailable in generated code.");
        }
        break;
      }
      case "vertical-grid": {
        if (
          specialized.optionId !== "coordinates.verticalTransform" ||
          specialized.apiPath !== "verticalTransform" ||
          !isNgaEgm2008Grid(specialized.value)
        ) {
          throw new TypeError("The selected vertical grid has no reproducible public loading profile.");
        }
        imports.add("loadNgaEgm2008Grid");
        setPath(
          options,
          "verticalTransform",
          expression("verticalTransform"),
        );
        verticalGridSetup.push(
          "// Obtain the exact extracted NGA EGM2008 2.5-minute WGS 84 Tide-Free file from:",
          "// " + "https://earth-info.nga.mil/index.php?action=geoid&dir=wgs84",
          "// Review the source terms and use a local copy you are authorized to use. This code never downloads or bundles it.",
          "// Add a visible <input id=\"vertical-grid-file\" type=\"file\">; select the local file while this module waits.",
          "const verticalGridInput = document.querySelector<HTMLInputElement>('#vertical-grid-file');",
          "if (!verticalGridInput) throw new Error('Add the vertical-grid-file input before running this code.');",
          "const verticalGridFile = verticalGridInput.files?.[0] ?? await new Promise<File>((resolve, reject) => {",
          "  verticalGridInput.addEventListener('change', () => {",
          "    const file = verticalGridInput.files?.[0];",
          "    if (file) resolve(file);",
          "    else reject(new Error('Choose the local NGA EGM2008 grid file.'));",
          "  }, { once: true });",
          "});",
          "const verticalTransform = await loadNgaEgm2008Grid(verticalGridFile, { maxGridBytes: 160 * 1024 * 1024 });",
          "",
        );
        warnings.push(
          "The applied transform uses the pinned NGA EGM2008 file. Supply the exact locally authorized file; the generated loader verifies its SHA-256 and format before setting verticalTransform.",
        );
        break;
      }
      default:
        throw new TypeError("No integration code handler is registered for " + specialized.handler + ".");
    }
  }
  return { options, imports: [...imports], warnings, verticalGridSetup };
}

function buildRuntimeLines(
  plan: SchemaApplicationPlan,
  values: Readonly<Record<string, unknown>>,
  context: CapabilityContext,
  schema: readonly SchemaOption[],
  mode: IntegrationCodeMode,
): string[] {
  const lines: string[] = [];
  for (const operation of plan.runtimeOperations) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(operation.method)) {
      throw new TypeError("The option schema contains an unsafe runtime method name.");
    }
    const includedIds = operation.optionIds.filter((id) => {
      const option = schema.find((candidate) => candidate.id === id);
      if (
        !option ||
        option.codeGeneration.kind === "none" ||
        option.codeGeneration.kind === "specialized"
      ) return false;
      if (mode === "explicit") return true;
      const defaultValue = resolveOptionDefault(id, context.manifest, new Set(), schema, values);
      return defaultValue === undefined || !equalValue(values[id], defaultValue);
    });
    if (includedIds.length === 0) continue;

    let argument: unknown;
    if (operation.kind === "argument") {
      if (includedIds.length !== 1) {
        throw new TypeError("A runtime operation with multiple settings needs a schema-specific code handler.");
      }
      argument = operation.argument;
    } else {
      const patch: Record<string, unknown> = {};
      for (const id of includedIds) {
        const option = schema.find((candidate) => candidate.id === id)!;
        const property = option.codeGeneration.kind === "runtime-method" &&
          option.codeGeneration.property
          ? option.codeGeneration.property
          : option.apiPath?.split(".").at(-1);
        if (!property) throw new TypeError(option.label + " has no generated runtime payload property.");
        const value = readPath(operation.argument as Readonly<Record<string, unknown>>, property);
        if (value !== undefined || Object.hasOwn(values, id)) patch[property] = value;
      }
      if (Object.keys(patch).length === 0) continue;
      argument = patch;
    }
    if (
      operation.method === "setOpacity" &&
      operation.optionIds.includes("rendering.opacity") &&
      argument === undefined &&
      context.manifest.origin === "npm" &&
      context.manifest.version === "0.7.1"
    ) {
      // The published 0.7.1 setter accepts only a number. Its built-in styles
      // use opaque point colors, with Three's legacy material opacity at 0.9.
      argument = NPM_0_7_1_OPACITY_RESET_VALUES[plan.renderer];
    }
    const renderedArgument = operation.kind === "patch" && isRecord(argument)
      ? runtimePatchLiteral(argument)
      : literal(argument);
    lines.push("layer." + operation.method + "(" + renderedArgument + ");");
  }
  return lines;
}

/** Generate code from an application plan that has already passed shared validation. */
export function generateIntegrationCodeFromPlan(options: {
  readonly plan: SchemaApplicationPlan;
  readonly values: Readonly<Record<string, unknown>>;
  readonly sourceExpression: string;
  readonly sourceSetup?: readonly string[];
  readonly mode?: IntegrationCodeMode;
  readonly includeTerrainAlignmentRecipe?: boolean;
  readonly packageOriginLabel: string;
  readonly adapterVersion: string;
  readonly schema: readonly SchemaOption[];
}): IntegrationCodeGenerationResult {
  const { plan, values, schema } = options;
  const mode = options.mode ?? "minimal";
  const context: CapabilityContext = { manifest: plan.manifest, renderer: plan.renderer };
  const baseOptions = cloneOptionTree(plan.constructorOptions) as CodeObject;
  if (mode === "minimal") removeDefaults(baseOptions, values, context, schema);
  const constructor = buildConstructorOptions(
    { ...plan, constructorOptions: baseOptions },
    schema,
  );
  setPath(constructor.options, "url", expression(options.sourceExpression));
  const typeName = plan.renderer === "cesium" ? "CopcCesiumLayerOptions" : "CopcThreeLayerOptions";
  const importPath = plan.renderer === "cesium"
    ? "@frillab/copc-adapter/cesium"
    : "@frillab/copc-adapter/three";
  const layerName = plan.renderer === "cesium" ? "CopcCesiumLayer" : "CopcThreeLayer";
  const namedImports = [layerName, ...constructor.imports];
  const header = "// Generated against @frillab/copc-adapter v" +
    options.adapterVersion + " (" + options.packageOriginLabel + ").";
  const runtimeLines = buildRuntimeLines(plan, values, context, schema, mode);
  const terrainRecipeLines = options.includeTerrainAlignmentRecipe
    ? [
        "",
        "// Opt-in recipe: call this with an inspected point after explicitly confirming it is ground.",
        "// The attached Cesium Viewer must use a real TerrainProvider; ellipsoid-only sampling is not an estimate.",
        "// The returned number is a final visual heightOffsetMeters value. Recreate the layer with it only after approval.",
        "type TerrainAlignmentAnchor = Parameters<CopcCesiumLayer['estimateTerrainHeightAlignment']>[0];",
        "export async function estimateAndApproveTerrainPlacement(",
        "  anchor: TerrainAlignmentAnchor,",
        "  groundConfirmed: boolean,",
        "): Promise<number | undefined> {",
        "  if (groundConfirmed !== true) throw new Error('Confirm that the selected point represents ground first.');",
        "  const estimate = await layer.estimateTerrainHeightAlignment(anchor, { groundConfirmed });",
        "  if (!layer.isTerrainHeightAlignmentEstimateCurrent(estimate)) throw new Error('The Terrain estimate is stale; estimate again.');",
        "  if (estimate.status !== 'ready' || !estimate.actionable || estimate.effectiveProposedHeightOffsetMeters === undefined || !Number.isFinite(estimate.effectiveProposedHeightOffsetMeters)) {",
        "    throw new Error(estimate.rejectionReason ?? 'The Terrain estimate is unavailable or uncertain.');",
        "  }",
        "  const residualMeters = estimate.proposedOffsetMeters;",
        "  const finalHeightOffsetMeters = estimate.effectiveProposedHeightOffsetMeters;",
        "  const approved = window.confirm(",
        "    `Terrain residual: ${residualMeters?.toFixed(3) ?? 'unavailable'} m\\n` +",
        "    `Final heightOffsetMeters: ${finalHeightOffsetMeters.toFixed(3)} m\\n` +",
        "    'This is visual placement, not geoid or vertical-datum correction. Apply this value?',",
        "  );",
        "  return approved ? finalHeightOffsetMeters : undefined;",
        "}",
      ]
    : [];
  const renderedOptions = "const options = " + renderObject(constructor.options) +
    " satisfies " + typeName + ";";
  const setup = options.sourceSetup ?? [];

  if (plan.renderer === "cesium") {
    return {
      code: [
        header,
        "import * as Cesium from 'cesium';",
        "import { " + namedImports.join(", ") + " } from '" + importPath + "';",
        "import type { " + typeName + " } from '" + importPath + "';",
        "",
        ...constructor.verticalGridSetup,
        ...setup,
        "// Provide an element with this id in your page.",
        "const viewer = new Cesium.Viewer('cesium-container');",
        renderedOptions,
        "const layer = new CopcCesiumLayer(options);",
      "try {",
      "  await layer.load();",
      "  layer.attachTo(viewer);",
      "} catch (error) {",
      "  layer.destroy();",
      "  viewer.destroy();",
      "  throw error;",
      "}",
        ...runtimeLines,
        ...terrainRecipeLines,
        "",
        "function destroyExample(): void {",
        "  window.removeEventListener('beforeunload', destroyExample);",
        "  layer.destroy();",
        "  viewer.destroy();",
        "}",
        "window.addEventListener('beforeunload', destroyExample, { once: true });",
      ].join("\n"),
      warnings: constructor.warnings,
    };
  }

  return {
    code: [
      header,
      "import * as THREE from 'three';",
      "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
      "import { " + namedImports.join(", ") + " } from '" + importPath + "';",
      "import type { " + typeName + " } from '" + importPath + "';",
      "",
      ...constructor.verticalGridSetup,
      ...setup,
      "const scene = new THREE.Scene();",
      "const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 250_000);",
      "camera.position.set(0, -3_000, 1_200);",
      "camera.lookAt(0, 0, 0);",
      "const renderer = new THREE.WebGLRenderer({ antialias: true });",
      "renderer.setSize(window.innerWidth, window.innerHeight);",
      "document.body.appendChild(renderer.domElement);",
      "const controls = new OrbitControls(camera, renderer.domElement);",
      renderedOptions,
      "const layer = new CopcThreeLayer(options);",
      "layer.attachTo({ scene, camera, renderer });",
      "try {",
      "  await layer.load();",
      "  await layer.update();",
      "} catch (error) {",
      "  layer.destroy();",
      "  controls.dispose();",
      "  renderer.dispose();",
      "  renderer.domElement.remove();",
      "  throw error;",
      "}",
      "const updateLayer = () => { void layer.update(); };",
      "controls.addEventListener('change', updateLayer);",
      "const resize = () => {",
      "  camera.aspect = window.innerWidth / window.innerHeight;",
      "  camera.updateProjectionMatrix();",
      "  renderer.setSize(window.innerWidth, window.innerHeight);",
      "  void layer.update();",
      "};",
      "window.addEventListener('resize', resize);",
      "let animationFrame = 0;",
      "let destroyed = false;",
      "const render = () => {",
      "  if (destroyed) return;",
      "  animationFrame = requestAnimationFrame(render);",
      "  controls.update();",
      "  renderer.render(scene, camera);",
      "};",
      "render();",
      ...runtimeLines,
      ...terrainRecipeLines,
      "",
      "function destroyExample(): void {",
      "  destroyed = true;",
      "  window.removeEventListener('beforeunload', destroyExample);",
      "  cancelAnimationFrame(animationFrame);",
      "  controls.removeEventListener('change', updateLayer);",
      "  window.removeEventListener('resize', resize);",
      "  layer.destroy();",
      "  controls.dispose();",
      "  renderer.dispose();",
      "  renderer.domElement.remove();",
      "}",
      "window.addEventListener('beforeunload', destroyExample, { once: true });",
    ].join("\n"),
    warnings: constructor.warnings,
  };
}

/** Generate a TypeScript example from a verified package manifest and option schema. */
export function generateWorkbenchIntegrationCode(
  options: IntegrationCodeGenerationOptions,
): IntegrationCodeGenerationResult {
  const schema = options.schema ?? OPTION_SCHEMA;
  const manifest = options.manifest;
  if (!isKnownManifest(manifest)) {
    throw new TypeError("Integration code requires an explicitly verified package manifest.");
  }
  if (manifest.version !== options.adapterVersion) {
    throw new TypeError(
      "Installed adapter version " + options.adapterVersion +
      " does not match the verified " + manifest.origin + " manifest " + manifest.version + ".",
    );
  }
  const originalSource = getSource(options.values, options.source);
  const sourceSelection = resolveSource(originalSource, options.includeExactSource);
  const mode = options.mode ?? "minimal";
  const values = normalizeInputValues(options, schema, sourceSelection.source);
  const context: CapabilityContext = {
    manifest,
    renderer: options.renderer,
    ...(options.runtimeCapabilities === undefined
      ? {}
      : { runtimeCapabilities: options.runtimeCapabilities }),
  };
  const terrainAlignmentAvailable = options.renderer === "cesium" &&
    (options.runtimeCapabilities ?? manifest.capabilities).includes("cesium.terrain-alignment");
  if (options.includeTerrainAlignmentRecipe && !terrainAlignmentAvailable) {
    throw new TypeError(
      "The verified package and Cesium runtime do not support Terrain alignment code.",
    );
  }
  if (options.approvedTerrainAlignment) {
    const provenance = options.approvedTerrainAlignment;
    const configuredHeightOffset = Object.hasOwn(values, "coordinates.heightOffsetMeters")
      ? values["coordinates.heightOffsetMeters"]
      : resolveOptionDefault(
          "coordinates.heightOffsetMeters",
          manifest,
          new Set(),
          schema,
          values,
        );
    if (
      !terrainAlignmentAvailable ||
      !Number.isFinite(provenance.residualMeters) ||
      !Number.isFinite(provenance.finalHeightOffsetMeters) ||
      !Object.is(configuredHeightOffset, provenance.finalHeightOffsetMeters)
    ) {
      throw new TypeError("Terrain approval provenance must match a supported applied height offset.");
    }
  }
  if (mode === "explicit") fillExplicitDefaults(values, context, schema);
  const supportedIds = new Set(getSupportedOptions(context, schema).map(({ id }) => id));
  if (
    options.renderer === "three" &&
    values["style.classificationFilter"] !== undefined &&
    !supportedIds.has("style.classificationFilter")
  ) {
    throw new Error(
      "The installed Three.js layer has no public classification style setter; classification filters can only be generated for Cesium.",
    );
  }
  const plan = buildSchemaApplicationPlan(
    values,
    context,
    undefined,
    schema,
    options.hostValidators,
  );
  const result = generateIntegrationCodeFromPlan({
    plan,
    values,
    sourceExpression: sourceSelection.expression,
    sourceSetup: sourceSelection.setup,
    mode,
    ...(options.includeTerrainAlignmentRecipe
      ? { includeTerrainAlignmentRecipe: true }
      : {}),
    packageOriginLabel: options.packageOriginLabel,
    adapterVersion: options.adapterVersion,
    schema,
  });
  const warnings = [...result.warnings];
  const code = options.approvedTerrainAlignment
    ? result.code.replace(
        "\n",
        "\n// Terrain placement provenance: the user explicitly approved a Cesium Terrain residual of " +
          literal(options.approvedTerrainAlignment.residualMeters) +
          " m; the final heightOffsetMeters is " +
          literal(options.approvedTerrainAlignment.finalHeightOffsetMeters) +
          " m. This is visual placement, not a geoid or vertical-datum conversion.\n",
      )
    : result.code;
  if (
    typeof originalSource === "string" &&
    isPotentiallySensitiveSource(originalSource) &&
    options.includeExactSource !== true
  ) warnings.unshift("The source could not be verified as public; generated code uses a safe placeholder.");
  return { code, warnings };
}

/**
 * Generate from the last committed Workbench snapshot. Pending values are used
 * only to report whether the visible snippet is behind the editor state.
 */
export function generateAppliedWorkbenchIntegrationCode(
  options: AppliedIntegrationCodeGenerationOptions,
): AppliedIntegrationCodeGenerationResult {
  const applied = options.state.applied;
  const revision = options.state.appliedRevision;
  if (!applied || revision === undefined) {
    throw new TypeError("Integration code is available after a configuration has been successfully applied.");
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("Applied configuration revision must be a non-negative safe integer.");
  }
  if (options.appliedAt !== undefined &&
    (!Number.isFinite(options.appliedAt) || options.appliedAt < 0)) {
    throw new TypeError("Applied timestamp must be a non-negative finite millisecond value.");
  }
  const renderer = applied["renderer.engine"];
  if (renderer !== "cesium" && renderer !== "three") {
    throw new TypeError("Applied configuration has no supported renderer selection.");
  }
  const { state, appliedAt, ...generationOptions } = options;
  const generated = generateWorkbenchIntegrationCode({
    ...generationOptions,
    renderer,
    values: applied,
  });
  return {
    ...generated,
    appliedRevision: revision,
    pendingChanges: isWorkbenchConfigurationDirty(state),
    ...(appliedAt === undefined ? {} : { appliedAt }),
  };
}
