import type { SchemaSpecialControlOptions, SchemaSpecialControl } from "./SchemaOptionPanel.ts";
import {
  getVerticalGridResourceDetails,
  type VerifiedVerticalGrid,
} from "./verticalGridResource.ts";

export type VerticalGridControlOptions = SchemaSpecialControlOptions & {
  /** Load one of the pinned EGM2008 profiles using the host's released API. */
  readonly loadGrid: (file: File) => Promise<VerifiedVerticalGrid>;
  /** Avoid holding a second full-world grid while the current one is active. */
  readonly canLoad: () => boolean;
  /** Distinguish an applied resource from a verified pending selection. */
  readonly isApplied: (value: unknown) => boolean;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Keep a host-level re-enable from starting concurrent full-world grid loads. */
export function canStartVerticalGridLoad(
  loading: boolean,
  canLoad: boolean,
  hasSelectedValue: boolean,
): boolean {
  return !loading && canLoad && !hasSelectedValue;
}

function renderGridDetails(target: HTMLElement, value: unknown): void {
  const details = getVerticalGridResourceDetails(value);
  if (!details) {
    target.replaceChildren();
    return;
  }
  const list = element("dl", "vertical-grid-control__metadata");
  const rows = [
    ["Grid", details.gridId],
    ["Source vertical CRS", details.sourceVerticalCrs],
    ["Target vertical CRS", details.targetVerticalCrs],
    ["Frames", details.verticalFrame],
    ["Horizontal frame", details.horizontalFrame],
    ["Unit and sign", `${details.valueUnit} · ${details.valueConvention}`],
    ["NoData", details.noData],
    ["Interpolation", details.interpolation],
    ["Coverage", details.extent],
    ["Resolution", details.dimensions],
    ["SHA-256", details.sha256],
    ["Memory bound", details.memory],
    ["Epoch", details.epoch],
    ["Source", details.source],
    ["Rights", details.licenseProvenance],
  ] as const;
  for (const [labelText, valueText] of rows) {
    const row = element("div");
    const label = element("dt");
    label.textContent = labelText;
    const text = element("dd");
    text.textContent = valueText;
    row.append(label, text);
    list.append(row);
  }
  target.replaceChildren(list);
}

/** Render explicit local-file selection for the pinned EGM2008 profiles. */
export function mountVerticalGridControl(
  options: VerticalGridControlOptions,
): SchemaSpecialControl {
  const root = element("div", "vertical-grid-control");
  const introduction = element("p", "schema-option__hint");
  introduction.textContent =
    "Optional local EGM2008 conversion (EPSG:3855 to WGS 84 ellipsoidal height, EPSG:4979). Choose the pinned NGA raw file or OSGeo Public Domain GTX; the file is never downloaded or shared.";
  const label = element("label", "vertical-grid-control__file-label");
  label.htmlFor = "vertical-grid-file";
  label.textContent = "Choose an NGA EGM2008 or OSGeo PROJ grid file";
  const fileInput = element("input");
  fileInput.id = "vertical-grid-file";
  fileInput.type = "file";
  fileInput.setAttribute("aria-label", label.textContent);
  const clear = element("button", "schema-action");
  clear.type = "button";
  clear.textContent = "Remove vertical grid";
  const status = element("p", "vertical-grid-control__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element("p", "schema-option__error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const metadata = element("details", "vertical-grid-control__details");
  const summary = element("summary");
  summary.textContent = "Verified grid metadata and provenance";
  const metadataContent = element("div");
  metadata.append(summary, metadataContent);
  root.append(introduction, label, fileInput, clear, status, error, metadata);

  let value = options.value;
  let generation = 0;
  let loading = false;
  let loadingGeneration: number | undefined;
  let loadError = "";

  const refresh = (): void => {
    const selected = value !== undefined && value !== null;
    const gridName = getVerticalGridResourceDetails(value)?.gridId ?? "EGM2008 grid";
    const canLoadAnother = options.canLoad();
    const applied = selected && options.isApplied(value);
    const allowed = canLoadAnother && !selected;
    fileInput.disabled = loading || !allowed;
    clear.disabled = !selected && !loading;
    clear.textContent = loading ? "Discard loading result" : "Remove vertical grid";
    if (loading) {
      status.textContent = "Verifying the local grid in bounded row chunks. The public loader cannot interrupt an active digest; discard will ignore its result when loading finishes.";
    } else if (applied) {
      status.textContent = `${gridName} is verified and applied. Remove and apply that change before selecting a replacement.`;
    } else if (selected) {
      status.textContent = `${gridName} is verified and pending. Apply settings to use it, or remove it before selecting another file.`;
    } else if (!canLoadAnother) {
      status.textContent = "A source load is active or a vertical grid is still applied. Wait for the load, or remove and apply the active grid before selecting a replacement.";
    } else {
      status.textContent = "No vertical grid is applied. Select the exact 149,368,328-byte NGA raw file or 149,333,800-byte OSGeo GTX; SHA-256, CRS and layout are verified before it becomes pending.";
    }
    renderGridDetails(metadataContent, value);
    metadata.hidden = !selected;
    error.textContent = loadError;
    error.hidden = loadError.length === 0;
  };

  const onFileChange = async (): Promise<void> => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (
      !file ||
      !canStartVerticalGridLoad(loading, options.canLoad(), value !== undefined)
    ) return;
    const taskGeneration = ++generation;
    loading = true;
    loadingGeneration = taskGeneration;
    refresh();
    try {
      const grid = await options.loadGrid(file);
      if (taskGeneration !== generation) return;
      value = grid;
      options.onChange(grid);
    } catch (cause) {
      if (taskGeneration !== generation) return;
      loadError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (loadingGeneration === taskGeneration) {
        loading = false;
        loadingGeneration = undefined;
        refresh();
      }
    }
  };

  const onRemove = (): void => {
    if (loading) {
      generation += 1;
      loadError = "";
      status.textContent = "The current result will be discarded after file verification finishes.";
      error.hidden = true;
      return;
    }
    loadError = "";
    value = undefined;
    options.onChange(undefined);
    refresh();
  };

  fileInput.addEventListener("change", onFileChange);
  clear.addEventListener("click", onRemove);
  refresh();

  return {
    element: root,
    setValue(next) {
      value = next;
      loadError = "";
      refresh();
    },
    updateContext() {
      refresh();
    },
    destroy() {
      generation += 1;
      fileInput.removeEventListener("change", onFileChange);
      clear.removeEventListener("click", onRemove);
      root.remove();
    },
  };
}
