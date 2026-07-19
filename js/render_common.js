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
};
export const TYPE_LABELS = {
  quick_build_separated: "Quick-build separated lane",
  concrete_separated: "Concrete-protected lane",
  shared_use_path: "Shared-use path",
  buffered_painted: "Buffered painted lane (interim)",
  neighborway: "Neighborway (calm shared street)",
};
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

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
