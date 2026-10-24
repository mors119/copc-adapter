/** Type-level utilities used by the consuming apps to check schema/API drift. */
export type SchemaConstructorPaths<
  Options,
  Renderer extends string,
  Manifest = undefined,
> = Options extends {
  readonly id: infer Id extends string;
  readonly renderers: infer Renderers extends readonly string[];
  readonly apiPath: infer Path extends string;
  readonly codeGeneration:
    | { readonly kind: "constructor-option" }
    | { readonly kind: "specialized"; readonly handler: string };
}
  ? Id extends "attributes.extraDimensions"
    ? never
    : Renderer extends Renderers[number]
    ? Manifest extends {
        readonly supportedOptionIds: readonly (infer SupportedId extends string)[];
      }
      ? Id extends SupportedId
        ? Id extends RendererExclusions<Manifest, Renderer>
          ? never
          : Path
        : never
      : Path
      : never
  : never;

type RendererExclusions<Manifest, Renderer extends string> =
  Manifest extends {
    readonly unsupportedOptionIdsByRenderer?: infer ByRenderer;
  }
    ? Renderer extends keyof NonNullable<ByRenderer>
      ? NonNullable<ByRenderer>[Renderer] extends readonly (infer Id extends string)[]
        ? Id
        : never
      : never
    : never;

type PathExists<Value, Path extends string> = Path extends `${infer Key}.${infer Rest}`
  ? Key extends keyof NonNullable<Value>
    ? PathExists<NonNullable<Value>[Key], Rest>
    : false
  : Path extends keyof NonNullable<Value>
    ? true
    : false;

export type MissingPublicPaths<Value, Paths extends string> = Paths extends unknown
  ? PathExists<Value, Paths> extends true
    ? never
    : Paths
  : never;

export type Assert<T extends true> = T;
export type AssertNoMissingPublicPaths<Value, Paths extends string> = [
  MissingPublicPaths<Value, Paths>,
] extends [never]
  ? true
  : false;

type PublicPathValue<Value, Path extends string> = Path extends `${infer Key}.${infer Rest}`
  ? Key extends keyof NonNullable<Value>
    ? PublicPathValue<NonNullable<Value>[Key], Rest>
    : never
  : Path extends keyof NonNullable<Value>
    ? NonNullable<Value>[Path]
    : never;

type ValueDefaultMismatch<
  Id extends string,
  Defaults,
  Profile extends string,
  ApiOptions,
  ApiPath extends string,
> = Profile extends keyof Defaults
  ? Defaults[Profile] extends {
      readonly kind: "value";
      readonly value: infer DefaultValue;
    }
    ? [PublicPathValue<ApiOptions, ApiPath>] extends [never]
      ? Id
      : [DefaultValue] extends [Exclude<PublicPathValue<ApiOptions, ApiPath>, undefined>]
        ? never
        : Id
    : never
  : never;

/** Option IDs whose explicit profile defaults do not fit the actual API types. */
export type IncompatibleSchemaDefaultIds<
  Options,
  Renderer extends string,
  Manifest,
  ApiOptions,
  Profile extends string,
> = Options extends {
  readonly id: infer Id extends string;
  readonly renderers: infer Renderers extends readonly string[];
  readonly apiPath: infer ApiPath extends string;
  readonly defaults: infer Defaults;
  readonly codeGeneration: infer CodeGeneration;
}
  ? Renderer extends Renderers[number]
    ? Manifest extends {
        readonly supportedOptionIds: readonly (infer SupportedId extends string)[];
      }
      ? Id extends SupportedId
        ? Id extends RendererExclusions<Manifest, Renderer>
          ? never
          : CodeGeneration extends { readonly kind: "specialized" }
            ? never
            : ValueDefaultMismatch<Id, Defaults, Profile, ApiOptions, ApiPath>
        : never
      : never
    : never
  : never;

export type AssertNoIncompatibleSchemaDefaults<
  Options,
  Renderer extends string,
  Manifest,
  ApiOptions,
  Profile extends string,
> = [
  IncompatibleSchemaDefaultIds<Options, Renderer, Manifest, ApiOptions, Profile>,
] extends [never]
  ? true
  : false;
