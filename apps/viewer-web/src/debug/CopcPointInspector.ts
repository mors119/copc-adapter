import type { CopcPointInspection } from '../copc/points/pointInspection';

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toPrecision(8);
}

function formatOptional(value: number | undefined, suffix = ''): string {
  return value === undefined ? 'Unavailable' : `${formatNumber(value)}${suffix}`;
}

function formatSource(point: CopcPointInspection): string {
  return point.source
    ? [point.source.x, point.source.y, point.source.z].map(formatNumber).join(' / ')
    : 'Unavailable';
}

function formatRgb(point: CopcPointInspection): string {
  return point.rgb
    ? [point.rgb.red, point.rgb.green, point.rgb.blue].map(formatNumber).join(' / ')
    : 'Unavailable';
}

export type CopcPointInspector = { destroy(): void };

/** Demo-only compact point inspector; the reusable layer exposes the data API. */
export function createCopcPointInspector(
  getPoint: () => CopcPointInspection | undefined,
): CopcPointInspector {
  const panel = document.createElement('aside');
  panel.className = 'copc-point-inspector';
  panel.setAttribute('aria-label', 'COPC point inspector');
  panel.innerHTML = `
    <div class="copc-point-inspector__eyebrow">COPC Point</div>
    <div class="copc-point-inspector__empty" data-empty>Click a rendered point</div>
    <dl data-details hidden>
      <div><dt>Node</dt><dd data-field="nodeKey"></dd></div>
      <div><dt>Level</dt><dd data-field="level"></dd></div>
      <div><dt>Index</dt><dd data-field="pointIndex"></dd></div>
      <div><dt>Longitude</dt><dd data-field="longitude"></dd></div>
      <div><dt>Latitude</dt><dd data-field="latitude"></dd></div>
      <div><dt>Height</dt><dd data-field="height"></dd></div>
      <div><dt>Source XYZ</dt><dd data-field="source"></dd></div>
      <div><dt>Intensity</dt><dd data-field="intensity"></dd></div>
      <div><dt>Classification</dt><dd data-field="classification"></dd></div>
      <div><dt>RGB</dt><dd data-field="rgb"></dd></div>
    </dl>
  `;
  document.body.append(panel);

  const details = panel.querySelector<HTMLElement>('[data-details]');
  const empty = panel.querySelector<HTMLElement>('[data-empty]');
  const fields = new Map<string, HTMLElement>();
  panel.querySelectorAll<HTMLElement>('[data-field]').forEach((element) => {
    fields.set(element.dataset.field ?? '', element);
  });

  const update = (): void => {
    const point = getPoint();
    if (!point) {
      if (details) details.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }

    if (details) details.hidden = false;
    if (empty) empty.hidden = true;
    const values: Record<string, string> = {
      nodeKey: point.nodeKey,
      level: point.level.toString(),
      pointIndex: point.pointIndex.toString(),
      longitude: formatNumber(point.longitude),
      latitude: formatNumber(point.latitude),
      height: formatOptional(point.height, ' m'),
      source: formatSource(point),
      intensity: formatOptional(point.intensity),
      classification: point.classification === undefined
        ? 'Unavailable'
        : `${point.classification}${point.classificationLabel ? ` (${point.classificationLabel})` : ''}`,
      rgb: formatRgb(point),
    };
    for (const [field, element] of fields) {
      element.textContent = values[field] ?? 'Unavailable';
    }
  };

  update();
  const updateTimer = window.setInterval(update, 100);

  return {
    destroy(): void {
      window.clearInterval(updateTimer);
      panel.remove();
    },
  };
}
