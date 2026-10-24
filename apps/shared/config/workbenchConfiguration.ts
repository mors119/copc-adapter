import {
  getOptionApplyMode,
  getSupportedOptions,
  isKnownManifest,
  isOptionAvailable,
  resolveOptionDefault,
} from "../schema/capabilities.ts";
import {
  deserializeSchemaValues,
  serializeSchemaValues,
  type SchemaDeserializationResult,
} from "../schema/serialization.ts";
import { isOptionConditionMet, OPTION_SCHEMA } from "../schema/options.ts";
import {
  validateOptionValue,
  validateSchemaValues,
} from "../schema/validation.ts";
import type {
  AdapterManifest,
  CapabilityContext,
  SchemaHostValidators,
  SchemaOption,
  SchemaRenderer,
} from "../schema/types.ts";

export type WorkbenchOptionValues = Readonly<Record<string, unknown>>;

/**
 * The sole pending/applied configuration snapshot shared by Workbench hosts.
 * Values are keyed by stable schema option ID, not by UI control or API path.
 */
export type WorkbenchConfigurationState = {
  readonly pending: WorkbenchOptionValues;
  readonly applied?: WorkbenchOptionValues;
  readonly pendingRevision: number;
  readonly appliedRevision?: number;
};

export type WorkbenchConfigurationContext = Omit<CapabilityContext, "values">;

export type WorkbenchConfigurationUpdate =
  | {
      readonly ok: true;
      readonly state: WorkbenchConfigurationState;
      readonly errors: readonly [];
    }
  | {
      readonly ok: false;
      readonly state: WorkbenchConfigurationState;
      readonly errors: readonly string[];
    };

export type SchemaRuntimeOperation = {
  readonly method: string;
  readonly kind: "patch" | "argument";
  readonly argument: unknown;
  readonly rollbackArgument: unknown;
  readonly optionIds: readonly string[];
};

export type SchemaSpecializedOption = {
  readonly optionId: string;
  readonly handler: string;
  readonly apiPath?: string;
  readonly value: unknown;
};

export type SchemaApplicationPlan = {
  readonly renderer: SchemaRenderer;
  readonly manifest: AdapterManifest;
  readonly values: WorkbenchOptionValues;
  /** Options built only from supported, active constructor schema entries. */
  readonly constructorOptions: Readonly<Record<string, unknown>>;
  /** Host-owned settings such as the selected renderer. */
  readonly hostOptions: WorkbenchOptionValues;
  /** Explicit specialized settings that require a host-owned constructor path. */
  readonly specializedOptions: readonly SchemaSpecializedOption[];
  readonly runtimeOperations: readonly SchemaRuntimeOperation[];
  readonly changedOptionIds: readonly string[];
  readonly requiresLayerReplacement: boolean;
};

export type WorkbenchConfigurationHost<Runtime extends object> = {
  /** Return the currently active layer/runtime, if one exists. */
  getActiveRuntime(): Runtime | undefined;
  /** Create and prepare a candidate from this validated plan. */
  createRuntime(plan: SchemaApplicationPlan): Promise<Runtime>;
  /** Activate a ready candidate; this callback owns the host's swap/disposal. */
  activateRuntime(candidate: Runtime, previous: Runtime | undefined): void | Promise<void>;
  /** Dispose an unactivated candidate after a failed creation/apply/swap. */
  disposeRuntime(candidate: Runtime): void | Promise<void>;
};

export type WorkbenchApplyResult<Runtime extends object> = {
  readonly state: WorkbenchConfigurationState;
  readonly runtime: Runtime;
  readonly plan: SchemaApplicationPlan;
  readonly replaced: boolean;
};

const MISSING = Symbol("missing-workbench-option");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Clone schema data without cloning host-owned resources such as File/Blob or GTX instances. */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyValue(item)]),
  );
}

function copyValues(values: WorkbenchOptionValues): Record<string, unknown> {
  return copyValue(values) as Record<string, unknown>;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equalValue(item, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && equalValue(left[key], right[key]),
    )
  );
}

function own(values: WorkbenchOptionValues, id: string): boolean {
  return Object.hasOwn(values, id);
}

function resolveContext(
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
): { readonly context?: WorkbenchConfigurationContext; readonly errors: readonly string[] } {
  if (!isKnownManifest(context.manifest)) {
    return { errors: ["Package origin and version do not match a verified Workbench profile."] };
  }
  const rendererOption = schema.find(({ id }) => id === "renderer.engine");
  const requested = own(values, "renderer.engine")
    ? values["renderer.engine"]
    : context.renderer;
  if (
    requested !== "cesium" &&
    requested !== "three"
  ) {
    return { errors: ["Renderer must be Cesium or Three.js."] };
  }
  if (rendererOption && validateOptionValue(rendererOption, requested).length > 0) {
    return { errors: ["Renderer choice is not present in the schema."] };
  }
  const capability = "renderer." + requested;
  if (
    !context.manifest.capabilities.includes(capability) ||
    (context.runtimeCapabilities !== undefined &&
      !context.runtimeCapabilities.includes(capability))
  ) {
    return {
      errors: ["Renderer " + requested + " is unavailable in the active host."],
    };
  }
  return { context: { ...context, renderer: requested }, errors: [] };
}

/**
 * Normalize a legacy flat or nested host config into schema-ID keyed values.
 * Schema IDs win; statePath is canonical, with a leaf-name fallback for the
 * existing flat streaming controls during the migration.
 */
export function normalizeWorkbenchOptionValues(
  values: Readonly<Record<string, unknown>>,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const option of schema) {
    if (own(values, option.id)) {
      normalized[option.id] = copyValue(values[option.id]);
      continue;
    }
    const path = option.statePath.split(".");
    let current: unknown = values;
    let found = true;
    for (const segment of path) {
      if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
        found = false;
        break;
      }
      current = current[segment];
    }
    if (found) {
      normalized[option.id] = copyValue(current);
      continue;
    }
    if (path.length > 1 && own(values, path.at(-1)!)) {
      normalized[option.id] = copyValue(values[path.at(-1)!]);
    }
  }
  return normalized;
}

/** Validate a complete or partial normalized option map for its selected renderer. */
export function validateWorkbenchConfiguration(
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): { readonly context?: WorkbenchConfigurationContext; readonly errors: readonly string[] } {
  const resolved = resolveContext(values, context, schema);
  if (!resolved.context) return resolved;
  return {
    context: resolved.context,
    errors: validateSchemaValues(
      values,
      resolved.context,
      schema,
      hostValidators,
      { requireRequired: false },
    ),
  };
}

export function createWorkbenchConfigurationState(
  pending: WorkbenchOptionValues = {},
  applied?: WorkbenchOptionValues,
): WorkbenchConfigurationState {
  return {
    pending: copyValues(pending),
    ...(applied === undefined ? {} : { applied: copyValues(applied), appliedRevision: 0 }),
    pendingRevision: 0,
  };
}

/** Apply a validated edit atomically; invalid or unsupported edits are rejected. */
export function updateWorkbenchConfiguration(
  state: WorkbenchConfigurationState,
  update: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): WorkbenchConfigurationUpdate {
  const pending = { ...copyValues(state.pending), ...copyValues(update) };
  const validation = validateWorkbenchConfiguration(
    pending,
    context,
    schema,
    hostValidators,
  );
  if (validation.errors.length > 0) {
    return { ok: false, state, errors: validation.errors };
  }
  if (equalValue(pending, state.pending)) {
    return { ok: true, state, errors: [] };
  }
  return {
    ok: true,
    state: { ...state, pending, pendingRevision: state.pendingRevision + 1 },
    errors: [],
  };
}

/** Replace pending values, for example after a safe URL restore. */
export function replaceWorkbenchConfiguration(
  state: WorkbenchConfigurationState,
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): WorkbenchConfigurationUpdate {
  const pending = copyValues(values);
  const validation = validateWorkbenchConfiguration(
    pending,
    context,
    schema,
    hostValidators,
  );
  if (validation.errors.length > 0) {
    return { ok: false, state, errors: validation.errors };
  }
  if (equalValue(pending, state.pending)) {
    return { ok: true, state, errors: [] };
  }
  return {
    ok: true,
    state: { ...state, pending, pendingRevision: state.pendingRevision + 1 },
    errors: [],
  };
}

export function discardWorkbenchPending(
  state: WorkbenchConfigurationState,
): WorkbenchConfigurationState {
  const pending = copyValues(state.applied ?? {});
  if (equalValue(pending, state.pending)) return state;
  return { ...state, pending, pendingRevision: state.pendingRevision + 1 };
}

export function isWorkbenchConfigurationDirty(
  state: WorkbenchConfigurationState,
): boolean {
  return !equalValue(state.pending, state.applied ?? {});
}

export function getChangedWorkbenchOptionIds(
  left: WorkbenchOptionValues,
  right: WorkbenchOptionValues,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly string[] {
  const ids = new Set([
    ...schema.map(({ id }) => id),
    ...Object.keys(left),
    ...Object.keys(right),
  ]);
  return [...ids].filter(
    (id) => own(left, id) !== own(right, id) || !equalValue(left[id], right[id]),
  );
}

function effectiveValue(
  option: SchemaOption,
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
): unknown | typeof MISSING {
  if (own(values, option.id) && values[option.id] !== undefined) {
    return values[option.id];
  }
  const resolved = resolveOptionDefault(
    option.id,
    context.manifest,
    new Set(),
    schema,
    values,
  );
  return resolved === undefined ? MISSING : resolved;
}

function optionIsActive(
  option: SchemaOption,
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
): boolean {
  return (
    isOptionAvailable(option, { ...context, values }, schema) &&
    isOptionConditionMet(option, values, (dependencyId) =>
      resolveOptionDefault(
        dependencyId,
        context.manifest,
        new Set(),
        schema,
        values,
      ),
    )
  );
}

function setApiPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
  option: SchemaOption,
): void {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z][A-Za-z0-9_]*$/u.test(segment) ||
        segment === "__proto__" ||
        segment === "prototype" ||
        segment === "constructor",
    )
  ) {
    throw new TypeError(option.label + " has an unsafe adapter API path.");
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing === undefined) {
      current[segment] = {};
    } else if (!isPlainRecord(existing)) {
      throw new TypeError(
        option.label + " conflicts with another option at API path " + path + ".",
      );
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1)!;
  if (Object.hasOwn(current, leaf) && !equalValue(current[leaf], value)) {
    throw new TypeError(
      option.label + " conflicts with another option at API path " + path + ".",
    );
  }
  current[leaf] = value;
}

function runtimeProperty(option: SchemaOption): string | undefined {
  if (option.codeGeneration.kind === "runtime-method") {
    if (option.codeGeneration.property) return option.codeGeneration.property;
  }
  return option.apiPath?.split(".").at(-1);
}

function runtimeTargetValue(
  option: SchemaOption,
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
): unknown | typeof MISSING {
  if (own(values, option.id)) {
    const explicit = values[option.id];
    if (explicit !== undefined) return explicit;
    if (getOptionApplyMode(option, context.renderer) === "operation") {
      return undefined;
    }
  }
  const value = effectiveValue(option, values, context, schema);
  if (value !== MISSING) return value;
  if (option.nullable) return null;
  if (getOptionApplyMode(option, context.renderer) === "operation") return undefined;
  return MISSING;
}

function buildRuntimeOperations(
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
  previousValues?: WorkbenchOptionValues,
  forceAll = false,
): readonly SchemaRuntimeOperation[] {
  const supported = getSupportedOptions(context, schema);
  const grouped = new Map<
    string,
    { method: string; kind: "patch" | "argument"; argument: Record<string, unknown> | unknown; rollback: Record<string, unknown> | unknown; optionIds: string[] }
  >();

  for (const option of supported) {
    const mode = getOptionApplyMode(option, context.renderer);
    if (mode !== "runtime" && mode !== "operation") continue;
    if (!optionIsActive(option, values, context, schema)) continue;
    if (!option.runtimeMethod) {
      throw new TypeError(option.label + " has no runtime method in its schema.");
    }
    const explicit = own(values, option.id);
    const explicitUndefinedOperation =
      explicit && values[option.id] === undefined && mode === "operation";
    let nextValue: unknown | typeof MISSING;
    let previousValue: unknown | typeof MISSING = MISSING;

    if (forceAll || previousValues === undefined) {
      if (!explicit || (values[option.id] === undefined && !explicitUndefinedOperation)) {
        continue;
      }
      nextValue = explicitUndefinedOperation
        ? undefined
        : values[option.id];
    } else {
      nextValue = runtimeTargetValue(option, values, context, schema);
      previousValue = runtimeTargetValue(option, previousValues, context, schema);
      if (
        nextValue !== MISSING &&
        previousValue !== MISSING &&
        equalValue(nextValue, previousValue)
      ) {
        continue;
      }
      if (nextValue === MISSING && previousValue === MISSING) continue;
      if (nextValue === MISSING) {
        throw new TypeError(
          option.label + " cannot be cleared through its declared runtime API.",
        );
      }
    }

    const key = mode + ":" + option.runtimeMethod;
    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        method: option.runtimeMethod,
        kind: mode === "runtime" ? "patch" : "argument",
        argument: mode === "runtime" ? {} : nextValue,
        rollback: mode === "runtime" ? {} : previousValue === MISSING ? undefined : previousValue,
        optionIds: [],
      };
      grouped.set(key, entry);
    }
    if (mode === "runtime") {
      const property = runtimeProperty(option);
      if (!property) {
        throw new TypeError(option.label + " has no runtime payload property in its schema.");
      }
      (entry.argument as Record<string, unknown>)[property] = nextValue;
      (entry.rollback as Record<string, unknown>)[property] =
        previousValue === MISSING ? undefined : previousValue;
    }
    entry.optionIds.push(option.id);
  }

  return [...grouped.values()].map((entry) => ({
    method: entry.method,
    kind: entry.kind,
    argument: entry.argument,
    rollbackArgument: entry.rollback,
    optionIds: entry.optionIds,
  }));
}

function requiresReplacement(
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  schema: readonly SchemaOption[],
  previousValues: WorkbenchOptionValues | undefined,
  previousContext: WorkbenchConfigurationContext | undefined,
): boolean {
  if (previousValues === undefined || previousContext === undefined) return true;
  if (
    previousContext.renderer !== context.renderer ||
    previousContext.manifest.origin !== context.manifest.origin ||
    previousContext.manifest.version !== context.manifest.version
  ) {
    return true;
  }
  const currentOptions = getSupportedOptions(context, schema);
  const previousOptions = getSupportedOptions(previousContext, schema);
  const previousById = new Map(previousOptions.map((option) => [option.id, option]));
  const allIds = new Set([
    ...currentOptions.map(({ id }) => id),
    ...previousOptions.map(({ id }) => id),
  ]);

  for (const id of allIds) {
    const option = schema.find((candidate) => candidate.id === id);
    if (!option) continue;
    const currentMode = getOptionApplyMode(option, context.renderer);
    const previousMode = getOptionApplyMode(option, previousContext.renderer);
    if (
      currentMode === "runtime" ||
      currentMode === "operation" ||
      previousMode === "runtime" ||
      previousMode === "operation"
    ) {
      continue;
    }
    const currentSupported = currentOptions.some(({ id: currentId }) => currentId === id);
    const previousSupported = previousById.has(id);
    if (currentSupported !== previousSupported) return true;
    if (!currentSupported && !previousSupported) continue;
    const oldValue = effectiveValue(option, previousValues, previousContext, schema);
    const newValue = effectiveValue(option, values, context, schema);
    if (!equalValue(oldValue, newValue)) return true;
  }
  return false;
}

/**
 * Build a validated plan from normalized values. Defaults are used for
 * validation and reset comparisons, but omitted defaults are never materialized
 * into constructor options.
 */
export function buildSchemaApplicationPlan(
  values: WorkbenchOptionValues,
  context: WorkbenchConfigurationContext,
  previousValues?: WorkbenchOptionValues,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): SchemaApplicationPlan {
  const validation = validateWorkbenchConfiguration(
    values,
    context,
    schema,
    hostValidators,
  );
  if (!validation.context) {
    throw new TypeError("Invalid Workbench configuration: " + validation.errors.join(" "));
  }
  if (validation.errors.length > 0) {
    throw new TypeError("Invalid Workbench configuration: " + validation.errors.join(" "));
  }
  const activeContext = validation.context;
  const previousResolved = previousValues === undefined
    ? undefined
    : resolveContext(previousValues, context, schema);
  if (previousResolved && !previousResolved.context) {
    throw new TypeError("Invalid applied Workbench configuration: " + previousResolved.errors.join(" "));
  }
  const previousContext = previousResolved?.context;
  const replacement = requiresReplacement(
    values,
    activeContext,
    schema,
    previousValues,
    previousContext,
  );
  const constructorOptions: Record<string, unknown> = {};
  const hostOptions: Record<string, unknown> = {};
  const specializedOptions: SchemaSpecializedOption[] = [];

  for (const option of getSupportedOptions(activeContext, schema)) {
    if (!own(values, option.id) || values[option.id] === undefined) continue;
    if (!optionIsActive(option, values, activeContext, schema)) continue;
    const mode = getOptionApplyMode(option, activeContext.renderer);
    if (mode === "host") {
      hostOptions[option.id] = values[option.id];
      continue;
    }
    if (mode !== "constructor") continue;
    if (option.codeGeneration.kind === "specialized") {
      specializedOptions.push({
        optionId: option.id,
        handler: option.codeGeneration.handler,
        ...(option.apiPath ? { apiPath: option.apiPath } : {}),
        value: values[option.id],
      });
      continue;
    }
    if (!option.apiPath) {
      throw new TypeError(option.label + " has no constructor API path in its schema.");
    }
    setApiPath(constructorOptions, option.apiPath, values[option.id], option);
  }

  const runtimeOperations = buildRuntimeOperations(
    values,
    activeContext,
    schema,
    previousValues,
    replacement,
  );
  const changedOptionIds = previousValues === undefined
    ? [...new Set([...schema.map(({ id }) => id), ...Object.keys(values)])]
        .filter((id) => own(values, id))
    : getChangedWorkbenchOptionIds(previousValues, values, schema);

  return {
    renderer: activeContext.renderer,
    manifest: activeContext.manifest,
    values: copyValues(values),
    constructorOptions,
    hostOptions,
    specializedOptions,
    runtimeOperations,
    changedOptionIds,
    requiresLayerReplacement: replacement,
  };
}

function invokeRuntimeOperation(
  runtime: object,
  operation: SchemaRuntimeOperation,
  argument: unknown,
): void | Promise<void> {
  const method = (runtime as Record<string, unknown>)[operation.method];
  if (typeof method !== "function") {
    throw new TypeError("Active adapter runtime does not implement " + operation.method + ".");
  }
  return (method as (value: unknown) => void | Promise<void>).call(runtime, argument);
}

/** Apply runtime operations in order and restore the previous values if one fails. */
export async function applySchemaRuntimeOperations(
  runtime: object,
  operations: readonly SchemaRuntimeOperation[],
): Promise<void> {
  const attempted: SchemaRuntimeOperation[] = [];
  try {
    for (const operation of operations) {
      attempted.push(operation);
      await invokeRuntimeOperation(runtime, operation, operation.argument);
    }
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const operation of attempted.reverse()) {
      try {
        await invokeRuntimeOperation(runtime, operation, operation.rollbackArgument);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    const error = new Error(
      rollbackErrors.length === 0
        ? "Runtime configuration failed and previous values were restored."
        : "Runtime configuration failed and one or more previous values could not be restored.",
      { cause },
    );
    Object.assign(error, { rollbackErrors });
    throw error;
  }
}

function commitApplied(
  state: WorkbenchConfigurationState,
  values: WorkbenchOptionValues,
  revision: number,
): WorkbenchConfigurationState {
  return {
    ...state,
    applied: copyValues(values),
    appliedRevision: revision,
  };
}

/**
 * Execute a validated plan. Constructor/host changes build a candidate and
 * commit it only after runtime operations and host activation succeed. Runtime
 * only changes reuse the active layer and roll back failed setter sequences.
 */
export async function applyWorkbenchConfiguration<Runtime extends object>(
  state: WorkbenchConfigurationState,
  context: WorkbenchConfigurationContext,
  host: WorkbenchConfigurationHost<Runtime>,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): Promise<WorkbenchApplyResult<Runtime>> {
  const pendingSnapshot = copyValues(state.pending);
  const revision = state.pendingRevision;
  const validation = validateWorkbenchConfiguration(
    pendingSnapshot,
    context,
    schema,
    hostValidators,
  );
  if (!validation.context) {
    throw new TypeError("Invalid Workbench configuration: " + validation.errors.join(" "));
  }
  if (validation.errors.length > 0) {
    throw new TypeError("Invalid Workbench configuration: " + validation.errors.join(" "));
  }
  const plan = buildSchemaApplicationPlan(
    pendingSnapshot,
    context,
    state.applied,
    schema,
    hostValidators,
  );
  const active = host.getActiveRuntime();
  const replace = active === undefined || state.applied === undefined || plan.requiresLayerReplacement;

  if (replace) {
    const candidatePlan = state.applied === undefined
      ? plan
      : buildSchemaApplicationPlan(
          pendingSnapshot,
          context,
          undefined,
          schema,
          hostValidators,
        );
    const candidate = await host.createRuntime(candidatePlan);
    let activated = false;
    try {
      await applySchemaRuntimeOperations(candidate, candidatePlan.runtimeOperations);
      await host.activateRuntime(candidate, active);
      activated = true;
    } finally {
      if (!activated) await host.disposeRuntime(candidate);
    }
    return {
      state: commitApplied(state, pendingSnapshot, revision),
      runtime: candidate,
      plan: candidatePlan,
      replaced: true,
    };
  }

  await applySchemaRuntimeOperations(active, plan.runtimeOperations);
  return {
    state: commitApplied(state, pendingSnapshot, revision),
    runtime: active,
    plan,
    replaced: false,
  };
}

/** Serialize either pending or successfully applied normalized values safely. */
export function serializeWorkbenchConfiguration(
  state: WorkbenchConfigurationState,
  context: WorkbenchConfigurationContext,
  target: "pending" | "applied" = "pending",
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): URLSearchParams {
  const values = target === "pending" ? state.pending : state.applied;
  if (values === undefined) {
    throw new TypeError("No applied Workbench configuration is available to share.");
  }
  const validation = validateWorkbenchConfiguration(values, context, schema, hostValidators);
  if (!validation.context || validation.errors.length > 0) {
    throw new TypeError(
      "Cannot share invalid Workbench configuration: " +
        (validation.errors.join(" ") || "renderer context is unavailable."),
    );
  }
  return serializeSchemaValues(values, validation.context, schema, hostValidators);
}

/** Restore share state through the same schema and capability rules as application. */
export function restoreWorkbenchConfiguration(
  params: URLSearchParams,
  context: WorkbenchConfigurationContext,
  baseValues: WorkbenchOptionValues = {},
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): SchemaDeserializationResult {
  return deserializeSchemaValues(params, context, baseValues, schema, hostValidators);
}
