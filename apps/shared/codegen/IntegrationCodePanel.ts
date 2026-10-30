import { isPotentiallySensitiveSource } from "./integrationCode.ts";

export type IntegrationCodePanelState = {
  readonly mode: "minimal" | "explicit";
  readonly includeExactSource: boolean;
  readonly includeShareSource: boolean;
  readonly includeTerrainAlignmentRecipe: boolean;
};

export type IntegrationCodePanelContent = {
  readonly code: string;
  readonly source?: string | Blob;
  /** The visible snippet contains a sensitive source from the last successful generation. */
  readonly sensitiveSourceIncluded?: boolean;
  readonly warnings?: readonly string[];
  readonly installCommand?: string;
  readonly appliedStatus?: IntegrationCodeAppliedStatus;
};

export type IntegrationCodeAppliedStatus = {
  readonly revision: number;
  readonly pendingChanges: boolean;
  /** The latest applied state could not be rendered, so the visible snippet is older. */
  readonly codeOutOfDate?: boolean;
  /** Unix timestamp in milliseconds for the last successful Apply. */
  readonly appliedAt?: number;
};

export type IntegrationCodePanelController = {
  setContent(content: IntegrationCodePanelContent): void;
  setAppliedStatus(status: IntegrationCodeAppliedStatus): void;
  setTerrainAlignmentRecipeAvailable(available: boolean): void;
  setStatus(message: string): void;
  setSourcePrivacySelection(
    source: string | Blob | undefined,
    includeExactSource: boolean,
    includeShareSource?: boolean,
  ): void;
  getState(): IntegrationCodePanelState;
  destroy(): void;
};

function isLocalSource(source: unknown): source is Blob {
  return typeof Blob !== "undefined" && source instanceof Blob;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied
    ? Promise.resolve()
    : Promise.reject(new Error("Clipboard access is unavailable."));
}

/** Keep a visible last-good snippet when a later generation attempt fails. */
export function preserveLastSuccessfulIntegrationCode(
  previous: IntegrationCodePanelContent,
  next: IntegrationCodePanelContent,
): IntegrationCodePanelContent {
  if (next.code.trim() !== "" || !next.warnings?.length || !previous.code) {
    return next;
  }
  return {
    ...previous,
    appliedStatus: previous.appliedStatus
      ? { ...previous.appliedStatus, codeOutOfDate: true }
      : undefined,
    warnings: [
      "A new snippet could not be generated. The previous successful snippet is unchanged.",
      ...(next.warnings ?? []),
    ],
  };
}

export function canCopyIntegrationCode(
  content: IntegrationCodePanelContent,
  includeExactSource: boolean,
): boolean {
  return content.code.trim() !== "" &&
    !(content.sensitiveSourceIncluded === true && !includeExactSource);
}

function formatCodeAge(appliedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - appliedAt) / 1000));
  if (seconds < 60) return "applied just now";
  if (seconds < 60 * 60) return "applied " + Math.floor(seconds / 60) + " min ago";
  if (seconds < 24 * 60 * 60) return "applied " + Math.floor(seconds / 3600) + " hr ago";
  return "applied " + new Date(appliedAt).toLocaleString();
}

function assertAppliedStatus(status: IntegrationCodeAppliedStatus): void {
  if (!Number.isSafeInteger(status.revision) || status.revision < 0) {
    throw new TypeError("Applied code revision must be a non-negative safe integer.");
  }
  if (status.appliedAt !== undefined &&
    (!Number.isFinite(status.appliedAt) || status.appliedAt < 0)) {
    throw new TypeError("Applied code timestamp must be a non-negative finite millisecond value.");
  }
}

/** Mount the shared Code tab controls and privacy/copy behavior in either app. */
export function mountIntegrationCodePanel(options: {
  readonly target: HTMLElement;
  readonly summary: string;
  readonly intro?: string;
  readonly installLabel?: string;
  readonly onStateChange?: (state: IntegrationCodePanelState) => void;
  readonly createShareLink?: (includeSource: boolean) => string;
}): IntegrationCodePanelController {
  const panel = document.createElement("details");
  panel.className = "code-card generated-code-card integration-code-panel";
  panel.open = true;
  panel.innerHTML = [
    "<summary><span>Generated code</span><span class=\"summary-state\"></span></summary>",
    "<p class=\"generated-code-intro\"></p>",
    "<div class=\"generated-code-toolbar\">",
    "  <div class=\"code-mode-control\" role=\"group\" aria-label=\"Code detail\">",
    "    <button id=\"code-mode-minimal\" type=\"button\" aria-pressed=\"true\">Minimal</button>",
    "    <button id=\"code-mode-explicit\" type=\"button\" aria-pressed=\"false\">Explicit</button>",
    "  </div>",
    "  <label class=\"share-option terrain-alignment-recipe-option\" id=\"terrain-alignment-recipe-option\" for=\"include-terrain-alignment-recipe\" hidden>",
    "    <input id=\"include-terrain-alignment-recipe\" type=\"checkbox\">",
    "    Include Terrain estimate and approval recipe",
    "  </label>",
    "  <button id=\"copy-code\" type=\"button\">Copy code</button>",
    "</div>",
    "<label class=\"share-option\" id=\"exact-source-option\" for=\"include-exact-source\">",
    "  <input id=\"include-exact-source\" type=\"checkbox\" checked>",
    "  Include the active source URL in code",
    "</label>",
    "<p class=\"source-privacy-warning\" id=\"source-code-warning\" role=\"status\" aria-live=\"polite\" hidden></p>",
    "<p class=\"integration-code-warning\" id=\"integration-code-warning\" role=\"status\" aria-live=\"polite\" hidden></p>",
    "<pre><code id=\"integration-example\"></code></pre>",
    "<div class=\"install-guidance\">",
    "  <span id=\"install-guidance-label\"></span>",
    "  <code id=\"install-command\"></code>",
    "  <button id=\"copy-install\" type=\"button\">Copy install command</button>",
    "</div>",
    "<div class=\"share-toolbar\">",
    "  <label class=\"share-option\" id=\"share-source-option\" for=\"include-share-source\">",
    "    <input id=\"include-share-source\" type=\"checkbox\">",
    "    Include source URL in share link",
    "  </label>",
    "  <button id=\"copy-share-link\" type=\"button\">Copy share link</button>",
    "</div>",
    "<p class=\"source-privacy-warning\" id=\"source-share-warning\" role=\"status\" aria-live=\"polite\" hidden></p>",
    "<p class=\"share-status\" id=\"share-status\" role=\"status\" aria-live=\"polite\"></p>",
  ].join("\n");
  const get = <T extends HTMLElement>(id: string): T => {
    const element = panel.querySelector<T>("#" + id);
    if (!element) throw new Error("The shared Code panel is missing #" + id + ".");
    return element;
  };
  const summary = panel.querySelector<HTMLElement>(".summary-state")!;
  const intro = panel.querySelector<HTMLElement>(".generated-code-intro")!;
  const modeMinimal = get<HTMLButtonElement>("code-mode-minimal");
  const modeExplicit = get<HTMLButtonElement>("code-mode-explicit");
  const exactSourceInput = get<HTMLInputElement>("include-exact-source");
  const shareSourceInput = get<HTMLInputElement>("include-share-source");
  const terrainRecipeInput = get<HTMLInputElement>("include-terrain-alignment-recipe");
  const terrainRecipeOption = get<HTMLLabelElement>("terrain-alignment-recipe-option");
  const exactSourceOption = get<HTMLLabelElement>("exact-source-option");
  const shareSourceOption = get<HTMLLabelElement>("share-source-option");
  const sourceCodeWarning = get<HTMLElement>("source-code-warning");
  const sourceShareWarning = get<HTMLElement>("source-share-warning");
  const codeWarning = get<HTMLElement>("integration-code-warning");
  const codeElement = get<HTMLElement>("integration-example");
  const installCommand = get<HTMLElement>("install-command");
  const installLabel = get<HTMLElement>("install-guidance-label");
  const installGuidance = panel.querySelector<HTMLElement>(".install-guidance")!;
  const copyCodeButton = get<HTMLButtonElement>("copy-code");
  const copyInstallButton = get<HTMLButtonElement>("copy-install");
  const copyShareButton = get<HTMLButtonElement>("copy-share-link");
  const status = get<HTMLElement>("share-status");
  let content: IntegrationCodePanelContent = { code: "" };
  let mode: IntegrationCodePanelState["mode"] = "minimal";
  let appliedStatus: IntegrationCodeAppliedStatus | undefined;
  let disposed = false;
  const timers = new Set<number>();
  let ageTimer: number | undefined;

  summary.textContent = options.summary;
  intro.textContent = options.intro ??
    "Copy a runnable starting point for the last successfully applied settings.";
  installLabel.textContent = options.installLabel ?? "Install for this renderer";
  if (!options.createShareLink) {
    shareSourceOption.hidden = true;
    copyShareButton.hidden = true;
  }
  options.target.replaceChildren(panel);

  const state = (): IntegrationCodePanelState => ({
    mode,
    includeExactSource: exactSourceInput.checked,
    includeShareSource: shareSourceInput.checked,
    includeTerrainAlignmentRecipe: terrainRecipeInput.checked,
  });
  const notifyStateChange = (): void => options.onStateChange?.(state());
  const syncSourceControls = (): void => {
    const source = content.source;
    const hasSource = source !== undefined;
    const local = isLocalSource(source);
    const sensitive = typeof source === "string" && isPotentiallySensitiveSource(source);
    const sensitiveSourceRetained = content.sensitiveSourceIncluded === true;
    const sourceIsHttpUrl = (): boolean => {
      if (typeof source !== "string") return false;
      try {
        const protocol = new URL(source).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    };
    exactSourceOption.hidden = !hasSource || local;
    exactSourceInput.disabled = !hasSource || local;
    if (!hasSource || local) exactSourceInput.checked = false;
    sourceCodeWarning.hidden = !sensitive && !sensitiveSourceRetained;
    sourceCodeWarning.textContent = sensitiveSourceRetained
      ? exactSourceInput.checked
        ? "The visible snippet contains an exact sensitive source from its last successful generation. Copying requires confirmation."
        : "The retained snippet still contains an exact sensitive source. Copy is disabled until a placeholder version is generated."
      : sensitive
        ? sourceIsHttpUrl()
          ? exactSourceInput.checked
            ? "This URL contains credentials, query parameters, or a fragment. The visible snippet includes it; copying requires confirmation."
            : "This URL may contain credentials or tokens. The snippet uses a placeholder; enable the checkbox above to reveal and copy the exact URL."
          : exactSourceInput.checked
            ? "This source could not be verified as public. The visible snippet includes it; copying requires confirmation."
            : "This source could not be verified as public. The snippet uses a placeholder; enable the checkbox above to reveal and copy the exact value."
        : "";
    copyCodeButton.disabled = !canCopyIntegrationCode(content, exactSourceInput.checked);

    shareSourceOption.hidden = !hasSource;
    shareSourceInput.disabled = !hasSource || local || sensitive;
    if (shareSourceInput.disabled) shareSourceInput.checked = false;
    sourceShareWarning.hidden = !hasSource || (!local && !sensitive);
    sourceShareWarning.textContent = local
      ? "A local File or Blob cannot be serialized into a share link; the link will contain settings only."
      : sensitive
        ? sourceIsHttpUrl()
          ? "This URL may contain credentials or tokens, so it cannot be included in a share link."
          : "This source could contain private path data, so it cannot be included in a share link."
        : "";
  };
  const updateModeButtons = (): void => {
    modeMinimal.setAttribute("aria-pressed", String(mode === "minimal"));
    modeExplicit.setAttribute("aria-pressed", String(mode === "explicit"));
  };
  const updateAppliedStatus = (): void => {
    const details = appliedStatus
      ? [
          "Applied #" + appliedStatus.revision,
          appliedStatus.codeOutOfDate
            ? "previous snippet shown"
            : appliedStatus.pendingChanges
              ? "pending edits"
              : "up to date",
          ...(appliedStatus.appliedAt === undefined
            ? []
            : [formatCodeAge(appliedStatus.appliedAt)]),
        ]
      : [];
    summary.textContent = [options.summary, ...details].join(" · ");
  };
  const syncAppliedAgeTimer = (): void => {
    if (ageTimer !== undefined) {
      window.clearInterval(ageTimer);
      ageTimer = undefined;
    }
    if (appliedStatus?.appliedAt !== undefined) {
      ageTimer = window.setInterval(updateAppliedStatus, 30_000);
    }
  };
  const setContent = (next: IntegrationCodePanelContent): void => {
    const nextContent = preserveLastSuccessfulIntegrationCode(content, next);
    if (nextContent.appliedStatus) assertAppliedStatus(nextContent.appliedStatus);
    content = nextContent;
    appliedStatus = content.appliedStatus;
    codeElement.textContent = content.code;
    copyCodeButton.disabled = content.code.trim() === "";
    codeWarning.hidden = !content.warnings?.length;
    codeWarning.textContent = content.warnings?.join(" ") ?? "";
    if (content.installCommand) {
      installGuidance.hidden = false;
      installCommand.textContent = content.installCommand;
      copyInstallButton.hidden = false;
    } else {
      installGuidance.hidden = true;
      installCommand.textContent = "";
      copyInstallButton.hidden = true;
    }
    syncSourceControls();
    updateModeButtons();
    updateAppliedStatus();
    syncAppliedAgeTimer();
  };
  const setStatus = (message: string): void => {
    status.textContent = message;
  };
  const copyWithFeedback = async (
    button: HTMLButtonElement,
    value: string,
    success: string,
    label: string,
  ): Promise<void> => {
    try {
      await copyText(value);
      button.textContent = "Copied";
      setStatus(success);
    } catch {
      button.textContent = "Copy failed";
      setStatus("Copy failed. Select the visible text and copy it manually.");
    }
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      if (!disposed) button.textContent = label;
    }, 1800);
    timers.add(timer);
  };
  const onModeMinimal = (): void => {
    mode = "minimal";
    updateModeButtons();
    notifyStateChange();
  };
  const onModeExplicit = (): void => {
    mode = "explicit";
    updateModeButtons();
    notifyStateChange();
  };
  const onExactSourceChange = (): void => {
    syncSourceControls();
    notifyStateChange();
  };
  const onShareSourceChange = (): void => {
    setStatus(shareSourceInput.checked
      ? "The active source URL will be included in the copied share link."
      : "The copied share link will contain settings only.");
  };
  const onTerrainRecipeChange = (): void => {
    notifyStateChange();
  };
  const onCopyCode = async (): Promise<void> => {
    const source = content.source;
    if (content.sensitiveSourceIncluded === true && !exactSourceInput.checked) {
      setStatus("Copy is disabled until the snippet is regenerated without the exact source.");
      return;
    }
    const sensitive = content.sensitiveSourceIncluded === true ||
      (typeof source === "string" &&
        isPotentiallySensitiveSource(source) &&
        exactSourceInput.checked);
    if (sensitive && !window.confirm(
      "The visible code contains a source value that could include credentials or private path data. Copy it anyway?",
    )) {
      setStatus("Copy cancelled. Switch to the placeholder source to copy without the exact source value.");
      return;
    }
    await copyWithFeedback(copyCodeButton, codeElement.textContent ?? "", "Generated code copied.", "Copy code");
  };
  const onCopyInstall = async (): Promise<void> => {
    await copyWithFeedback(copyInstallButton, installCommand.textContent ?? "", "Install command copied.", "Copy install command");
  };
  const onCopyShare = async (): Promise<void> => {
    if (!options.createShareLink) return;
    try {
      await copyWithFeedback(
        copyShareButton,
        options.createShareLink(shareSourceInput.checked),
        "Share link copied.",
        "Copy share link",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to create a safe share link.");
    }
  };

  modeMinimal.addEventListener("click", onModeMinimal);
  modeExplicit.addEventListener("click", onModeExplicit);
  exactSourceInput.addEventListener("change", onExactSourceChange);
  shareSourceInput.addEventListener("change", onShareSourceChange);
  terrainRecipeInput.addEventListener("change", onTerrainRecipeChange);
  copyCodeButton.addEventListener("click", onCopyCode);
  copyInstallButton.addEventListener("click", onCopyInstall);
  copyShareButton.addEventListener("click", onCopyShare);

  return {
    setContent,
    setAppliedStatus(status): void {
      assertAppliedStatus(status);
      appliedStatus = status;
      content = { ...content, appliedStatus: status };
      updateAppliedStatus();
      syncAppliedAgeTimer();
    },
    setTerrainAlignmentRecipeAvailable(available): void {
      terrainRecipeOption.hidden = !available;
      terrainRecipeInput.disabled = !available;
      if (!available && terrainRecipeInput.checked) {
        terrainRecipeInput.checked = false;
        notifyStateChange();
      }
    },
    setStatus,
    setSourcePrivacySelection(source, includeExactSource, includeShareSource = false): void {
      content = { ...content, source };
      exactSourceInput.checked = includeExactSource;
      shareSourceInput.checked = includeShareSource;
      syncSourceControls();
      notifyStateChange();
    },
    getState: state,
    destroy(): void {
      if (disposed) return;
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      if (ageTimer !== undefined) window.clearInterval(ageTimer);
      modeMinimal.removeEventListener("click", onModeMinimal);
      modeExplicit.removeEventListener("click", onModeExplicit);
      exactSourceInput.removeEventListener("change", onExactSourceChange);
      shareSourceInput.removeEventListener("change", onShareSourceChange);
      terrainRecipeInput.removeEventListener("change", onTerrainRecipeChange);
      copyCodeButton.removeEventListener("click", onCopyCode);
      copyInstallButton.removeEventListener("click", onCopyInstall);
      copyShareButton.removeEventListener("click", onCopyShare);
      panel.remove();
    },
  };
}
