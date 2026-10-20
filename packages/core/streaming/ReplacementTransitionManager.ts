import type { PreparedPointData } from "../copc/types/copc";
import type { CopcPointRenderer } from "./renderer";
import type {
  StreamingReplacementGroup,
  StreamingReplacementKind,
} from "./types";

/** Counts describing visible-node coverage transitions. */
export type ReplacementTransitionDiagnostics = {
  activeReplacementGroupCount: number;
  replacementGroupsWaitingCount: number;
  refinementReplacementCommitCount: number;
  collapseReplacementCommitCount: number;
  staleReplacementCancellationCount: number;
  coarseNodesRetainedForCoverageCount: number;
};

type ActiveReplacementGroup = StreamingReplacementGroup & {
  generation: number;
  viewGeneration: number;
};

type ReplacementTransitionRenderer = Pick<
  CopcPointRenderer,
  | "getRenderedNodeKeys"
  | "getRenderedPointCount"
  | "getRenderedNodePointCount"
  | "hasNode"
>;

type ReplacementTransitionManagerOptions = {
  renderer: ReplacementTransitionRenderer;
  getHierarchyNodePointCount: (nodeKey: string) => number | undefined;
  removeNode: (nodeKey: string) => void;
};

function createDiagnostics(): ReplacementTransitionDiagnostics {
  return {
    activeReplacementGroupCount: 0,
    replacementGroupsWaitingCount: 0,
    refinementReplacementCommitCount: 0,
    collapseReplacementCommitCount: 0,
    staleReplacementCancellationCount: 0,
    coarseNodesRetainedForCoverageCount: 0,
  };
}

/** Owns renderer-neutral node coverage replacement state and diagnostics. */
export class ReplacementTransitionManager {
  private readonly options: ReplacementTransitionManagerOptions;
  private readonly activeGroups = new Map<string, ActiveReplacementGroup>();
  private generation = 0;
  private diagnostics = createDiagnostics();

  constructor(options: ReplacementTransitionManagerOptions) {
    this.options = options;
  }

  /** Return a detached copy of transition diagnostics for the layer snapshot. */
  getDiagnostics(): ReplacementTransitionDiagnostics {
    return { ...this.diagnostics };
  }

  /** Reconcile the desired streaming coverage with currently rendered nodes. */
  reconcile(
    replacementGroups: readonly StreamingReplacementGroup[],
    generation: number,
    selectedNodeKeys: readonly string[],
    viewGeneration: number,
  ): void {
    if (this.generation === generation) {
      return;
    }

    const previousGroups = [...this.activeGroups.values()];
    const stagedNodeKeys = new Set(
      previousGroups.flatMap((group) => group.newNodeKeys),
    );
    for (const nodeKey of stagedNodeKeys) {
      if (!selectedNodeKeys.includes(nodeKey)) {
        this.options.removeNode(nodeKey);
      }
    }
    if (previousGroups.length > 0) {
      this.diagnostics.staleReplacementCancellationCount += 1;
    }
    this.activeGroups.clear();
    this.generation = generation;

    const desiredNodeKeys = new Set(selectedNodeKeys);
    const renderedOldNodeKeys = this.options.renderer
      .getRenderedNodeKeys()
      .filter((nodeKey) => !desiredNodeKeys.has(nodeKey));
    const desiredNewNodeKeys = [...desiredNodeKeys]
      .filter((nodeKey) => !this.options.renderer.hasNode(nodeKey))
      .sort();
    if (renderedOldNodeKeys.length > 0 && desiredNewNodeKeys.length === 0) {
      for (const nodeKey of renderedOldNodeKeys) {
        this.options.removeNode(nodeKey);
      }
    }

    const incomingOldNodeKeys = new Set(
      replacementGroups.flatMap((group) => group.oldNodeKeys),
    );
    const incomingNewNodeKeys = new Set(
      replacementGroups.flatMap((group) => group.newNodeKeys),
    );
    const groupsCoverRenderer =
      renderedOldNodeKeys.every((nodeKey) =>
        incomingOldNodeKeys.has(nodeKey),
      ) &&
      desiredNewNodeKeys.every((nodeKey) => incomingNewNodeKeys.has(nodeKey));
    const groups =
      renderedOldNodeKeys.length > 0 &&
      desiredNewNodeKeys.length > 0 &&
      !groupsCoverRenderer
        ? [
            {
              kind: this.inferReplacementKind(replacementGroups),
              oldNodeKeys: renderedOldNodeKeys,
              newNodeKeys: desiredNewNodeKeys,
            },
          ]
        : replacementGroups;

    for (const group of groups) {
      if (group.newNodeKeys.length === 0) {
        continue;
      }
      this.activeGroups.set(this.getGroupKey(group), {
        ...group,
        oldNodeKeys: [...group.oldNodeKeys].sort(),
        newNodeKeys: [...group.newNodeKeys].sort(),
        generation,
        viewGeneration,
      });
    }
  }

  /** Check whether a rendered node remains as old coverage during replacement. */
  isReplacementOldNode(nodeKey: string): boolean {
    return [...this.activeGroups.values()].some((group) =>
      group.oldNodeKeys.includes(nodeKey),
    );
  }

  /** Estimate point usage after replacing active old coverage with one new node. */
  getProjectedPointCount(nodeKey: string, pointCount: number): number {
    let projectedPointCount = this.options.renderer.getRenderedPointCount();
    const replacedNodeKeys = new Set(
      [...this.activeGroups.values()].flatMap((group) => group.oldNodeKeys),
    );
    for (const oldNodeKey of replacedNodeKeys) {
      if (!this.options.renderer.hasNode(oldNodeKey)) {
        continue;
      }
      projectedPointCount -=
        this.options.renderer.getRenderedNodePointCount?.(oldNodeKey) ??
        this.options.getHierarchyNodePointCount(oldNodeKey) ??
        0;
    }
    if (!this.options.renderer.hasNode(nodeKey)) {
      projectedPointCount += pointCount;
    }
    return projectedPointCount;
  }

  /** Commit groups once all of their new coverage is rendered. */
  commitReady(generation: number): void {
    for (const [groupKey, group] of [...this.activeGroups.entries()]) {
      if (
        group.generation !== generation ||
        !group.newNodeKeys.every((nodeKey) =>
          this.options.renderer.hasNode(nodeKey),
        )
      ) {
        continue;
      }

      for (const oldNodeKey of group.oldNodeKeys) {
        this.options.removeNode(oldNodeKey);
      }
      this.activeGroups.delete(groupKey);
      if (group.kind === "refinement") {
        this.diagnostics.refinementReplacementCommitCount += 1;
      } else if (group.kind === "collapse") {
        this.diagnostics.collapseReplacementCommitCount += 1;
      }
    }
  }

  /** Refresh coverage counters after renderer progress has been applied. */
  updateDiagnostics(): void {
    this.diagnostics.activeReplacementGroupCount = this.activeGroups.size;
    this.diagnostics.replacementGroupsWaitingCount = [
      ...this.activeGroups.values(),
    ].filter(
      (group) =>
        !group.newNodeKeys.every((nodeKey) =>
          this.options.renderer.hasNode(nodeKey),
        ),
    ).length;
    this.diagnostics.coarseNodesRetainedForCoverageCount = [
      ...this.activeGroups.values(),
    ]
      .filter((group) => group.kind === "refinement")
      .flatMap((group) => group.oldNodeKeys)
      .filter((nodeKey) => this.options.renderer.hasNode(nodeKey)).length;
  }

  /** Reset transition state and counters when a source or attachment is cleared. */
  reset(): void {
    this.activeGroups.clear();
    this.generation = 0;
    this.diagnostics = createDiagnostics();
  }

  /** Check whether one view's selected nodes have all been committed. */
  isViewRendererCommitted(
    selectedNodeKeys: readonly string[],
    readyPointBuffers: ReadonlyMap<string, PreparedPointData>,
    viewGeneration: number,
  ): boolean {
    if (
      [...this.activeGroups.values()].some(
        (group) => group.viewGeneration === viewGeneration,
      )
    ) {
      return false;
    }
    return selectedNodeKeys.every((nodeKey) => {
      if (this.options.renderer.hasNode(nodeKey)) {
        return true;
      }
      const readyPoints = readyPointBuffers.get(nodeKey);
      return readyPoints === undefined || readyPoints.pointCount === 0;
    });
  }

  private inferReplacementKind(
    groups: readonly StreamingReplacementGroup[],
  ): StreamingReplacementKind {
    return groups.length === 1 ? groups[0].kind : "retarget";
  }

  private getGroupKey(group: StreamingReplacementGroup): string {
    return `${group.kind}:${[...group.oldNodeKeys].sort().join(",")}->${[...group.newNodeKeys].sort().join(",")}`;
  }
}
