export type TerrainAlignmentPoint = Readonly<{
  ownerId?: string;
  nodeKey: string;
  pointIndex: number;
  longitude: number;
  latitude: number;
  height: number;
  source?: Readonly<{ x: number; y: number; z: number }>;
  classification?: number;
  classificationLabel?: string;
}>;

export type TerrainAlignmentCandidate<Point extends TerrainAlignmentPoint = TerrainAlignmentPoint> = Readonly<{
  anchor: Point;
  groundConfirmed?: boolean;
}>;

/** The stable result fields shared by the single and batch public estimators. */
export type TerrainAlignmentEstimateState = Readonly<{
  status: "ready" | "uncertain" | "unavailable" | "cancelled";
  actionable: boolean;
  anchor?: Readonly<{
    ownerId?: string;
    nodeKey: string;
    pointIndex: number;
    longitudeDegrees: number;
    latitudeDegrees: number;
    displayedHeightMeters: number;
    source?: Readonly<{ x: number; y: number; z: number }>;
    classification?: number;
  }>;
  terrainHeightMeters?: number;
  proposedOffsetMeters?: number;
  existingHeightOffsetMeters: number;
  effectiveProposedHeightOffsetMeters?: number;
  proposedHeightOffsetMeters?: number;
  medianResidualMeters?: number;
  robustSpreadMeters?: number;
  coverage?: Readonly<{
    requestedAnchorCount: number;
    sampledAnchorCount: number;
    acceptedAnchorCount: number;
    acceptedFraction: number;
    notEvaluatedAnchorCount: number;
  }>;
  perAnchorResults?: readonly Readonly<{
    anchor: NonNullable<TerrainAlignmentEstimateState["anchor"]>;
    accepted: boolean;
    sampled: boolean;
    terrainHeightMeters?: number;
    residualMeters?: number;
    rejectionReason?: string;
    warnings: readonly string[];
  }> [];
  verticalReference: Readonly<{
    sourceVerticalCrs?: string;
    displayHeightReference: "wgs84-ellipsoidal" | "unverified";
    conversion: "validated-vertical-grid" | "source-declared-ellipsoidal" | "none";
    verticalGridId?: string;
  }>;
  terrainProvider?: Readonly<{ type: string; hasTileAvailability: boolean }>;
  terrainSourceId?: string;
  sourceId?: string;
  terrainSamplingCalls: number;
  samplingDurationMs?: number;
  warnings: readonly string[];
  rejectionReason?: string;
}>;

export type TerrainAlignmentControlState = Readonly<{
  contextKey?: string;
  renderer: "cesium" | "three";
  apiAvailable: boolean;
  apiUnavailableReason?: string;
  batchAvailable: boolean;
  providerAvailable: boolean;
  providerStatus: string;
  selectedPoint?: TerrainAlignmentPoint;
  heightOffsetMeters: number;
  applying: boolean;
}>;

export type TerrainAlignmentControl = {
  readonly element: HTMLElement;
  update(): void;
  destroy(): void;
};

export type TerrainAlignmentControlOptions<Point extends TerrainAlignmentPoint = TerrainAlignmentPoint> = {
  readonly target: HTMLElement;
  readonly getState: () => Omit<TerrainAlignmentControlState, "selectedPoint"> & {
    readonly selectedPoint?: Point;
  };
  readonly estimate: (
    candidates: readonly TerrainAlignmentCandidate<Point>[],
    signal: AbortSignal,
  ) => Promise<TerrainAlignmentEstimateState>;
  readonly isEstimateCurrent: (estimate: TerrainAlignmentEstimateState) => boolean;
  readonly apply: (
    finalHeightOffsetMeters: number,
    estimate: TerrainAlignmentEstimateState,
  ) => Promise<boolean>;
};

const MAX_UI_ANCHORS = 8;
const MAX_FINE_ADJUSTMENT_CENTIMETERS = 100;

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function pointIdentity(point: TerrainAlignmentPoint | undefined): string | undefined {
  if (!point) return undefined;
  return `${point.ownerId ?? ""}/${point.nodeKey}/${point.pointIndex}`;
}

function pointSummary(point: TerrainAlignmentPoint): string {
  const classification = point.classificationLabel ??
    (point.classification === undefined ? "classification unavailable" : `class ${point.classification}`);
  return `${point.nodeKey} / ${point.pointIndex} · ${classification} · ${point.longitude.toFixed(6)}°, ${point.latitude.toFixed(6)}°`;
}

function validPoint(point: TerrainAlignmentPoint): boolean {
  return Boolean(
    point.ownerId &&
      point.nodeKey &&
      Number.isSafeInteger(point.pointIndex) &&
      point.pointIndex >= 0 &&
      Number.isFinite(point.longitude) &&
      point.longitude >= -180 &&
      point.longitude <= 180 &&
      Number.isFinite(point.latitude) &&
      point.latitude >= -90 &&
      point.latitude <= 90 &&
      Number.isFinite(point.height) &&
      (!point.source || [point.source.x, point.source.y, point.source.z].every(Number.isFinite)),
  );
}

function estimateTotalOffset(estimate: TerrainAlignmentEstimateState): number | undefined {
  const value = estimate.effectiveProposedHeightOffsetMeters ?? estimate.proposedHeightOffsetMeters;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatMeters(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "unavailable" : `${value.toFixed(3)} m`;
}

/** Mounts the shared host-driven Terrain estimate, preview, and approval workflow. */
export function mountTerrainAlignmentControl<Point extends TerrainAlignmentPoint>(
  options: TerrainAlignmentControlOptions<Point>,
): TerrainAlignmentControl {
  const root = makeElement("section", "terrain-alignment-command");
  root.setAttribute("aria-label", "Terrain estimate and approval");
  const provider = makeElement("p", "terrain-alignment-command__provider");
  provider.setAttribute("role", "status");
  provider.setAttribute("aria-live", "polite");
  const selected = makeElement("p", "terrain-alignment-command__selection");
  selected.setAttribute("role", "status");
  selected.setAttribute("aria-live", "polite");
  const anchorList = makeElement("ul", "terrain-alignment-command__anchors");
  anchorList.setAttribute("aria-label", "Validated ground anchors");
  const error = makeElement("p", "terrain-alignment-command__error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const message = makeElement("p", "terrain-alignment-command__message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const preview = makeElement("div", "terrain-alignment-command__preview");
  preview.id = "terrain-alignment-preview";
  preview.setAttribute("role", "status");
  preview.setAttribute("aria-live", "polite");
  const adjustmentLabel = makeElement("label", "ui-field terrain-alignment-command__adjustment");
  adjustmentLabel.htmlFor = "terrain-fine-adjustment";
  adjustmentLabel.append(document.createTextNode("Fine adjustment (cm)"));
  const adjustment = makeElement("input");
  adjustment.id = "terrain-fine-adjustment";
  adjustment.type = "range";
  adjustment.min = String(-MAX_FINE_ADJUSTMENT_CENTIMETERS);
  adjustment.max = String(MAX_FINE_ADJUSTMENT_CENTIMETERS);
  adjustment.step = "1";
  adjustment.value = "0";
  const adjustmentValue = makeElement("output", "terrain-alignment-command__adjustment-value");
  adjustmentValue.htmlFor = adjustment.id;
  adjustmentLabel.append(adjustment, adjustmentValue);
  const groundConfirmationLabel = makeElement("label", "ui-field ui-field--inline");
  groundConfirmationLabel.htmlFor = "terrain-ground-confirmation";
  const groundConfirmation = makeElement("input");
  groundConfirmation.id = "terrain-ground-confirmation";
  groundConfirmation.type = "checkbox";
  groundConfirmationLabel.append(groundConfirmation, document.createTextNode("I confirm the selected point is ground"));
  const actions = makeElement("div", "terrain-alignment-command__actions");
  const addAnchor = makeElement("button", "schema-action");
  addAnchor.type = "button";
  addAnchor.textContent = "Add selected anchor";
  const estimateButton = makeElement("button", "schema-action");
  estimateButton.type = "button";
  estimateButton.textContent = "Estimate Terrain";
  const cancelButton = makeElement("button", "schema-action terrain-alignment-command__secondary");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel estimate";
  const applyButton = makeElement("button", "schema-action");
  applyButton.type = "button";
  applyButton.textContent = "Approve and apply";
  const resetButton = makeElement("button", "schema-action terrain-alignment-command__secondary");
  resetButton.type = "button";
  resetButton.textContent = "Reset anchors and estimate";
  actions.append(addAnchor, estimateButton, cancelButton, applyButton, resetButton);
  const warning = makeElement("p", "terrain-alignment-command__warning");
  warning.textContent = "This preview is numerical only. It is not a geoid or vertical-datum correction. Approve to apply the final heightOffsetMeters total; do not add the Terrain residual twice.";
  const fineHelp = makeElement("p", "terrain-alignment-command__help");
  fineHelp.textContent = "Fine adjustment is bounded to ±100 cm and is added once to the proposed final offset.";

  root.append(provider, selected, groundConfirmationLabel, actions, anchorList, message, preview, adjustmentLabel, fineHelp, warning, error);
  options.target.replaceChildren(root);

  let candidates: TerrainAlignmentCandidate<Point>[] = [];
  let estimateResult: TerrainAlignmentEstimateState | undefined;
  let estimateController: AbortController | undefined;
  let fineAdjustmentCentimeters = 0;
  let statusMessage = "Select a point in the Cesium view, confirm ground when needed, and add it as an anchor.";
  let errorMessage: string | undefined;
  let destroyed = false;
  let lastSelectedIdentity: string | undefined;
  let lastContextKey: string | undefined;
  let applying = false;

  const showError = (text: string | undefined): void => {
    errorMessage = text;
    error.textContent = text ?? "";
    error.hidden = !text;
  };

  const currentMatchesCandidate = (candidate: TerrainAlignmentCandidate): boolean =>
    pointIdentity(options.getState().selectedPoint) === pointIdentity(candidate.anchor);

  const render = (): void => {
    if (destroyed) return;
    const state = options.getState();
    const selectedPoint = state.selectedPoint;
    if (lastContextKey !== state.contextKey) {
      if (lastContextKey !== undefined) {
        estimateController?.abort();
        estimateController = undefined;
        candidates = [];
        estimateResult = undefined;
        fineAdjustmentCentimeters = 0;
        statusMessage = "The active source or Terrain provider changed. Add anchors again before estimating.";
      }
      lastContextKey = state.contextKey;
    }
    const selectedIdentity = pointIdentity(selectedPoint);
    if (selectedIdentity !== lastSelectedIdentity) {
      lastSelectedIdentity = selectedIdentity;
      groundConfirmation.checked = false;
    }
    const providerUnavailable = !state.providerAvailable;
    const estimateIsCurrent = estimateResult !== undefined && options.isEstimateCurrent(estimateResult);
    const totalOffset = estimateResult ? estimateTotalOffset(estimateResult) : undefined;
    const finalOffset = totalOffset === undefined
      ? undefined
      : totalOffset + fineAdjustmentCentimeters / 100;
    const singleAnchorMode = !state.batchAvailable;
    const estimateUsesSingleApi = candidates.length === 1;
    const currentAnchorRequired = estimateUsesSingleApi &&
      !currentMatchesCandidate(candidates[0]);
    const anchorLimit = singleAnchorMode ? 1 : MAX_UI_ANCHORS;

    provider.textContent = state.providerStatus +
      (state.renderer === "cesium" && state.apiAvailable && !state.batchAvailable
        ? " · this release supports one anchor per estimate; batch estimates are unavailable."
        : "");
    selected.textContent = selectedPoint
      ? `Selected point: ${pointSummary(selectedPoint)} · displayed height ${formatMeters(selectedPoint.height)} · source XYZ ${selectedPoint.source ? `${selectedPoint.source.x}, ${selectedPoint.source.y}, ${selectedPoint.source.z}` : "not retained"}`
      : state.renderer === "three"
        ? "Terrain alignment is unavailable in Three.js mode. Select Cesium to use the consumer-owned Terrain provider."
        : "Select a point from the active COPC layer to add a ground anchor.";
    groundConfirmationLabel.hidden = !selectedPoint || selectedPoint.classification === 2;
    const pointIsValid = selectedPoint !== undefined && validPoint(selectedPoint);
    const pointAlreadyAdded = selectedPoint !== undefined && candidates.some(
      (candidate) => pointIdentity(candidate.anchor) === pointIdentity(selectedPoint),
    );
    addAnchor.hidden = singleAnchorMode;
    addAnchor.disabled = state.applying || estimateController !== undefined ||
      !pointIsValid || pointAlreadyAdded || candidates.length >= anchorLimit ||
      (selectedPoint?.classification !== 2 && !groundConfirmation.checked);
    const singleSelectionIsUsable = selectedPoint !== undefined && pointIsValid &&
      (selectedPoint.classification === 2 || groundConfirmation.checked);
    const hasUsableCandidates = singleAnchorMode
      ? singleSelectionIsUsable
      : candidates.length > 0 && !currentAnchorRequired;
    estimateButton.disabled = state.applying || applying || estimateController !== undefined ||
      !state.apiAvailable || state.renderer !== "cesium" || providerUnavailable ||
      !hasUsableCandidates || (candidates.length > 1 && !state.batchAvailable);
    cancelButton.disabled = estimateController === undefined;
    cancelButton.hidden = estimateController === undefined;
    applyButton.disabled = state.applying || applying || estimateController !== undefined ||
      !estimateResult?.actionable || estimateResult.status !== "ready" ||
      !estimateIsCurrent || finalOffset === undefined;
    resetButton.disabled = state.applying || applying || (candidates.length === 0 && estimateResult === undefined && fineAdjustmentCentimeters === 0 && !errorMessage);
    adjustment.disabled = !estimateResult?.actionable || !estimateIsCurrent || state.applying || applying || estimateController !== undefined;
    adjustment.value = String(fineAdjustmentCentimeters);
    adjustmentValue.textContent = `${fineAdjustmentCentimeters > 0 ? "+" : ""}${fineAdjustmentCentimeters} cm`;
    groundConfirmation.disabled = state.applying || applying || estimateController !== undefined || !selectedPoint || selectedPoint.classification === 2;
    message.textContent = state.renderer === "three"
      ? "Three.js does not own a Cesium Terrain provider, so this command cannot sample Terrain in this mode."
      : state.apiUnavailableReason && !state.apiAvailable
        ? state.apiUnavailableReason
        : selectedPoint && !pointIsValid
          ? "The selected point has invalid identity or coordinates and cannot be used as a ground anchor."
          : providerUnavailable
            ? `${state.providerStatus} A real supported Terrain provider is required; the WGS84 ellipsoid is not sampled as terrain.`
            : currentAnchorRequired
              ? "The selected point changed. Select the saved anchor again before estimating one point, or add a second anchor for a batch estimate."
              : estimateResult?.status === "uncertain"
                ? estimateResult.rejectionReason ?? "The estimate is uncertain and cannot be applied."
                : statusMessage;
    showError(errorMessage);
    anchorList.replaceChildren(...candidates.map((candidate, index) => {
      const row = makeElement("li", "terrain-alignment-command__anchor");
      const text = makeElement("span");
      text.textContent = pointSummary(candidate.anchor) +
        (candidate.groundConfirmed ? " · ground confirmed" : " · LAS class 2");
      const remove = makeElement("button", "terrain-alignment-command__remove");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove anchor ${index + 1}`);
      remove.disabled = state.applying || estimateController !== undefined;
      remove.addEventListener("click", () => {
        candidates = candidates.filter((_item, candidateIndex) => candidateIndex !== index);
        estimateResult = undefined;
        fineAdjustmentCentimeters = 0;
        statusMessage = "Anchor removed. Estimate again to preview a proposal.";
        showError(undefined);
        render();
      });
      row.append(text, remove);
      return row;
    }));
    if (!estimateResult) {
      preview.textContent = candidates.length === 0
        ? singleAnchorMode && selectedPoint
          ? "The selected point will be sampled after ground status is confirmed. No source XYZ or active height offset changes before approval."
          : "No anchor has been added. Source XYZ and the active layer remain unchanged until approval."
        : `${candidates.length} anchor${candidates.length === 1 ? "" : "s"} added. ${candidates.length < 2 ? "A single anchor uses the single-point estimate; a robust batch needs at least two." : "A batch estimate will report accepted and rejected samples, median residual, and spread."}`;
      preview.dataset.status = "empty";
      adjustmentLabel.hidden = true;
      return;
    }
    adjustmentLabel.hidden = !estimateResult.actionable || !estimateIsCurrent;
    const residual = estimateResult.medianResidualMeters ?? estimateResult.proposedOffsetMeters;
    const sampledHeight = estimateResult.terrainHeightMeters;
    const sourceVertical = estimateResult.verticalReference.sourceVerticalCrs ?? "not declared";
    const previewLines = [
      "Preview: numerical proposed adjustment only; the active layer changes only after approval.",
      `Estimate: ${estimateResult.status}${estimateIsCurrent ? " · current" : " · stale; estimate again"}`,
      `COPC source: ${estimateResult.sourceId ?? "not identified"}`,
      `Terrain provider: ${estimateResult.terrainProvider?.type ?? state.providerStatus}${estimateResult.terrainSourceId ? ` · ${estimateResult.terrainSourceId}` : ""}`,
      `Vertical reference: ${sourceVertical} → ${estimateResult.verticalReference.displayHeightReference} (${estimateResult.verticalReference.conversion})`,
      ...(sampledHeight === undefined ? [] : [`Sampled Terrain height: ${formatMeters(sampledHeight)}`]),
      `Additional Terrain offset: ${formatMeters(residual)}`,
      `Existing manual heightOffsetMeters: ${formatMeters(estimateResult.existingHeightOffsetMeters)}`,
      `Proposed total heightOffsetMeters: ${formatMeters(totalOffset)}`,
      `Fine adjustment: ${fineAdjustmentCentimeters} cm`,
      `Final heightOffsetMeters after approval: ${formatMeters(finalOffset)}`,
      `Sampling: ${estimateResult.terrainSamplingCalls} call${estimateResult.terrainSamplingCalls === 1 ? "" : "s"}${estimateResult.samplingDurationMs === undefined ? "" : ` · ${estimateResult.samplingDurationMs.toFixed(1)} ms`}`,
      ...(estimateResult.coverage ? [
        `Anchors: ${estimateResult.coverage.acceptedAnchorCount} accepted · ${estimateResult.coverage.sampledAnchorCount} sampled · ${estimateResult.coverage.requestedAnchorCount - estimateResult.coverage.acceptedAnchorCount} rejected`,
        `Robust median residual: ${formatMeters(estimateResult.medianResidualMeters)} · spread: ${formatMeters(estimateResult.robustSpreadMeters)}`,
      ] : []),
      ...(estimateResult.rejectionReason ? [`Unavailable: ${estimateResult.rejectionReason}`] : []),
      ...estimateResult.warnings.map((item) => `Warning: ${item}`),
    ];
    preview.textContent = previewLines.join("\n");
    preview.dataset.status = estimateIsCurrent ? estimateResult.status : "stale";
    const resultRows = estimateResult.perAnchorResults ?? [];
    if (resultRows.length > 0) {
      const results = makeElement("ul", "terrain-alignment-command__results");
      results.setAttribute("aria-label", "Terrain sample outcomes");
      for (const result of resultRows) {
        const row = makeElement("li");
        const outcome = result.accepted ? "Accepted" : result.sampled ? "Rejected" : "Not sampled";
        row.textContent = `${outcome}: ${result.anchor.nodeKey}/${result.anchor.pointIndex}` +
          (result.residualMeters === undefined ? "" : ` · ${formatMeters(result.residualMeters)} residual`) +
          (result.rejectionReason ? ` · ${result.rejectionReason}` : "") +
          (result.warnings.length ? ` · ${result.warnings.join(" ")}` : "");
        results.append(row);
      }
      preview.append(results);
    }
  };

  const onGroundConfirmationChange = (): void => render();
  const onAdjustmentInput = (): void => {
    fineAdjustmentCentimeters = Number(adjustment.value);
    render();
  };
  const onAddAnchor = (): void => {
    const point = options.getState().selectedPoint;
    if (!point || !validPoint(point)) {
      showError("The selected point has invalid coordinates or identity and cannot be added.");
      render();
      return;
    }
    if (point.classification !== 2 && !groundConfirmation.checked) {
      showError("Confirm that this selected point represents ground before adding it.");
      render();
      return;
    }
    if (candidates.some((candidate) =>
      pointIdentity(candidate.anchor) === pointIdentity(point) ||
      (candidate.anchor.longitude === point.longitude && candidate.anchor.latitude === point.latitude),
    )) {
      showError("This point or its coordinates are already in the anchor list.");
      render();
      return;
    }
    if (candidates.length >= (!options.getState().batchAvailable ? 1 : MAX_UI_ANCHORS)) {
      showError(`A maximum of ${!options.getState().batchAvailable ? 1 : MAX_UI_ANCHORS} anchors can be added.`);
      render();
      return;
    }
    candidates = [...candidates, {
      anchor: point,
      ...(point.classification === 2 ? {} : { groundConfirmed: true }),
    }];
    estimateResult = undefined;
    fineAdjustmentCentimeters = 0;
    statusMessage = "Anchor added. Estimate Terrain to preview a placement proposal.";
    showError(undefined);
    render();
  };
  const onEstimate = (): void => {
    if (estimateController) return;
    const state = options.getState();
    if (!state.apiAvailable || state.renderer !== "cesium" || !state.providerAvailable) return;
    const estimateCandidates = state.batchAvailable
      ? candidates
      : state.selectedPoint && validPoint(state.selectedPoint) &&
          (state.selectedPoint.classification === 2 || groundConfirmation.checked)
        ? [{
            anchor: state.selectedPoint,
            ...(state.selectedPoint.classification === 2 ? {} : { groundConfirmed: true }),
          }]
        : [];
    if (estimateCandidates.length === 0) return;
    if (estimateCandidates.length === 1 && !currentMatchesCandidate(estimateCandidates[0])) return;
    const controller = new AbortController();
    estimateController = controller;
    estimateResult = undefined;
    statusMessage = "Sampling the active Cesium Terrain provider…";
    showError(undefined);
    render();
    void options.estimate(estimateCandidates, controller.signal).then((result) => {
      if (destroyed || estimateController !== controller) return;
      estimateResult = result;
      statusMessage = result.status === "cancelled"
        ? "Terrain estimate cancelled. No offset was applied."
        : result.status === "ready"
          ? "Preview ready. Review the additional offset and final total before approving."
          : result.rejectionReason ?? "Terrain estimate is unavailable.";
    }).catch((reason: unknown) => {
      if (destroyed || estimateController !== controller) return;
      showError(reason instanceof Error ? reason.message : "Terrain estimate failed.");
      statusMessage = "The estimate failed. No offset was applied.";
    }).finally(() => {
      if (destroyed || estimateController !== controller) return;
      estimateController = undefined;
      render();
    });
  };
  const onCancel = (): void => {
    if (!estimateController) return;
    estimateController.abort();
    statusMessage = "Cancellation requested. The current Cesium tile request may finish before it returns.";
    render();
  };
  const onApply = (): void => {
    if (!estimateResult || !estimateResult.actionable || estimateResult.status !== "ready" ||
      !options.isEstimateCurrent(estimateResult)) return;
    const proposed = estimateTotalOffset(estimateResult);
    if (proposed === undefined) return;
    const finalOffset = proposed + fineAdjustmentCentimeters / 100;
    applying = true;
    statusMessage = "Applying the approved total height offset…";
    showError(undefined);
    render();
    void options.apply(finalOffset, estimateResult).then((applied) => {
      if (destroyed) return;
      if (applied) {
        candidates = [];
        estimateResult = undefined;
        fineAdjustmentCentimeters = 0;
        statusMessage = `Approved and applied heightOffsetMeters = ${finalOffset.toFixed(3)} m.`;
      } else {
        statusMessage = "The approved offset was not applied. Review the active source and try again.";
      }
    }).catch((reason: unknown) => {
      if (destroyed) return;
      showError(reason instanceof Error ? reason.message : "Applying the Terrain estimate failed.");
      statusMessage = "The estimate remains unapplied.";
    }).finally(() => {
      if (!destroyed) {
        applying = false;
        render();
      }
    });
  };
  const onReset = (): void => {
    estimateController?.abort();
    estimateController = undefined;
    candidates = [];
    estimateResult = undefined;
    fineAdjustmentCentimeters = 0;
    statusMessage = "Terrain estimate and anchors reset. The active height offset is unchanged.";
    showError(undefined);
    render();
  };

  groundConfirmation.addEventListener("change", onGroundConfirmationChange);
  adjustment.addEventListener("input", onAdjustmentInput);
  addAnchor.addEventListener("click", onAddAnchor);
  estimateButton.addEventListener("click", onEstimate);
  cancelButton.addEventListener("click", onCancel);
  applyButton.addEventListener("click", onApply);
  resetButton.addEventListener("click", onReset);
  render();

  return {
    element: root,
    update: render,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      estimateController?.abort();
      groundConfirmation.removeEventListener("change", onGroundConfirmationChange);
      adjustment.removeEventListener("input", onAdjustmentInput);
      addAnchor.removeEventListener("click", onAddAnchor);
      estimateButton.removeEventListener("click", onEstimate);
      cancelButton.removeEventListener("click", onCancel);
      applyButton.removeEventListener("click", onApply);
      resetButton.removeEventListener("click", onReset);
      options.target.replaceChildren();
    },
  };
}
