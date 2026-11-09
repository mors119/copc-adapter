const DISMISSED_KEY = "copc-adapter-playground.quick-start-dismissed.v1";

/**
 * A small, non-modal guide that stays in the scrollable Source panel rather
 * than covering the viewer or intercepting Probe/Load interactions.
 */
export function mountQuickStartGuide(sourcePanel: HTMLElement): { destroy(): void } {
  const sourceControl = sourcePanel.querySelector('label[for="remote-source"]');
  if (!sourceControl) throw new Error("Missing Playground source selector.");

  const root = document.createElement("section");
  root.className = "quick-start-guide";
  root.setAttribute("aria-label", "Quick start help");
  root.innerHTML = [
    '<button id="quick-start-toggle" class="quick-start-toggle" type="button" aria-controls="quick-start-content" aria-expanded="false">Quick start <span aria-hidden="true">?</span></button>',
    '<div id="quick-start-content" class="quick-start-card" role="region" aria-labelledby="quick-start-title" hidden>',
    '  <div class="quick-start-heading">',
    '    <strong id="quick-start-title">Getting started</strong>',
    '    <button id="quick-start-close" class="quick-start-close" type="button" aria-label="Close quick start guide">Close</button>',
    '  </div>',
    '  <ol class="quick-start-steps">',
    '    <li><strong>Choose a source</strong><span>Select a sample dataset or enter a COPC URL.</span></li>',
    '    <li><strong>Probe source</strong><span>Check browser access, HTTP Range, and COPC metadata. A probe does not guarantee loading will succeed.</span></li>',
    '    <li><strong>Load source</strong><span>Start streaming and viewing the point cloud.</span></li>',
    '  </ol>',
    '  <p class="quick-start-note">Local COPC file? Choose or drop it to load directly — no HTTP Probe needed.</p>',
    '  <p class="quick-start-note">After loading, use <strong>Apply changes</strong> for pending settings.</p>',
    '  <div class="quick-start-actions">',
    '    <label for="quick-start-hide"><input id="quick-start-hide" type="checkbox" checked> Don\'t show again</label>',
    '    <button id="quick-start-done" class="quick-start-done" type="button">Got it</button>',
    '  </div>',
    '</div>',
  ].join("\n");
  sourcePanel.insertBefore(root, sourceControl);

  const toggle = root.querySelector<HTMLButtonElement>("#quick-start-toggle")!;
  const card = root.querySelector<HTMLElement>("#quick-start-content")!;
  const close = root.querySelector<HTMLButtonElement>("#quick-start-close")!;
  const done = root.querySelector<HTMLButtonElement>("#quick-start-done")!;
  const optOut = root.querySelector<HTMLInputElement>("#quick-start-hide")!;

  const setOpen = (open: boolean): void => {
    card.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  const dismiss = (restoreFocus: boolean): void => {
    try {
      if (optOut.checked) window.localStorage.setItem(DISMISSED_KEY, "1");
      else window.localStorage.removeItem(DISMISSED_KEY);
    } catch {
      // The guide remains usable when browser storage is unavailable.
    }
    setOpen(false);
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", () => {
    if (card.hidden) setOpen(true);
    else dismiss(false);
  });
  close.addEventListener("click", () => dismiss(true));
  done.addEventListener("click", () => dismiss(true));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || card.hidden) return;
    event.preventDefault();
    dismiss(true);
  };
  document.addEventListener("keydown", onKeyDown);

  let previouslyDismissed = false;
  try {
    previouslyDismissed = window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // A blocked storage API must not break the Playground.
  }
  setOpen(!previouslyDismissed);

  return {
    destroy(): void {
      document.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
