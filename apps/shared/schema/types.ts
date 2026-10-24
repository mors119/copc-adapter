/** Renderer names understood by the shared Workbench schema. */
export type SchemaRenderer = "cesium" | "three";

/** Configuration sections used for shared panel grouping. */
export type SchemaSection =
  | "source"
  | "renderer"
  | "backend"
  | "style"
  | "streaming"
  | "lod"
  | "focus"
  | "filtering"
  | "attributes"
  | "coordinates"
  | "performance"
  | "cache"
  | "interaction";

/** Semantic value kinds supported by generic and specialized controls. */
export type SchemaValueType =
  | "input-source"
  | "enum"
  | "string-array"
  | "number"
  | "integer"
  | "boolean"
  | "classification-filter"
  | "focus-lens"
  | "vertical-grid";

/** Control renderers registered by the shared Workbench. */
export type SchemaControl =
  | "source"
  | "renderer"
  | "select"
  | "attribute-selection"
  | "number"
  | "toggle"
  | "classification-filter"
  | "focus-lens"
  | "vertical-grid"
  | "cesium-renderer"
  | "action"
  | "terrain-alignment";

export type SchemaApplyMode =
  | "host"
  | "constructor"
  | "runtime"
  | "operation";

export type SchemaValidation =
  | {
      readonly kind: "source";
    }
  | {
      readonly kind: "enum";
    }
  | {
      readonly kind: "string-array";
      readonly wildcard?: string;
    }
  | {
      readonly kind: "number";
      readonly finite: true;
      readonly minimum?: number;
      readonly minimumExclusive?: boolean;
      readonly maximum?: number;
      readonly maximumExclusive?: boolean;
    }
  | {
      readonly kind: "boolean";
    }
  | {
      readonly kind: "classification-filter";
      readonly itemMinimum: 0;
      readonly itemMaximum: 255;
    }
  | {
      readonly kind: "focus-lens";
    }
  | {
      readonly kind: "vertical-grid";
    };

export type SchemaCodeGeneration =
  | {
      readonly kind: "constructor-option";
    }
  | {
      readonly kind: "runtime-method";
      readonly property?: string;
    }
  | {
      readonly kind: "specialized";
      readonly handler: string;
    }
  | {
      readonly kind: "none";
    };

export type SchemaSerialization =
  | {
      readonly kind: "scalar";
      readonly key: string;
    }
  | {
      readonly kind: "classification-filter";
      readonly includeKey: string;
      readonly excludeKey: string;
    }
  | {
      readonly kind: "focus-lens";
      readonly keys: Readonly<{
        centerX: string;
        centerY: string;
        radius: string;
        detailBias: string;
      }>;
    }
  | {
      readonly kind: "string-array";
      readonly key: string;
    }
  | {
      readonly kind: "none";
    };

export type SchemaChoice = {
  readonly value: string;
  readonly label: string;
  readonly requiredCapabilities?: readonly string[];
};

export type SchemaCondition = {
  readonly optionId: string;
  readonly equals: string | number | boolean;
};

export type SchemaCrossFieldConstraint = {
  readonly kind: "less-than-or-equal";
  readonly otherOptionId: string;
};

export type SchemaProfileKey = string;

/** One user-facing setting, its adapter mapping, and host capability contract. */
export type SchemaOption = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly section: SchemaSection;
  /** Dot path in normalized Workbench state. */
  readonly statePath: string;
  /** Public constructor or style path; omitted for host-owned settings. */
  readonly apiPath?: string;
  readonly valueType: SchemaValueType;
  readonly control: SchemaControl;
  readonly choices?: readonly SchemaChoice[];
  readonly validation: SchemaValidation;
  readonly constraints?: readonly SchemaCrossFieldConstraint[];
  readonly optional?: boolean;
  /** Null is distinct from omission when an adapter API uses null to clear state. */
  readonly nullable?: boolean;
  readonly renderers: readonly SchemaRenderer[];
  readonly requiredCapabilities?: readonly string[];
  readonly condition?: SchemaCondition;
  /** Unlike a visibility condition, this condition makes the value unsupported. */
  readonly availabilityCondition?: SchemaCondition;
  readonly stability: "stable" | "experimental";
  readonly applyMode:
    | SchemaApplyMode
    | Readonly<Partial<Record<SchemaRenderer, SchemaApplyMode>>>;
  readonly runtimeMethod?: string;
  readonly codeGeneration: SchemaCodeGeneration;
  readonly serialization: SchemaSerialization;
  /** Explicit defaults keyed by verified package origin and version. */
  readonly defaults: Readonly<Partial<Record<SchemaProfileKey, SchemaDefault>>>;
};

/** A shared Workbench action backed by an adapter or host capability. */
export type SchemaActionDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly section: SchemaSection;
  readonly control: "action" | "terrain-alignment";
  readonly renderers: readonly SchemaRenderer[];
  readonly requiredCapabilities: readonly string[];
  readonly stability: "stable" | "experimental";
};

export type SchemaDefault =
  | {
      readonly kind: "value";
      readonly value: unknown;
    }
  | {
      /** Preserve the adapter's own default by omitting this option. */
      readonly kind: "omitted";
    }
  | {
      /** A documented default derived from another adapter option. */
      readonly kind: "derived";
      readonly from: string;
      readonly operation: "multiply";
      readonly factor: number;
    };

/** Package provenance is part of capability resolution, not inferred from a label. */
export type PackageOrigin = "npm" | "workspace";

export type AdapterManifest = {
  readonly origin: PackageOrigin;
  readonly version: string;
  readonly supportedOptionIds: readonly string[];
  readonly capabilities: readonly string[];
  readonly defaults: Readonly<Record<string, SchemaDefault>>;
};

export type CapabilityContext = {
  readonly manifest: AdapterManifest;
  readonly renderer: SchemaRenderer;
  /** Capabilities reported by the active host/renderer instance. */
  readonly runtimeCapabilities?: readonly string[];
  readonly values?: Readonly<Record<string, unknown>>;
};
