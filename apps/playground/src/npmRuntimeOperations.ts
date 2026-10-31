import type { CopcThreeLayer } from "@frillab/copc-adapter/three";
import {
  applySchemaRuntimeOperations,
  type SchemaRuntimeOperation,
} from "../../shared/config/workbenchConfiguration.ts";
import {
  NPM_0_7_1_OPACITY_RESET_VALUES,
} from "../../shared/schema/manifests.ts";
import type { WorkbenchRenderer } from "../../shared/workbench-config.ts";

type NpmRuntimeOperationLayer = object & Pick<CopcThreeLayer, "setOpacity">;

export function setNpmRuntimeOpacity(
  layer: Pick<CopcThreeLayer, "setOpacity">,
  renderer: WorkbenchRenderer,
  opacity: number | undefined,
): void {
  layer.setOpacity(opacity ?? NPM_0_7_1_OPACITY_RESET_VALUES[renderer]);
}

/** Apply the pinned package's runtime operations, translating its numeric-only opacity reset API. */
export async function applyNpmRuntimeOperations(
  layer: NpmRuntimeOperationLayer,
  renderer: WorkbenchRenderer,
  operations: readonly SchemaRuntimeOperation[],
): Promise<void> {
  const runtime = new Proxy(layer, {
    get(target, property) {
      if (property === "setOpacity") {
        return (opacity: number | undefined) =>
          setNpmRuntimeOpacity(layer, renderer, opacity);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await applySchemaRuntimeOperations(runtime, operations);
}
