import type { RefinementFocus } from "@frillab/copc-adapter/cesium";
import type { WorkbenchRenderer } from "../../shared/workbench-config";
import {
  NPM_0_7_1_CAPABILITIES,
  NPM_0_7_1_MANIFEST,
} from "../../shared/schema/index.ts";
import {
  generateAppliedWorkbenchIntegrationCode,
  generateWorkbenchIntegrationCode,
  isPotentiallySensitiveSource,
  type AppliedIntegrationCodeGenerationResult,
  type IntegrationCodeGenerationResult as SharedIntegrationCodeGenerationResult,
  type IntegrationCodeMode,
} from "../../shared/codegen/integrationCode.ts";
import type { WorkbenchConfigurationState } from "../../shared/config/index.ts";
import type { PlaygroundConfig } from "./playgroundConfig";
import type { PlaygroundRefinementConfig } from "./refinementConfig";

export type IntegrationCodeConfig = PlaygroundConfig & {
  readonly refinementConfig: PlaygroundRefinementConfig;
};

export type IntegrationCodeOptions = {
  readonly config: IntegrationCodeConfig;
  readonly source?: string | File;
  readonly includeExactSource?: boolean;
  readonly mode?: IntegrationCodeMode;
  readonly adapterVersion: string;
  readonly refinementFocus?: RefinementFocus;
  /** When present, code comes from `state.applied`; pending values only drive status. */
  readonly appliedState?: WorkbenchConfigurationState;
  readonly appliedAt?: number;
};

export type IntegrationCodeGenerationResult = SharedIntegrationCodeGenerationResult |
  AppliedIntegrationCodeGenerationResult;

export const PLAYGROUND_INSTALL_COMMANDS: Readonly<Record<WorkbenchRenderer, string>> = {
  cesium: `npm install @frillab/copc-adapter@${NPM_0_7_1_MANIFEST.version} cesium@1.146.0`,
  three: `npm install @frillab/copc-adapter@${NPM_0_7_1_MANIFEST.version} three@0.186.1`,
};

export { isPotentiallySensitiveSource };

/** Generate the shared schema-driven example using the verified npm consumer profile. */
export function generateIntegrationCodeResult(
  options: IntegrationCodeOptions,
): IntegrationCodeGenerationResult {
  const config = options.config;
  if (options.appliedState) {
    return generateAppliedWorkbenchIntegrationCode({
      state: options.appliedState,
      ...(options.appliedAt === undefined ? {} : { appliedAt: options.appliedAt }),
      includeExactSource: options.includeExactSource,
      mode: options.mode,
      manifest: NPM_0_7_1_MANIFEST,
      runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
      adapterVersion: options.adapterVersion,
      packageOriginLabel: "verified npm release",
    });
  }
  const values: Record<string, unknown> = {
    ...(config as unknown as Readonly<Record<string, unknown>>),
    ...(config.schemaOptionValues ?? {}),
    "renderer.engine": config.renderer,
    ...(options.refinementFocus === undefined
      ? {}
      : { "streaming.refinementFocus": options.refinementFocus }),
  };
  return generateWorkbenchIntegrationCode({
    renderer: config.renderer,
    values,
    ...(options.source === undefined ? {} : { source: options.source }),
    includeExactSource: options.includeExactSource,
    mode: options.mode,
    manifest: NPM_0_7_1_MANIFEST,
    runtimeCapabilities: NPM_0_7_1_CAPABILITIES,
    adapterVersion: options.adapterVersion,
    packageOriginLabel: "verified npm release",
  });
}

/** Backward-compatible Playground entrypoint used by the existing UI and tests. */
export function generateIntegrationCode(options: IntegrationCodeOptions): string {
  return generateIntegrationCodeResult(options).code;
}
