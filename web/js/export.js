// The export pipeline — web port of bikenetwork/pipeline.render_all(). Clip
// to the city, then produce every artifact in memory: network.geojson,
// map.html, (in a browser) map.png, and a mileage summary with the same
// warnings/notices the desktop tool reports.
import { featuresToGeojson } from "./geojson.js";
import { clipFeatures, featuresAsOfPhase, partsKm, summarize } from "./pipeline.js";
import { COLOR_MODES, hexToRgb, mapPalette } from "./render_common.js";
import { COST_DISCLAIMER, hasCostOverrides } from "./costs.js";
import { renderHtml } from "./render_html.js";
import { encodeGif } from "./gif.js";

// map.html embeds context layers inline; big ones would bloat a file people
// email around, so oversized layers are left out with a notice instead.
const CONTEXT_LAYER_MAX_BYTES = 512 * 1024;
const CONTEXT_TOTAL_MAX_BYTES = 2 * 1024 * 1024;

// Animation frames: small enough to keep the GIF emailable.
const GIF_PX = 900;

function embeddableLayers(contextLayers, notices) {
  const kept = [];
  let total = 0;
  for (const layer of contextLayers || []) {
    const size = JSON.stringify(layer.geojson).length;
    if (size > CONTEXT_LAYER_MAX_BYTES || total + size > CONTEXT_TOTAL_MAX_BYTES) {
      notices.push(`${layer.entry.label || layer.entry.id}: left out of `
        + `map.html (${Math.round(size / 1024)} KB is too much to embed) — `
        + `view it in the editor instead.`);
      continue;
    }
    total += size;
    kept.push(layer);
  }
  return kept;
}

// `boundaryRings` are the raw boundary ways (drawn on maps); `clipRing` is the
// precomputed city polygon ring (used for clipping). `renderPng` is injected
// (it needs a DOM canvas, so Node tests pass none). Returns
// { geojson, html, pngBlob, summary }.
export async function buildArtifacts(net, boundaryRings, clipBoundary, {
  colorMode = "treatment",
  renderPng = null,
  contextLayers = [],
} = {}) {
  if (!COLOR_MODES.includes(colorMode)) {
    throw new Error(`color_mode must be one of ${COLOR_MODES.join(", ")} (got '${colorMode}')`);
  }
  const warnings = [];
  const notices = [];

  let features = net.features.map((f) => ({ ...f, points: f.points,
                                            lines: f.lines }));
  for (const f of features) {
    if (!f.length_km) f.length_km = partsKm(f.lines());
  }
  if (clipBoundary && clipBoundary.length) {
    features = clipFeatures(features, clipBoundary, warnings, notices);
  }

  const geojson = featuresToGeojson(features);

  const html = renderHtml(features, net, {
    boundary: boundaryRings, colorMode,
    contextLayers: embeddableLayers(contextLayers, notices),
  });
  const pngBlob = renderPng
    ? await renderPng(features, net, { boundary: boundaryRings, colorMode })
    : null;

  const summary = summarize(features, net);
  // These numbers end up on a slide in front of a council; if the file
  // adjusts the built-in rates, every export says so.
  if (hasCostOverrides(net.costs)) notices.push(COST_DISCLAIMER);
  summary.warnings = warnings;
  summary.notices = notices;
  return { geojson, html, pngBlob, summary, features };
}

// The stops an animation/phase export walks: Today, then each declared phase
// that actually has proposed work.
export function phaseStops(net, features) {
  // Treatments carry the phase now, and they carry a phase ID rather than a
  // number — the number is display order, which a merge is free to renumber.
  const byId = net.phaseMap();
  const nums = [...new Set(features
    .flatMap((f) => f.treatments)
    .filter((t) => t.status === "proposed" && t.phase && byId.has(t.phase))
    .map((t) => byId.get(t.phase).number))].sort((a, b) => a - b);
  const stops = [{ n: 0, caption: "Today" }];
  for (const n of nums) {
    const cfg = net.phases.find((ph) => ph.number === n);
    let caption = `Phase ${n}`;
    if (cfg && cfg.label) caption += `: ${cfg.label}`;
    if (cfg && cfg.target_date) caption += `\nby ${cfg.target_date}`;
    stops.push({ n, caption });
  }
  return stops;
}

/**
 * Per-phase PNGs plus the animated GIF, mirroring
 * pipeline.render_phase_exports(). Returns [] when nothing is phased.
 * `renderPng` is injected for the same reason as above (needs a canvas).
 */
export async function buildPhaseArtifacts(net, boundaryRings, clipBoundary, {
  colorMode = "treatment",
  renderPng = null,
  features = null,
  onProgress = null,
} = {}) {
  if (!renderPng) return [];
  let use = features;
  if (!use) {
    use = net.features.map((f) => ({ ...f, points: f.points, lines: f.lines }));
    for (const f of use) if (!f.length_km) f.length_km = partsKm(f.lines());
    if (clipBoundary && clipBoundary.length) {
      use = clipFeatures(use, clipBoundary, [], []);
    }
  }
  // Phase views are computed against a network carrying the CLIPPED features,
  // so a frame never draws geometry the totals excluded.
  const clippedNet = { ...net, features: use,
                       phaseMap: net.phaseMap.bind(net),
                       authority: net.authority.bind(net),
                       area: net.area.bind(net),
                       allTreatments: () => use.flatMap(
                         (f) => f.treatments.map((t) => [f, t])) };

  const stops = phaseStops(net, use);
  if (stops.length < 2) return [];

  const files = [];
  // Per-phase stills at full print size (skip "Today" — that is not a phase).
  for (const stop of stops.slice(1)) {
    if (onProgress) onProgress(`Rendering phase ${stop.n}…`);
    const blob = await renderPng(featuresAsOfPhase(clippedNet, stop.n), net, {
      boundary: boundaryRings, colorMode,
      title: `${net.displayName || "Bike"} Network — Phase ${stop.n}`,
    });
    files.push({ name: `map-phase-${stop.n}.png`, blob });
  }

  // Animation frames: small, and every frame gets the same number of caption
  // lines so the title band (and therefore the map) never changes size.
  const lines = Math.max(...stops.map((s) => s.caption.split("\n").length));
  const frames = [];
  for (const stop of stops) {
    if (onProgress) onProgress(`Animating ${stop.n ? `phase ${stop.n}` : "today"}…`);
    const caption = stop.caption
      + "\n".repeat(lines - stop.caption.split("\n").length);
    frames.push(await renderPng(featuresAsOfPhase(clippedNet, stop.n), net, {
      boundary: boundaryRings, colorMode,
      title: `${net.displayName || "Bike"} Network — ${caption}`,
      figPx: GIF_PX,
      asImageData: true,
    }));
  }
  const { width, height } = frames[0];
  if (frames.every((f) => f.width === width && f.height === height)) {
    // Linger on "Today" and on the finished network so the loop reads clearly.
    const delays = frames.map((_, i) => (i === 0 ? 2000
      : i === frames.length - 1 ? 3000 : 1400));
    const bytes = encodeGif(frames.map((f) => f.data), {
      width, height, delays, loop: 0, reserved: mapPalette().map(hexToRgb),
    });
    files.push({ name: "phases.gif",
                 blob: new Blob([bytes], { type: "image/gif" }) });
  }
  return files;
}
