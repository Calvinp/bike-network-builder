// Render the network to a standalone interactive Leaflet HTML file — the web
// port of bikenetwork/render_html.py (which uses folium). Same behavior: one
// toggleable layer per legend category, popups/tooltips, a fixed legend box,
// and plain rotated-DivIcon chevrons for one-way paths (NO TextPath-style
// plugins — that crashed the folium map at runtime once).
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR, STATE_COLOR,
  TYPE_COLORS, chevron, escapeHtml, labelText, pathColor, phaseColor,
  spotColor, spotGlyph, spotLabel, typeLabel,
} from "./render_common.js";
import { phaseMap } from "./network_format.js";

const phaseKey = (n, phases) => {
  const cfg = phases.get(n);
  return (cfg && cfg.label ? `Phase ${n}: ${cfg.label}` : `Phase ${n}`).trim();
};

// In a phased plan, proposed paths group by PHASE regardless of color mode so
// the slider can step through them cumulatively (coloring still follows the
// color mode). `order` sorts the layer checklist sensibly.
function groupName(p, colorMode, phases, phased) {
  if (p.status === "existing") return ["Existing infrastructure", [0, 0]];
  if (p.status === "funded") return ["Approved / funded (not yet built)", [1, 0]];
  if (phased) {
    const named = p.phase !== null && p.phase !== undefined;
    return [named ? phaseKey(p.phase, phases) : "Proposed",
            [2, named ? p.phase : 1e6]];
  }
  if (colorMode === "single") return ["Bike network (proposed)", [2, 0]];
  if (colorMode === "type") return [typeLabel(p.type), [2, 0]];
  if (p.jurisdiction === "state") {
    return ["On a state road (MassDOT approval needed)", [2, 0]];
  }
  return [phaseKey(p.phase, phases), [2, p.phase || 0]];
}

function legendHtml(net, colorMode, paths, spots, bottomPx) {
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
  // One row per spot kind present; the glyph lives in the label text.
  const kinds = [...new Set((spots || []).map((s) => s.type))];
  for (const kind of kinds) {
    rows += `<div><span style="width:14px;display:inline-block;margin-right:6px;`
      + `text-align:center;font-weight:bold;">${spotGlyph(kind)}</span>`
      + `${escapeHtml(spotLabel(kind))}</div>`;
  }
  return `
    <div style="position:fixed;bottom:${bottomPx}px;left:24px;z-index:9999;background:white;
         padding:10px 12px;border:1px solid #999;border-radius:6px;font:12px sans-serif;
         box-shadow:0 1px 4px rgba(0,0,0,.3);">
      <b>${escapeHtml(net.city)} Bike Network</b>${rows}
    </div>`;
}

export function renderHtml(paths, net, {
  boundary = null, colorMode = "type", spots = [], contextLayers = [],
} = {}) {
  const phases = phaseMap(net);
  const phased = Boolean(net.phases && net.phases.length)
    && paths.some((p) => p.status === "proposed"
      && p.phase !== null && p.phase !== undefined);
  const groups = new Map();   // key -> {features, order, phase}
  const groupFor = (p) => {
    const [key, order] = groupName(p, colorMode, phases, phased);
    if (!groups.has(key)) groups.set(key, { features: [], order, phase: null });
    const g = groups.get(key);
    if (phased && p.status === "proposed" && p.phase !== null
        && p.phase !== undefined) {
      g.phase = p.phase;
    }
    return g.features;
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
      id: p.id || "",
      upgrades: p.upgrades || "",
      phase: p.status === "proposed" ? p.phase : null,
    });
  }

  const pts = paths.flatMap((p) => p.segments.flat());
  const center = pts.length
    ? [pts.reduce((s, q) => s + q[0], 0) / pts.length,
       pts.reduce((s, q) => s + q[1], 0) / pts.length]
    : [42.4251, -71.0662];

  // Slider stops: Today, then each phase that has proposed work.
  const phaseNums = [...new Set([...groups.values()]
    .map((g) => g.phase).filter((n) => n !== null))].sort((a, b) => a - b);
  const stops = [{ n: 0, caption: "Today" }];
  for (const n of phaseNums) {
    const cfg = phases.get(n);
    let caption = `Phase ${n}`;
    if (cfg && cfg.label) caption += `: ${cfg.label}`;
    if (cfg && cfg.deadline) caption += ` — by ${cfg.deadline}`;
    stops.push({ n, caption });
  }
  if (stops.length > 1) {
    stops[stops.length - 1].caption += " (full network)";
  }
  const firstPhase = phaseNums.length ? phaseNums[0] : 1;

  const data = {
    city: net.city,
    center,
    boundary: boundary || [],
    groups: [...groups.entries()]
      .sort((a, b) => (a[1].order[0] - b[1].order[0])
                      || (a[1].order[1] - b[1].order[1]))
      .map(([name, g]) => ({ name, features: g.features, phase: g.phase })),
    spots: (spots || []).filter((s) => s.location).map((s) => ({
      lat: s.location[0],
      lon: s.location[1],
      glyph: spotGlyph(s.type),
      color: spotColor(s),
      tooltip: escapeHtml(s.name || spotLabel(s.type)),
      popup: `<b>${escapeHtml(s.name || spotLabel(s.type))}</b><br>`
        + (s.status === "existing" ? escapeHtml(spotLabel(s.type))
           : `Proposed ${escapeHtml(spotLabel(s.type).toLowerCase())}`)
        + (s.status === "proposed" && s.phase !== null && s.phase !== undefined
           ? ` &middot; Phase ${s.phase}` : "")
        + (s.notes ? `<br><i>${escapeHtml(s.notes)}</i>` : ""),
      // Proposed spots appear once the slider reaches their phase.
      phase: s.status === "proposed"
        ? (s.phase === null || s.phase === undefined ? firstPhase : s.phase)
        : null,
    })),
    layers: (contextLayers || []).map(({ entry, geojson }) => ({
      label: entry.label || entry.id,
      color: (entry.style || {}).color || "#666666",
      radius: (entry.style || {}).radius || 4,
      geojson,
    })),
    stops: phased ? stops : [],
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
  .spot-glyph { background: none; border: none; }
  .spot-glyph div { font-size: 14px; font-weight: bold; line-height: 16px;
    text-align: center;
    text-shadow: 0 0 2px #fff, 0 0 3px #fff, 0 0 4px #fff; }
${phased ? `  #phase-slider-box { position: fixed; bottom: 24px; left: 50%;
    transform: translateX(-50%); z-index: 9999; background: white;
    padding: 10px 16px; border: 1px solid #999; border-radius: 6px;
    font: 13px sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,.3);
    text-align: center; min-width: 240px; }
  #phase-slider-label { font-weight: bold; margin-bottom: 4px; }
  #phase-slider { width: 100%; }` : ""}
</style>
</head>
<body>
<div id="map"></div>
${legendHtml(net, colorMode, paths, spots, phased ? 96 : 24)}
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
var phaseGroups = [];        // [phase, group] for the slider
var layersById = {};         // path id -> [leaflet layers], for supersession
var groupLayers = [];        // one Leaflet group per DATA.groups entry
DATA.groups.forEach(function (group) {
  var g = L.featureGroup();
  groupLayers.push(g);
  group.features.forEach(function (f) {
    var line = L.polyline(f.latlngs, {
      color: f.color, weight: f.weight, opacity: 0.9,
      dashArray: f.dash || null, lineCap: "round",
    }).bindPopup(f.popup, {maxWidth: 300}).bindTooltip(f.tooltip);
    line.addTo(g);
    everything.push(line);
    if (f.id) {
      layersById[f.id] = (layersById[f.id] || []).concat([[line, g]]);
    }
    f.arrows.forEach(function (a) {
      var marker = L.marker([a.lat, a.lon], {
        interactive: false,
        icon: L.divIcon({
          className: "dir-arrow", iconSize: [16, 16], iconAnchor: [8, 8],
          html: '<div style="transform:rotate(' + a.theta.toFixed(0) + 'deg);'
            + 'font-size:15px;font-weight:bold;color:#1a1a1a;line-height:16px;'
            + 'text-align:center;text-shadow:0 0 2px #fff,0 0 3px #fff,'
            + '0 0 4px #fff;">\\u27A4</div>',
        }),
      });
      marker.addTo(g);
      if (f.id) layersById[f.id] = layersById[f.id].concat([[marker, g]]);
    });
  });
  g.addTo(map);
  overlays[group.name] = g;
  if (group.phase !== null && group.phase !== undefined) {
    phaseGroups.push([group.phase, g]);
  }
});

// Spot (point) improvements: one toggleable group of glyph markers.
var spotEntries = [];
if (DATA.spots.length) {
  var spotsGroup = L.featureGroup();
  DATA.spots.forEach(function (s) {
    var marker = L.marker([s.lat, s.lon], {
      icon: L.divIcon({
        className: "spot-glyph", iconSize: [16, 16], iconAnchor: [8, 8],
        html: '<div style="color:' + s.color + '">' + s.glyph + '</div>',
      }),
    }).bindPopup(s.popup, {maxWidth: 250}).bindTooltip(s.tooltip);
    marker.addTo(spotsGroup);
    if (s.phase !== null && s.phase !== undefined) {
      spotEntries.push({layer: marker, group: spotsGroup, phase: s.phase});
    }
  });
  spotsGroup.addTo(map);
  overlays["Spot improvements"] = spotsGroup;
}

// Reference layers: off by default, drawn on a shared canvas so thousands of
// points stay smooth.
if (DATA.layers.length) {
  var contextRenderer = L.canvas({padding: 0.5});
  DATA.layers.forEach(function (spec) {
    overlays[spec.label] = L.geoJSON(spec.geojson, {
      renderer: contextRenderer,
      pointToLayer: function (feat, ll) {
        return L.circleMarker(ll, {
          renderer: contextRenderer, radius: spec.radius, color: spec.color,
          weight: 1, fillColor: spec.color, fillOpacity: 0.55, opacity: 0.8,
        });
      },
      style: function () {
        return {color: spec.color, weight: 2, opacity: 0.7};
      },
      onEachFeature: function (feat, layer) {
        var props = feat.properties || {};
        var rows = Object.keys(props).filter(function (k) {
          return props[k] !== null && props[k] !== "" && typeof props[k] !== "object";
        }).slice(0, 6).map(function (k) {
          return "<div><b>" + k + "</b>: " + String(props[k]) + "</div>";
        }).join("");
        layer.bindPopup("<b>" + spec.label + "</b>" + (rows || "<i>(no details)</i>"),
                        {maxWidth: 260});
      },
    });
  });
}
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

${!phased ? "" : `
// Phase slider: steps Today -> Phase 1 -> ... -> the full network, showing
// phase groups cumulatively and hiding paths a shown later phase upgrades.
if (DATA.stops.length > 1) {
  var box = document.createElement("div");
  box.id = "phase-slider-box";
  box.innerHTML = '<div id="phase-slider-label"></div>'
    + '<input id="phase-slider" type="range" min="0" max="'
    + (DATA.stops.length - 1) + '" step="1" value="'
    + (DATA.stops.length - 1) + '">';
  document.body.appendChild(box);

  // A replaced path steps aside only while its replacement is actually on
  // screen. Turning the upgrade's phase off in the layer list has to bring
  // the original back, or that corridor would vanish from the map entirely.
  var hidden = [];
  DATA.groups.forEach(function (group, gi) {
    group.features.forEach(function (f) {
      if (f.upgrades && f.phase !== null && f.phase !== undefined) {
        (layersById[f.upgrades] || []).forEach(function (pair) {
          hidden.push({layer: pair[0], group: pair[1], phase: f.phase,
                       replacement: groupLayers[gi]});
        });
      }
    });
  });

  var slider = document.getElementById("phase-slider");
  var label = document.getElementById("phase-slider-label");
  var applying = false;

  // What the slider position alone decides: which phase groups are on.
  function applyGroups(cur) {
    phaseGroups.forEach(function (pg) {
      if (pg[0] <= cur) map.addLayer(pg[1]);
      else map.removeLayer(pg[1]);
    });
  }

  // What the slider AND the layer checkboxes together decide. Kept separate
  // so ticking a box off doesn't get instantly overruled by the slider.
  function applyOverrides(cur) {
    hidden.forEach(function (h) {
      var replacementShown = h.phase <= cur && map.hasLayer(h.replacement);
      if (replacementShown) h.group.removeLayer(h.layer);
      else if (!h.group.hasLayer(h.layer)) h.group.addLayer(h.layer);
    });
    spotEntries.forEach(function (s) {
      if (s.phase <= cur) {
        if (!s.group.hasLayer(s.layer)) s.group.addLayer(s.layer);
      } else s.group.removeLayer(s.layer);
    });
    syncDirArrows();
  }

  function current() { return DATA.stops[Number(slider.value)].n; }
  function applyPhase() {
    applying = true;
    label.textContent = DATA.stops[Number(slider.value)].caption;
    applyGroups(current());
    applyOverrides(current());
    applying = false;
  }
  slider.addEventListener("input", applyPhase);
  // Toggling an overlay changes what "is the replacement showing?" answers.
  map.on("overlayadd overlayremove", function () {
    if (!applying) applyOverrides(current());
  });
  applyPhase();
}
`}
</script>
</body>
</html>
`;
}
