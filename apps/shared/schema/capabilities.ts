import { OPTION_SCHEMA, getOptionDefinition, isOptionConditionMet } from "./options.ts";
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

/** Select options supported by the exact package and capability context. */
export function getSupportedOptions(
  context: CapabilityContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaOption[] {
  const packageOptions = new Set(context.manifest.supportedOptionIds);
  const packageCapabilities = new Set(context.manifest.capabilities);
  const runtimeCapabilities =
    context.runtimeCapabilities === undefined
      ? undefined
      : new Set(context.runtimeCapabilities);
  const values = context.values;
  return schema.filter((option) => {
    if (!packageOptions.has(option.id)) return false;
    if (!option.renderers.includes(context.renderer)) return false;
    if (
      option.availabilityCondition &&
      values !== undefined &&
      (values[option.availabilityCondition.optionId] ??
        resolveOptionDefault(
          option.availabilityCondition.optionId,
          context.manifest,
        )) !== option.availabilityCondition.equals
    ) {
      return false;
    }

    return (option.requiredCapabilities ?? []).every(
      (capability) =>
        packageCapabilities.has(capability) &&
        (runtimeCapabilities === undefined ||
          runtimeCapabilities.has(capability)),
    );
  });
}

/** Select supported options whose schema visibility condition is currently met. */
export function getAvailableOptions(
  context: CapabilityContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaOption[] {
  const supported = new Set(
    getSupportedOptions(context, schema).map(({ id }) => id),
  );
  const values = context.values ?? {};
  return schema.filter(
    (option) =>
      supported.has(option.id) && isOptionConditionMet(option, values),
  );
}

/** Filter enum choices whose runtime capability is not currently present. */
export function getAvailableChoices(
  option: SchemaOption,
  context: Omit<CapabilityContext, "values">,
): readonly SchemaChoice[] {
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
 * Resolve a concrete or derived default. An omitted or absent default remains
 * undefined, matching the adapter's own omission semantics.
 */
export function resolveOptionDefault(
  optionId: string,
  manifest: AdapterManifest,
  visiting: ReadonlySet<string> = new Set(),
): unknown {
  if (visiting.has(optionId)) return undefined;
  const value = getOptionDefault(optionId, manifest);
  if (!value || value.kind === "omitted") return undefined;
  if (value.kind === "value") return value.value;

  const source =
    getOptionDefinition(value.from)?.id ??
    OPTION_SCHEMA.find((option) => option.statePath === value.from)?.id;
  if (!source) return undefined;
  const sourceDefault = resolveOptionDefault(
    source,
    manifest,
    new Set([...visiting, optionId]),
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
