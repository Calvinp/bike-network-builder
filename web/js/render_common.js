// Shared rendering vocabulary: colours, glyphs, labels, and the rule for
// drawing a feature that carries SEVERAL treatments.
//
// The ONE place the palette lives. Colours and glyphs for treatments come from
// the registry (data/treatments.json); everything here is the presentation
// logic around them.
//
// ## The multi-treatment rule
//
// A feature draws EVERY treatment it carries, as STACKED STROKES on the same
// geometry: widest first, narrowest last, ordered by the registry's
// `stack_rank`. Two draw calls, no parallel-offset geometry maths, identical
// in the editor, the exported HTML, the PNG and the GIF frames.
//
// `stack_rank` is Z-ORDER ONLY, never semantics. It decides what is drawn on
// top; it never designates a "primary" treatment, and NOTHING may consult
// `treatments[0]` — list order is declared insignificant precisely so a future
// `arrangement:` key stays reachable. Two files listing the same treatments in
// a different order must render identically; a test pins exactly that.
//
// Below MIN_STACK_ZOOM, or past MAX_STACKED, stacked strokes turn to mush and
// we fall back to the highest-ranked treatment alone. The legend lists
// treatments, never combinations.
import { registry } from "./registry.js";

export const COLOR_MODES = ["phase", "treatment", "single"];

// Okabe-Ito — distinguishable for all common types of colour blindness.
export const PHASE_COLORS = {
  1: "#0072B2",  // blue
  2: "#009E73",  // bluish green
  3: "#D55E00",  // vermillion
  4: "#E69F00",  // orange
  5: "#56B4E9",  // sky blue
};

export const SINGLE_COLOR = "#0072B2";
export const EXISTING_COLOR = "#000000";
export const UNDER_CONSTRUCTION_COLOR = "#999999";
export const FUNDED_COLOR = "#E69F00";
export const BOUNDARY_COLOR = "#777777";
export const UNKNOWN_COLOR = "#8c8c8c";

// Point treatments: darker when proposed, grey when already on the ground.
export const POINT_PROPOSED_COLOR = "#1a1a1a";
export const POINT_EXISTING_COLOR = "#707070";

// Stacked-stroke geometry.
export const BASE_WEIGHT = 4;
export const WEIGHT_STEP = 3;
export const MAX_STACKED = 3;
export const MIN_STACK_ZOOM = 14;

// Below this, individual spots are not drawn at all. A city-wide OSM import is
// thousands of them — bike racks, bollards, humps — and each one is a DOM
// marker that Leaflet repositions on every pan and zoom. At the zoom where you
// can see a whole city they are a grey haze that means nothing anyway; the
// corridors, which are canvas and cheap, carry the picture on their own.
export const MIN_SPOT_ZOOM = 14;

// Names the editor assigns to freshly-drawn features — never worth labelling.
export const DEFAULT_NAMES = new Set(["new feature", "new path", "existing path",
                                      "new corridor"]);

export const phaseColor = (number) => PHASE_COLORS[number] || "#000000";

export function treatmentColor(type) {
  const spec = registry().get(type);
  return spec.color || (spec.unknown ? UNKNOWN_COLOR : POINT_PROPOSED_COLOR);
}

export function treatmentLabel(type) {
  const spec = registry().get(type);
  return spec.label || String(type).replace(/_/g, " ");
}

export function treatmentGlyph(type) {
  const spec = registry().get(type);
  return spec.glyph || "●";
}

// The colour ONE treatment draws in, under a colour mode. `phaseNumberOf` maps
// a phase id to its number (the caller has the network; this module doesn't).
export function strokeColor(t, colorMode, phaseNumberOf) {
  if (colorMode === "single") return SINGLE_COLOR;
  if (colorMode === "treatment") return treatmentColor(t.type);
  if (t.status === "existing") return EXISTING_COLOR;
  if (t.status === "under_construction") return UNDER_CONSTRUCTION_COLOR;
  if (t.status === "funded") return FUNDED_COLOR;
  return phaseColor(phaseNumberOf ? phaseNumberOf(t.phase) : null);
}

// The strokes to draw for a feature, already in draw order: widest first, so
// the last one drawn sits on top. Returns [{treatment, color, weight, dashed}].
//
// `zoom` may be omitted (exports render at a fixed scale); pass it in the
// editor so a zoomed-out map degrades to a single stroke instead of mush.
// A treatment DRAWS as a run of glyphs rather than a stroke when the registry
// gives it a glyph and no colour — which is exactly the counted, point-natured
// vocabulary (street trees, bollards, parking removal). On a line those used to
// fall back to POINT_PROPOSED_COLOR and paint a black dashed stroke, so a row of
// street trees looked like an unrecognised bike facility.
export function drawsAsGlyphs(type) {
  const spec = registry().get(type);
  return Boolean(spec.glyph) && !spec.color;
}

export function featureStrokes(feature, colorMode, { phaseNumberOf, zoom } = {}) {
  const specs = registry().sortedForDraw(feature.treatments.map((t) => t.type));
  // Re-associate each spec with its treatment. sortedForDraw is stable and
  // total, so the same treatments always produce the same order regardless of
  // how the file happened to list them.
  const remaining = [...feature.treatments];
  const ordered = specs.map((spec) => {
    const i = remaining.findIndex((t) => t.type === spec.id);
    return remaining.splice(i < 0 ? 0 : i, 1)[0];
  }).filter(Boolean);

  const tooSmall = (zoom !== undefined && zoom < MIN_STACK_ZOOM);
  const visible = (tooSmall || ordered.length > MAX_STACKED)
    ? ordered.slice(-1)                  // the highest-ranked one alone
    : ordered;

  const n = visible.length;
  return visible.map((t, i) => ({
    treatment: t,
    color: strokeColor(t, colorMode, phaseNumberOf),
    weight: BASE_WEIGHT + (n - 1 - i) * WEIGHT_STEP,
    // A treatment that isn't on the ground yet reads as dashed at every level;
    // status is carried by line style, orthogonal to the colour modes.
    dashed: t.status !== "existing",
    dashArray: dashFor(t.status),
  }));
}

// What a LINE feature draws: the strokes that are really strokes, plus the
// counted treatments drawn as glyphs spaced along it.
//
// A line carrying only counted treatments (a row of street trees) gets no
// stroke at all, so `spine` asks for a hairline underneath — it keeps the
// feature visible as one object and, in the editor, keeps it clickable.
export function featureLayers(feature, colorMode, opts = {}) {
  const all = featureStrokes(feature, colorMode, opts);
  const strokes = all.filter((s) => !drawsAsGlyphs(s.treatment.type));
  // Glyph runs take pointColor, not the stroke colour: they ARE spots, just
  // spread along a line, and a standalone spot of the same treatment must not
  // come out a different colour from a row of them.
  const glyphRuns = all.filter((s) => drawsAsGlyphs(s.treatment.type))
    .map((s) => ({ ...s, color: pointColor(s.treatment),
                   glyph: treatmentGlyph(s.treatment.type) }));
  return { strokes, glyphRuns, spine: strokes.length === 0 && glyphRuns.length > 0 };
}

// Points spaced along a polyline part for a glyph run, in [lat, lon].
//
// Spacing is GEOGRAPHIC, not per-vertex: a part drawn with three clicks and one
// drawn with forty must produce the same row of trees. `everyKm` is a target —
// the real spacing is evened out so the run starts and ends inside the part
// rather than trailing off.
// Exports render at one fixed scale, so they use one fixed spacing; the
// editor varies it with zoom. The cap is what keeps a whole-city PNG from
// disappearing under tree glyphs.
export const EXPORT_GLYPH_KM = 0.08;
export const EXPORT_GLYPH_MAX = 20;

export function glyphRunPoints(part, everyKm = 0.06, max = 24) {
  if (!part || part.length < 2) return [];
  const seg = [];
  let total = 0;
  for (let i = 1; i < part.length; i++) {
    const d = haversineKm(part[i - 1], part[i]);
    seg.push(d); total += d;
  }
  if (total <= 0) return [];
  const n = Math.max(1, Math.min(max, Math.round(total / Math.max(everyKm, 1e-6))));
  const step = total / (n + 1);            // n interior points, evenly spread
  const out = [];
  let target = step, walked = 0, i = 0;
  while (out.length < n && i < seg.length) {
    if (walked + seg[i] < target) { walked += seg[i]; i++; continue; }
    const f = seg[i] > 0 ? (target - walked) / seg[i] : 0;
    const [aLat, aLon] = part[i], [bLat, bLon] = part[i + 1];
    out.push([aLat + (bLat - aLat) * f, aLon + (bLon - aLon) * f]);
    target += step;
  }
  return out;
}

const EARTH_KM = 6371.0088;
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Status is carried by line STYLE, which leaves colour free for phase or
// treatment. Solid = on the ground; the rest get progressively airier dashes.
export function dashFor(status) {
  switch (status) {
    case "existing": return null;
    case "under_construction": return "2,6";
    case "funded": return "10,6";
    default: return "6,6";               // proposed
  }
}

export const pointColor = (t) => (t.status === "existing"
  ? POINT_EXISTING_COLOR : POINT_PROPOSED_COLOR);

// What to call a feature on the map: its name without any trailing "(A to B)"
// qualifier — so multi-part corridors share one label — or the on_street as a
// fallback. Empty string = don't label.
export function labelText(f) {
  let name = (f.name || "").trim();
  if (DEFAULT_NAMES.has(name.toLowerCase())) name = "";
  name = name.replace(/\s*\([^)]*\)$/, "");
  return name || (f.on_street || "").trim();
}

// The chevron rotation (CSS degrees) for the midpoint of a line part: screen
// angle where x = east, y = SOUTH; lon degrees shrink by cos(lat).
export function chevron(part) {
  const k = Math.max(1, Math.floor(part.length / 2));
  const [lat1, lon1] = part[k - 1];
  const [lat2, lon2] = part[k];
  const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const theta = (Math.atan2(-(lat2 - lat1), dx) * 180) / Math.PI;
  return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2, theta };
}

// Every colour a rendered map draws with. The GIF encoder reserves these so a
// basemap full of pale pixels can't crowd the network's own colours out of the
// 256-entry palette.
export function mapPalette() {
  return [
    ...Object.values(PHASE_COLORS),
    ...registry().all().map((t) => t.color).filter(Boolean),
    SINGLE_COLOR, EXISTING_COLOR, UNDER_CONSTRUCTION_COLOR, FUNDED_COLOR,
    BOUNDARY_COLOR, UNKNOWN_COLOR, POINT_PROPOSED_COLOR, POINT_EXISTING_COLOR,
    "#ffffff", "#000000", "#555555", "#1a1a1a", "#eef0ef", "#cccccc",
  ];
}

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)];
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
