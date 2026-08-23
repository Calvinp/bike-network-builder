// The export pipeline — web port of bikenetwork/pipeline.render_all(). Clip
// to the city, then produce every artifact in memory: network.geojson,
// map.html, (in a browser) map.png, and a mileage summary with the same
// warnings/notices the desktop tool reports.
import { pathsToGeojson, spotsToGeojson } from "./geojson.js";
import { segmentsMiles } from "./geometry.js";
import {
  clipPaths, clipSpots, pathsAsOfPhase, spotsAsOfPhase, summarize,
} from "./pipeline.js";
import { COLOR_MODES } from "./render_common.js";
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
export async function buildArtifacts(net, boundaryRings, clipRing, {
  colorMode = "type",
  renderPng = null,
  contextLayers = [],
} = {}) {
  if (!COLOR_MODES.includes(colorMode)) {
    throw new Error(`color_mode must be one of ${COLOR_MODES.join(", ")} (got '${colorMode}')`);
  }
  const warnings = [];
  const notices = [];

  let paths = net.paths.map((p) => ({ ...p }));
  for (const p of paths) {
    if (!p.length_miles && p.segments.some((s) => s.length >= 2)) {
      p.length_miles = segmentsMiles(p.segments);
    }
  }
  let spots = (net.spots || []).map((s) => ({ ...s }));
  if (clipRing && clipRing.length >= 3) {
    paths = clipPaths(paths, clipRing, warnings, notices);
    spots = clipSpots(spots, clipRing);
  }

  const geojson = pathsToGeojson(paths);
  // Point features ride along in the export; polyline-only readers (including
  // our own pathsFromGeojson) skip them harmlessly.
  geojson.features = geojson.features.concat(spotsToGeojson(spots).features);

  const html = renderHtml(paths, net, {
    boundary: boundaryRings, colorMode, spots,
    contextLayers: embeddableLayers(contextLayers, notices),
  });
  const pngBlob = renderPng
    ? await renderPng(paths, net, { boundary: boundaryRings, colorMode, spots })
    : null;

  const summary = summarize(paths, net);
  summary.warnings = warnings;
  summary.notices = notices;
  return { geojson, html, pngBlob, summary, paths, spots };
}

// The stops an animation/phase export walks: Today, then each declared phase
// that actually has proposed work.
export function phaseStops(net, paths) {
  const nums = [...new Set(paths
    .filter((p) => p.status === "proposed" && p.phase !== null
                   && p.phase !== undefined)
    .map((p) => p.phase))].sort((a, b) => a - b)
    .filter((n) => net.phases.some((ph) => ph.number === n));
  const stops = [{ n: 0, caption: "Today" }];
  for (const n of nums) {
    const cfg = net.phases.find((ph) => ph.number === n);
    let caption = `Phase ${n}`;
    if (cfg && cfg.label) caption += `: ${cfg.label}`;
    if (cfg && cfg.deadline) caption += `\nby ${cfg.deadline}`;
    stops.push({ n, caption });
  }
  return stops;
}

/**
 * Per-phase PNGs plus the animated GIF, mirroring
 * pipeline.render_phase_exports(). Returns [] when nothing is phased.
 * `renderPng` is injected for the same reason as above (needs a canvas).
 */
export async function buildPhaseArtifacts(net, boundaryRings, clipRing, {
  colorMode = "type",
  renderPng = null,
  paths = null,
  spots = null,
  onProgress = null,
} = {}) {
  if (!renderPng) return [];
  let use = paths;
  let useSpots = spots;
  if (!use) {
    use = net.paths.map((p) => ({ ...p }));
    for (const p of use) {
      if (!p.length_miles && p.segments.some((s) => s.length >= 2)) {
        p.length_miles = segmentsMiles(p.segments);
      }
    }
    useSpots = (net.spots || []).map((s) => ({ ...s }));
    if (clipRing && clipRing.length >= 3) {
      use = clipPaths(use, clipRing, [], []);
      useSpots = clipSpots(useSpots, clipRing);
    }
  }

  const stops = phaseStops(net, use);
  if (stops.length < 2) return [];

  const files = [];
  // Per-phase stills at full print size (skip "Today" — that is not a phase).
  for (const stop of stops.slice(1)) {
    if (onProgress) onProgress(`Rendering phase ${stop.n}…`);
    const blob = await renderPng(pathsAsOfPhase(use, stop.n), net, {
      boundary: boundaryRings, colorMode,
      spots: spotsAsOfPhase(useSpots, stop.n),
      title: `${net.city} Bike Network — Phase ${stop.n}`,
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
    frames.push(await renderPng(pathsAsOfPhase(use, stop.n), net, {
      boundary: boundaryRings, colorMode,
      spots: spotsAsOfPhase(useSpots, stop.n),
      title: `${net.city} Bike Network — ${caption}`,
      figPx: GIF_PX,
      asImageData: true,
    }));
  }
  const { width, height } = frames[0];
  if (frames.every((f) => f.width === width && f.height === height)) {
    // Linger on "Today" and on the finished network so the loop reads clearly.
    const delays = frames.map((_, i) => (i === 0 ? 2000
      : i === frames.length - 1 ? 3000 : 1400));
    const bytes = encodeGif(frames.map((f) => f.data),
                            { width, height, delays, loop: 0 });
    files.push({ name: "phases.gif",
                 blob: new Blob([bytes], { type: "image/gif" }) });
  }
  return files;
}
