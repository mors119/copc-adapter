import {
  buildSchemaApplicationPlan,
  normalizeWorkbenchOptionValues,
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
import type {
  AdapterManifest,
  CapabilityContext,
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
  readonly mode?: IntegrationCodeMode;
  readonly manifest: AdapterManifest;
  readonly runtimeCapabilities?: readonly string[];
  readonly adapterVersion: string;
  /** Human-readable origin that truthfully identifies npm/workspace/candidate. */
  readonly packageOriginLabel: string;
  readonly schema?: readonly SchemaOption[];
};

export type IntegrationCodeGenerationResult = {
  readonly code: string;
  readonly warnings: readonly string[];
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
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return "{ " + entries.map(([key, entry]) =>
      (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : quote(key)) +
      ": " + literal(entry)
    ).join(", ") + " }";
  }
  throw new TypeError("Generated integration values must be serializable data.");
}

function runtimePatchLiteral(value: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(value).map(([key, entry]) => {
    return key + ": " + literal(entry);
  });
  return "{ " + entries.join(", ") + " }";
}

function renderObject(value: Readonly<Record<string, unknown>>, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const lines = Object.entries(value).map(([key, entry]) => {
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
): { readonly options: CodeObject; readonly imports: readonly string[]; readonly warnings: readonly string[] } {
  const options = structuredClone(plan.constructorOptions) as CodeObject;
  const imports = new Set<string>();
  const warnings: string[] = [];
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
        if (specialized.apiPath !== "backend.extraDimensions" || !Array.isArray(specialized.value)) {
          throw new TypeError("Extra Dimensions has an invalid public constructor mapping.");
        }
        imports.add("CopcJsBackend");
        setPath(options, "backend", expression(
          "new CopcJsBackend({ extraDimensions: " + literal(specialized.value) + " })",
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
      case "vertical-grid":
        warnings.push(
          "A verified GTX grid is active. The grid resource is host-owned and was not embedded; load the same validated GtxGeoidGrid and pass it as verticalTransform in your application.",
        );
        break;
      default:
        throw new TypeError("No integration code handler is registered for " + specialized.handler + ".");
    }
  }
  return { options, imports: [...imports], warnings };
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
        ...setup,
        "// Provide an element with this id in your page.",
        "const viewer = new Cesium.Viewer('cesium-container');",
        renderedOptions,
        "const layer = new CopcCesiumLayer(options);",
        "await layer.load();",
        "layer.attachTo(viewer);",
        ...runtimeLines,
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
      ...runtimeLines,
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
  const plan = buildSchemaApplicationPlan(values, context, undefined, schema);
  const result = generateIntegrationCodeFromPlan({
    plan,
    values,
    sourceExpression: sourceSelection.expression,
    sourceSetup: sourceSelection.setup,
    mode,
    packageOriginLabel: options.packageOriginLabel,
    adapterVersion: options.adapterVersion,
    schema,
  });
  const warnings = [...result.warnings];
  if (
    typeof originalSource === "string" &&
    isPotentiallySensitiveSource(originalSource) &&
    options.includeExactSource !== true
  ) warnings.unshift("The source could not be verified as public; generated code uses a safe placeholder.");
  return { code: result.code, warnings };
}
