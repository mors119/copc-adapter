import { OPTION_SCHEMA, isOptionConditionMet } from "./options.ts";
import { ACTION_SCHEMA } from "./actions.ts";
import { getAdapterManifest } from "./manifests.ts";
import type {
  AdapterManifest,
  CapabilityContext,
  SchemaActionDefinition,
  SchemaDefault,
  SchemaOption,
  SchemaChoice,
  SchemaRenderer,
} from "./types.ts";

/** Select options supported by the package, selected renderer, and live host. */
export function getSupportedOptions(
  context: CapabilityContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaOption[] {
  const packageOptions = new Set(context.manifest.supportedOptionIds);
  const excludedForRenderer = new Set(
    context.manifest.unsupportedOptionIdsByRenderer?.[context.renderer] ?? [],
  );
  const packageCapabilities = new Set(context.manifest.capabilities);
  const runtimeCapabilities =
    context.runtimeCapabilities === undefined
      ? undefined
      : new Set(context.runtimeCapabilities);

  return schema.filter((option) => {
    if (!packageOptions.has(option.id) || excludedForRenderer.has(option.id)) {
      return false;
    }
    if (!option.renderers.includes(context.renderer)) return false;
    return (option.requiredCapabilities ?? []).every(
      (capability) =>
        packageCapabilities.has(capability) &&
        (runtimeCapabilities === undefined ||
          runtimeCapabilities.has(capability)),
    );
  });
}

/**
 * Whether an option's configuration dependency is currently met. This is
 * distinct from whether its package/renderer/runtime supports the option.
 */
export function isOptionAvailable(
  option: SchemaOption,
  context: CapabilityContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): boolean {
  if (!getSupportedOptions(context, schema).some(({ id }) => id === option.id)) {
    return false;
  }
  if (!option.availabilityCondition) return true;

  const values = context.values ?? {};
  const dependencyId = option.availabilityCondition.optionId;
  const configuredDependency = values[dependencyId];
  const dependencyValue = configuredDependency !== undefined
    ? configuredDependency
    : resolveOptionDefault(
        dependencyId,
        context.manifest,
        new Set(),
        schema,
        values,
      );
  return dependencyValue === option.availabilityCondition.equals;
}

/** Select supported options whose configuration and visibility conditions hold. */
export function getAvailableOptions(
  context: CapabilityContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaOption[] {
  const supported = new Set(
    getSupportedOptions(context, schema).map(({ id }) => id),
  );
  return schema.filter(
    (option) =>
      supported.has(option.id) &&
      isOptionAvailable(option, context, schema) &&
      isOptionConditionMet(option, context.values, (dependencyId) =>
        resolveOptionDefault(
          dependencyId,
          context.manifest,
          new Set(),
          schema,
          context.values,
        ),
      ),
  );
}

/** Filter enum choices against package and active-runtime capabilities. */
export function getAvailableChoices(
  option: SchemaOption,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaChoice[] {
  if (!getSupportedOptions(context, schema).some(({ id }) => id === option.id)) {
    return [];
  }
  const packageCapabilities = new Set(context.manifest.capabilities);
  const runtimeCapabilities =
    context.runtimeCapabilities === undefined
      ? undefined
      : new Set(context.runtimeCapabilities);
  return (option.choices ?? []).filter((choice) =>
    (choice.requiredCapabilities ?? []).every(
      (capability) =>
        packageCapabilities.has(capability) &&
        (runtimeCapabilities === undefined ||
          runtimeCapabilities.has(capability)),
    ),
  );
}

/** Select host actions supported by the package and its active runtime. */
export function getAvailableActions(
  context: Omit<CapabilityContext, "values">,
): readonly SchemaActionDefinition[] {
  const packageCapabilities = new Set(context.manifest.capabilities);
  const runtimeCapabilities =
    context.runtimeCapabilities === undefined
      ? undefined
      : new Set(context.runtimeCapabilities);
  const actions: readonly SchemaActionDefinition[] = ACTION_SCHEMA;
  return actions.filter(
    (action) =>
      action.renderers.includes(context.renderer) &&
      action.requiredCapabilities.every(
        (capability) =>
          packageCapabilities.has(capability) &&
          (runtimeCapabilities === undefined ||
            runtimeCapabilities.has(capability)),
      ),
  );
}

/** Resolve a renderer-specific apply lifecycle from schema metadata. */
export function getOptionApplyMode(
  option: SchemaOption,
  renderer: SchemaRenderer,
): "host" | "constructor" | "runtime" | "operation" | undefined {
  return typeof option.applyMode === "string"
    ? option.applyMode
    : option.applyMode[renderer];
}

/** Return the package-manifest default entry without conflating omission and null. */
export function getOptionDefault(
  optionId: string,
  manifest: AdapterManifest,
): SchemaDefault | undefined {
  return manifest.defaults[optionId];
}

/**
 * Resolve a concrete or derived default. A derived default uses the effective
 * source value when supplied, and otherwise follows that source's manifest
 * default. Omitted defaults remain undefined so the adapter can derive them.
 */
export function resolveOptionDefault(
  optionId: string,
  manifest: AdapterManifest,
  visiting: ReadonlySet<string> = new Set(),
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  effectiveValues: Readonly<Record<string, unknown>> = {},
): unknown {
  if (visiting.has(optionId)) return undefined;
  const value = getOptionDefault(optionId, manifest);
  if (!value || value.kind === "omitted") return undefined;
  if (value.kind === "value") return value.value;

  const source = schema.find(
    (option) => option.id === value.from || option.statePath === value.from,
  )?.id;
  if (!source) return undefined;
  const effectiveSource = effectiveValues[source];
  const sourceDefault = effectiveSource !== undefined
    ? effectiveSource
    : resolveOptionDefault(
        source,
        manifest,
        new Set([...visiting, optionId]),
        schema,
        effectiveValues,
      );
  if (typeof sourceDefault !== "number" || !Number.isFinite(sourceDefault)) {
    return undefined;
  }
  if (value.operation === "multiply") {
    return sourceDefault * value.factor;
  }
  return undefined;
}

/** True only when an explicit version compatibility profile is known. */
export function isKnownManifest(manifest: AdapterManifest): boolean {
  return getAdapterManifest(manifest.origin, manifest.version) === manifest;
}
