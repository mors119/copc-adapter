import {
  getPointInspectionRows,
  type PointInspectionData,
  type PointInspectionRow,
} from "./pointFormatting.ts";
import "./pointPopover.css";

/** Client-space coordinates reported by a host renderer's projection adapter. */
export type PointScreenPosition = Readonly<{ x: number; y: number }>;

export type PointPopover = {
  setSelection(
    point: PointInspectionData | undefined,
    position?: PointScreenPosition,
  ): void;
  updatePosition(position?: PointScreenPosition): void;
  clear(): void;
  destroy(): void;
};

function createRows(rows: readonly PointInspectionRow[]): HTMLDListElement {
  const list = document.createElement("dl");
  for (const row of rows) {
    const term = document.createElement("dt");
    term.textContent = row.label;
    const value = document.createElement("dd");
    value.textContent = row.value;
    list.append(term, value);
  }
  return list;
}

/** Mount a shared point summary and DOM-only selection marker over a viewport. */
export function mountPointPopover(host: HTMLElement): PointPopover {
  const overlay = document.createElement("div");
  overlay.className = "point-inspection-overlay";
  overlay.setAttribute("aria-hidden", "true");

  const highlight = document.createElement("div");
  highlight.className = "point-selection-highlight";
  highlight.dataset.pointHighlight = "";
  highlight.setAttribute("aria-hidden", "true");

  const popover = document.createElement("section");
  popover.className = "point-popover";
  popover.dataset.pointPopover = "";
  popover.setAttribute("role", "region");
  popover.setAttribute("aria-label", "Selected point details");
  popover.hidden = true;

  const header = document.createElement("header");
  header.className = "point-popover__header";
  const title = document.createElement("h2");
  title.textContent = "Selected point";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "point-popover__close";
  close.setAttribute("aria-label", "Close point details");
  close.textContent = "×";
  header.append(title, close);

  const summary = document.createElement("div");
  summary.className = "point-popover__summary";
  summary.dataset.pointPopoverSummary = "";
  summary.setAttribute("aria-live", "polite");

  const details = document.createElement("details");
  details.className = "point-popover__details";
  details.dataset.pointPopoverDetails = "";
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "More point data";
  const detailsContent = document.createElement("div");
  details.append(detailsSummary, detailsContent);
  popover.append(header, summary, details);
  overlay.append(highlight, popover);
  host.append(overlay);

  let selectedPoint: PointInspectionData | undefined;
  let screenPosition: PointScreenPosition | undefined;
  let dismissed = false;
  let overlayVisible = false;

  const setOverlayVisible = (visible: boolean): void => {
    if (overlayVisible === visible) return;
    overlayVisible = visible;
    overlay.setAttribute("aria-hidden", String(!visible));
    highlight.hidden = !visible;
    popover.hidden = !visible;
  };

  const positionOverlay = (): void => {
    if (!selectedPoint || dismissed || !screenPosition) {
      setOverlayVisible(false);
      return;
    }
    if (!Number.isFinite(screenPosition.x) || !Number.isFinite(screenPosition.y)) {
      setOverlayVisible(false);
      return;
    }

    const hostBounds = host.getBoundingClientRect();
    const width = host.clientWidth;
    const height = host.clientHeight;
    const x = screenPosition.x - hostBounds.left;
    const y = screenPosition.y - hostBounds.top;
    if (
      width <= 0 ||
      height <= 0 ||
      x < 0 ||
      y < 0 ||
      x > width ||
      y > height
    ) {
      setOverlayVisible(false);
      return;
    }

    setOverlayVisible(true);
    const highlightLeft = `${x}px`;
    const highlightTop = `${y}px`;
    if (highlight.style.left !== highlightLeft) highlight.style.left = highlightLeft;
    if (highlight.style.top !== highlightTop) highlight.style.top = highlightTop;
    const margin = 8;
    const gap = 14;
    const panelBounds = popover.getBoundingClientRect();
    const panelWidth = panelBounds.width;
    const panelHeight = panelBounds.height;
    let left = x + gap;
    if (left + panelWidth > width - margin) left = x - gap - panelWidth;
    left = Math.min(Math.max(margin, left), Math.max(margin, width - panelWidth - margin));

    const above = y - gap - panelHeight;
    const below = y + gap;
    let top = above >= margin ? above : below;
    if (top + panelHeight > height - margin) top = above;
    top = Math.min(Math.max(margin, top), Math.max(margin, height - panelHeight - margin));
    const popoverLeft = `${left}px`;
    const popoverTop = `${top}px`;
    if (popover.style.left !== popoverLeft) popover.style.left = popoverLeft;
    if (popover.style.top !== popoverTop) popover.style.top = popoverTop;
  };

  const closePopover = (): void => {
    dismissed = true;
    setOverlayVisible(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !selectedPoint || dismissed) return;
    event.preventDefault();
    event.stopPropagation();
    closePopover();
  };
  const onResize = (): void => positionOverlay();
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(onResize);
  resizeObserver?.observe(host);
  resizeObserver?.observe(popover);
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKeyDown);
  close.addEventListener("click", closePopover);

  const clear = (): void => {
    selectedPoint = undefined;
    screenPosition = undefined;
    dismissed = false;
    setOverlayVisible(false);
    summary.replaceChildren();
    detailsContent.replaceChildren();
    details.hidden = true;
    details.open = false;
  };

  return {
    setSelection(point, position): void {
      if (!point) {
        clear();
        return;
      }
      selectedPoint = point;
      screenPosition = position;
      dismissed = false;
      const rows = getPointInspectionRows(point);
      summary.replaceChildren(createRows(rows.summary));
      detailsContent.replaceChildren(createRows(rows.details));
      details.hidden = rows.details.length === 0;
      details.open = false;
      positionOverlay();
    },
    updatePosition(position): void {
      screenPosition = position;
      positionOverlay();
    },
    clear,
    destroy(): void {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      close.removeEventListener("click", closePopover);
      overlay.remove();
      selectedPoint = undefined;
      screenPosition = undefined;
    },
  };
}
