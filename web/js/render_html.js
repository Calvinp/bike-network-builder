// Render the network to a standalone interactive Leaflet HTML file — the web
// port of bikenetwork/render_html.py (which uses folium). Same behavior: one
// toggleable layer per legend category, popups/tooltips, a fixed legend box,
// and plain rotated-DivIcon chevrons for one-way paths (NO TextPath-style
// plugins — that crashed the folium map at runtime once).
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR, STATE_COLOR,
  TYPE_COLORS, chevron, escapeHtml, labelText, pathColor, phaseColor, typeLabel,
} from "./render_common.js";
import { phaseMap } from "./network_format.js";

function groupName(p, colorMode, phases) {
  if (p.status === "existing") return "Existing infrastructure";
  if (p.status === "funded") return "Approved / funded (not yet built)";
  if (colorMode === "single") return "Bike network (proposed)";
  if (colorMode === "type") return typeLabel(p.type);
  if (p.jurisdiction === "state") return "On a state road (MassDOT approval needed)";
  const cfg = phases.get(p.phase);
  return (cfg && cfg.label ? `Phase ${p.phase}: ${cfg.label}` : `Phase ${p.phase}`).trim();
}

function legendHtml(net, colorMode, paths) {
  const row = (color, label, dashed = false) =>
    `<div><span style="border-top:4px ${dashed ? "dashed" : "solid"} ${color};`
    + `width:14px;display:inline-block;margin-right:6px;"></span>${label}</div>`;

  let rows = "";
  if (colorMode === "phase") {
    const phases = phaseMap(net);
    for (const ph of [...phases.keys()].sort((a, b) => a - b)) {
      rows += row(phaseColor(ph), `Phase ${ph}: ${phases.get(ph).label}`);
    }
    rows += row(STATE_COLOR, "On a state road (MassDOT approval)");
  } else if (colorMode === "type") {
    const seen = new Set(paths.map((p) => p.type));
    for (const t of Object.keys(TYPE_COLORS).filter((t) => seen.has(t))) {
      rows += row(TYPE_COLORS[t], typeLabel(t));
    }
  } else {
    rows += row(SINGLE_COLOR, "Bike network (proposed)");
  }
  if (paths.some((p) => p.status === "funded")) {
    rows += row(colorMode === "phase" ? FUNDED_COLOR : "#555555",
                "Approved / funded (not yet built)", true);
  }
  if (paths.some((p) => p.status === "existing")) {
    rows += row(colorMode === "phase" ? EXISTING_COLOR : "#555555",
                "Existing infrastructure", true);
  }
  return `
    <div style="position:fixed;bottom:24px;left:24px;z-index:9999;background:white;
         padding:10px 12px;border:1px solid #999;border-radius:6px;font:12px sans-serif;
         box-shadow:0 1px 4px rgba(0,0,0,.3);">
      <b>${escapeHtml(net.city)} Bike Network</b>${rows}
    </div>`;
}

export function renderHtml(paths, net, { boundary = null, colorMode = "type" } = {}) {
  const phases = phaseMap(net);
  const groups = new Map();   // insertion-ordered, like folium
  const groupFor = (p) => {
    const key = groupName(p, colorMode, phases);
    if (!groups.has(key)) groups.set(key, []);
    return groups.get(key);
  };

  for (const p of paths) {
    const segs = p.segments.filter((s) => s.length >= 2);
    if (!segs.length) continue;
    let weight, dash;
    if (p.status === "existing") { weight = 4; dash = "6,5"; }
    else if (p.status === "funded") { weight = 5; dash = "10,4"; }
    else { weight = 6; dash = null; }
    let detail = typeLabel(p.type);
    if (p.status === "proposed" && p.phase !== null && p.phase !== undefined) {
      detail = `Phase ${p.phase} &middot; ` + detail;
    } else if (p.status !== "proposed") {
      detail = `${p.status[0].toUpperCase()}${p.status.slice(1)} &middot; ` + detail;
    }
    const popup = `<b>${escapeHtml(p.name)}</b><br>${escapeHtml(p.on_street)}<br>${detail}`
      + (p.length_miles ? `<br>${p.length_miles.toFixed(2)} mi` : "")
      + (p.notes ? `<br><i>${escapeHtml(p.notes)}</i>` : "");
    groupFor(p).push({
      latlngs: segs.length === 1 ? segs[0] : segs,
      color: pathColor(p, colorMode),
      weight, dash, popup,
      tooltip: escapeHtml(p.name),
      arrows: p.directions === 1 ? segs.map(chevron) : [],
    });
  }

  const pts = paths.flatMap((p) => p.segments.flat());
  const center = pts.length
    ? [pts.reduce((s, q) => s + q[0], 0) / pts.length,
       pts.reduce((s, q) => s + q[1], 0) / pts.length]
    : [42.4251, -71.0662];

  const data = {
    city: net.city,
    center,
    boundary: boundary || [],
    groups: [...groups.entries()].map(([name, features]) => ({ name, features })),
  };
  // <-escape so "</script>" can never appear inside the embedded JSON.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(net.city)} Bike Network</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  .dir-arrow { background: none; border: none; }
</style>
</head>
<body>
<div id="map"></div>
${legendHtml(net, colorMode, paths)}
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var DATA = ${json};
var map = L.map("map", {zoomControl: true}).setView(DATA.center, 14);
L.control.scale().addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 20}
).addTo(map);
var overlays = {};
var everything = [];
if (DATA.boundary.length) {
  var b = L.featureGroup();
  DATA.boundary.forEach(function (ring) {
    L.polyline(ring, {color: "#222222", weight: 2, dashArray: "8,6", opacity: 0.8})
      .addTo(b);
  });
  b.addTo(map);
  overlays[DATA.city + " boundary"] = b;
}
DATA.groups.forEach(function (group) {
  var g = L.featureGroup();
  group.features.forEach(function (f) {
    var line = L.polyline(f.latlngs, {
      color: f.color, weight: f.weight, opacity: 0.9,
      dashArray: f.dash || null, lineCap: "round",
    }).bindPopup(f.popup, {maxWidth: 300}).bindTooltip(f.tooltip);
    line.addTo(g);
    everything.push(line);
    f.arrows.forEach(function (a) {
      L.marker([a.lat, a.lon], {
        interactive: false,
        icon: L.divIcon({
          className: "dir-arrow", iconSize: [16, 16], iconAnchor: [8, 8],
          html: '<div style="transform:rotate(' + a.theta.toFixed(0) + 'deg);'
            + 'font-size:15px;font-weight:bold;color:#1a1a1a;line-height:16px;'
            + 'text-align:center;text-shadow:0 0 2px #fff,0 0 3px #fff,'
            + '0 0 4px #fff;">\\u27A4</div>',
        }),
      }).addTo(g);
    });
  });
  g.addTo(map);
  overlays[group.name] = g;
});
L.control.layers(null, overlays, {collapsed: false}).addTo(map);
if (everything.length) {
  map.fitBounds(L.featureGroup(everything).getBounds().pad(0.05));
}
// Chevrons are fixed-size icons; hide them when zoomed out far enough that
// they would dwarf the streets. overlayadd re-hides ones re-added via the
// layer control while zoomed out.
function syncDirArrows() {
  var show = map.getZoom() >= 14;
  document.querySelectorAll(".dir-arrow").forEach(function (el) {
    el.style.display = show ? "" : "none";
  });
}
map.on("zoomend overlayadd", syncDirArrows);
syncDirArrows();
</script>
</body>
</html>
`;
}
