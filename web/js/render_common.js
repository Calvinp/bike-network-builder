// Shared rendering vocabulary: the Okabe-Ito palette, per-mode path colors,
// and label helpers. Port of the constants/helpers in bikenetwork/render_map.py
// — the ONE place the palette lives in the web app (the Python renderers keep
// their own copies; keep them in step).
export const COLOR_MODES = ["phase", "type", "single"];

// Okabe-Ito palette — distinguishable for all common types of color blindness.
export const PHASE_COLORS = {
  1: "#0072B2",  // blue
  2: "#009E73",  // bluish green
  3: "#D55E00",  // vermillion
  4: "#E69F00",  // orange
  5: "#56B4E9",  // sky blue
};
export const TYPE_COLORS = {
  quick_build_separated: "#0072B2",
  concrete_separated: "#D55E00",
  shared_use_path: "#009E73",
  buffered_painted: "#E69F00",
  neighborway: "#56B4E9",
  // Reddish purple deliberately shared with STATE_COLOR: that color only
  // appears in phase mode, where type colors never draw.
  pedestrianized: "#CC79A7",
};
export const TYPE_LABELS = {
  quick_build_separated: "Quick-build separated lane",
  concrete_separated: "Concrete-protected lane",
  shared_use_path: "Shared-use path",
  buffered_painted: "Buffered painted lane (interim)",
  neighborway: "Neighborway (calm shared street)",
  pedestrianized: "Pedestrianized street",
};

// Spot (point) improvements: glyphs mirrored from render_map.py so the PNG,
// the interactive map and the editor all draw the same characters.
export const SPOT_GLYPHS = {
  speed_hump: "∩",
  raised_crosswalk: "▬",
  raised_intersection: "◆",
  curb_extension: "◖",
  modal_filter: "⊘",             // no through motor traffic
  bollards: "‖",                 // a line of posts
  retractable_bollards: "⇕",     // posts that drop and rise
  bike_parking: "P",
  street_trees: "T",
  other: "●",
};
export const SPOT_LABELS = {
  speed_hump: "Speed hump",
  raised_crosswalk: "Raised crosswalk",
  raised_intersection: "Raised intersection",
  curb_extension: "Curb extension",
  modal_filter: "Modal filter",
  bollards: "Bollards",
  retractable_bollards: "Retractable bollards",
  bike_parking: "Bike parking",
  street_trees: "Street trees",
  other: "Spot improvement",
};
export const SPOT_PROPOSED_COLOR = "#1a1a1a";
export const SPOT_EXISTING_COLOR = "#707070";

export const spotGlyph = (type) => SPOT_GLYPHS[type] || SPOT_GLYPHS.other;
export const spotLabel = (type) => SPOT_LABELS[type] || String(type).replace(/_/g, " ");
export const spotColor = (s) => (s.status === "existing"
  ? SPOT_EXISTING_COLOR : SPOT_PROPOSED_COLOR);
export const SINGLE_COLOR = "#0072B2";
export const EXISTING_COLOR = "#000000";
export const FUNDED_COLOR = "#E69F00";
export const STATE_COLOR = "#CC79A7";
export const BOUNDARY_COLOR = "#777777";

// Names the editor assigns to freshly-drawn paths — never worth labeling.
export const DEFAULT_NAMES = new Set(["new path", "existing path", "new corridor"]);

export const phaseColor = (phase) => PHASE_COLORS[phase] || "#000000";

// The line color for a path under a color mode (mirrors render_map.path_color).
export function pathColor(p, colorMode) {
  if (colorMode === "single") return SINGLE_COLOR;
  if (colorMode === "type") return TYPE_COLORS[p.type] || "#444444";
  if (p.status === "existing") return EXISTING_COLOR;
  if (p.status === "funded") return FUNDED_COLOR;
  if (p.jurisdiction === "state") return STATE_COLOR;
  return phaseColor(p.phase);
}

// What to call a path on the map: its name without any trailing "(A to B)"
// qualifier — so multi-segment corridors share one label — or the on_street
// as a fallback. Empty string = don't label.
export function labelText(p) {
  let name = (p.name || "").trim();
  if (DEFAULT_NAMES.has(name.toLowerCase())) name = "";
  name = name.replace(/\s*\([^)]*\)$/, "");
  return name || (p.on_street || "").trim();
}

export function typeLabel(t) {
  return TYPE_LABELS[t] || String(t).replace(/_/g, " ");
}

// The chevron rotation (CSS degrees) for the midpoint of a segment: screen
// angle where x = east, y = SOUTH; lon degrees shrink by cos(lat).
export function chevron(seg) {
  const k = Math.max(1, Math.floor(seg.length / 2));
  const [lat1, lon1] = seg[k - 1];
  const [lat2, lon2] = seg[k];
  const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const theta = (Math.atan2(-(lat2 - lat1), dx) * 180) / Math.PI;
  return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2, theta };
}

// Every color a rendered map draws with. The GIF encoder reserves these so a
// basemap full of pale pixels can't crowd the network's own colors out of the
// 256-entry palette. (Declared here, after the constants it collects.)
export const MAP_PALETTE = [
  ...Object.values(PHASE_COLORS), ...Object.values(TYPE_COLORS),
  SINGLE_COLOR, EXISTING_COLOR, FUNDED_COLOR, STATE_COLOR, BOUNDARY_COLOR,
  SPOT_PROPOSED_COLOR, SPOT_EXISTING_COLOR,
  "#ffffff", "#000000", "#555555", "#1a1a1a", "#eef0ef", "#cccccc",
];

export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16)];
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
