// Render the network to a standalone interactive Leaflet HTML file — the web
// port of bikenetwork/render_html.py (which uses folium). Same behavior: one
// toggleable layer per legend category, popups/tooltips, a fixed legend box,
// and plain rotated-DivIcon chevrons for one-way paths (NO TextPath-style
// plugins — that crashed the folium map at runtime once).
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, SINGLE_COLOR,
  EXPORT_GLYPH_KM, EXPORT_GLYPH_MAX, UNDER_CONSTRUCTION_COLOR, chevron,
  dashFor, drawsAsGlyphs, escapeHtml, featureLayers, glyphRunPoints,
  phaseColor, pointColor, treatmentColor, treatmentGlyph, treatmentLabel,
} from "./render_common.js";
import { registry } from "./registry.js";

const phaseKey = (phase) => (phase && phase.label
  ? `Phase ${phase.number}: ${phase.label}` : `Phase ${(phase || {}).number || "?"}`);

// In a phased plan, proposed treatments group by PHASE regardless of colour
// mode so the slider can step through them cumulatively (colouring still
// follows the colour mode). `order` sorts the layer checklist sensibly.
function groupName(t, phase, colorMode, phased) {
  if (t.status === "existing") return ["Existing infrastructure", [0, 0]];
  if (t.status === "under_construction") return ["Under construction", [1, 0]];
  if (t.status === "funded") return ["Approved / funded (not yet built)", [2, 0]];
  if (phased) {
    return [phase ? phaseKey(phase) : "Proposed",
            [3, phase ? phase.number : 1e6]];
  }
  if (colorMode === "single") return ["Bike network (proposed)", [3, 0]];
  if (colorMode === "treatment") return [treatmentLabel(t.type), [3, 0]];
  return [phase ? phaseKey(phase) : "Proposed", [3, phase ? phase.number : 0]];
}

function legendHtml(net, colorMode, rows_, bottomPx) {
  const row = (color, label, dash = null) =>
    `<div><span style="border-top:4px ${dash ? "dashed" : "solid"} ${color};`
    + `width:14px;display:inline-block;margin-right:6px;"></span>${label}</div>`;

  const linear = rows_.filter((r) => r.isLine);
  let rows = "";
  if (colorMode === "phase") {
    for (const p of [...net.phases].sort((a, b) => a.number - b.number)) {
      rows += row(phaseColor(p.number), escapeHtml(phaseKey(p)));
    }
  } else if (colorMode === "treatment") {
    // One row per treatment actually present, in registry draw order — never
    // one row per COMBINATION, which would be unreadable.
    const seen = [...new Set(linear.map((r) => r.t.type))];
    for (const spec of registry().sortedForDraw(seen)) {
      rows += row(treatmentColor(spec.id), escapeHtml(spec.label));
    }
  } else {
    rows += row(SINGLE_COLOR, "Bike network (proposed)");
  }
  for (const [status, color, label] of [
    ["funded", FUNDED_COLOR, "Approved / funded (not yet built)"],
    ["under_construction", UNDER_CONSTRUCTION_COLOR, "Under construction"],
    ["existing", EXISTING_COLOR, "Existing infrastructure"]]) {
    if (linear.some((r) => r.t.status === status)) {
      rows += row(colorMode === "phase" ? color : "#555555", label,
                  dashFor(status));
    }
  }
  // One row per point treatment present; the glyph lives in the label text.
  const glyphTypes = [...new Set(rows_.filter((r) => !r.isLine)
    .map((r) => r.t.type))];
  for (const type of glyphTypes) {
    rows += `<div><span style="width:14px;display:inline-block;margin-right:6px;`
      + `text-align:center;font-weight:bold;">${treatmentGlyph(type)}</span>`
      + `${escapeHtml(treatmentLabel(type))}</div>`;
  }
  const note = net.costsAdjusted
    ? `<div style="margin-top:6px;font-size:11px;color:#555;">`
      + `Cost figures adjusted by the author.</div>` : "";
  return `
    <div style="position:fixed;bottom:${bottomPx}px;left:24px;z-index:9999;background:white;
         padding:10px 12px;border:1px solid #999;border-radius:6px;font:12px sans-serif;
         box-shadow:0 1px 4px rgba(0,0,0,.3);">
      <b>${escapeHtml(net.displayName || "Bike Network")} Bike Network</b>${rows}${note}
    </div>`;
}

export function renderHtml(features, net, {
  boundary = null, colorMode = "treatment", contextLayers = [],
} = {}) {
  const phases = net.phaseMap();
  const phaseOf = (t) => (t.phase ? phases.get(t.phase) || null : null);
  const phaseNumberOf = (id) => {
    const p = phases.get(id);
    return p ? p.number : null;
  };
  const phased = Boolean(net.phases && net.phases.length)
    && features.some((f) => f.treatments.some(
      (t) => t.status === "proposed" && t.phase));

  const groups = new Map();   // key -> {features, order, phase}
  const groupFor = (t) => {
    const phase = phaseOf(t);
    const [key, order] = groupName(t, phase, colorMode, phased);
    if (!groups.has(key)) groups.set(key, { features: [], order, phase: null });
    const g = groups.get(key);
    if (phased && t.status === "proposed" && phase) g.phase = phase.number;
    return g.features;
  };

  // Every treatment on a feature is drawn — stacked strokes on one geometry,
  // widest first. Nothing reads treatments[0] as primary.
  const legendRows = [];
  const points = [];
  for (const f of features) {
    const lines = f.lines();
    // Counted treatments on a LINE (a row of street trees) draw as repeated
    // glyphs, not as a stroke — see featureLayers.
    const { strokes, glyphRuns, spine } = featureLayers(f, colorMode,
                                                        { phaseNumberOf });
    for (const stroke of [...strokes, ...glyphRuns]) {
      const t = stroke.treatment;
      const spec = registry().get(t.type);
      const phase = phaseOf(t);
      let detail = escapeHtml(treatmentLabel(t.type));
      if (t.status === "proposed" && phase) {
        detail = `${escapeHtml(phaseKey(phase))} &middot; ` + detail;
      } else if (t.status !== "proposed") {
        const s2 = t.status.replace(/_/g, " ");
        detail = `${s2[0].toUpperCase()}${s2.slice(1)} &middot; ` + detail;
      }
      if (t.quantity) detail += ` &middot; ${t.quantity} ${escapeHtml(spec.unit)}`;
      const popup = `<b>${escapeHtml(f.name)}</b><br>`
        + (f.on_street ? `${escapeHtml(f.on_street)}<br>` : "")
        + detail
        + (f.length_km ? `<br>${f.length_km.toFixed(2)} km` : "")
        + (f.notes ? `<br><i>${escapeHtml(f.notes)}</i>` : "");

      if (lines.length && drawsAsGlyphs(t.type)) {
        // A row of them reads as spots, so it goes in the legend as one.
        legendRows.push({ t, isLine: false });
        // With no real stroke on the feature there is nothing to show its
        // extent or carry its popup, so lay a hairline under the glyphs.
        if (spine && stroke === glyphRuns[0]) {
          groupFor(t).push({
            latlngs: lines.length === 1 ? lines[0] : lines,
            color: stroke.color, weight: 2, dash: "1,6",
            popup, tooltip: escapeHtml(f.name), arrows: [],
            id: t.id || "", upgrades: (t.upgrades || []).join(" "),
            phase: t.status === "proposed" && phase ? phase.number : null,
          });
        }
        for (const part of lines) {
          for (const pt of glyphRunPoints(part, EXPORT_GLYPH_KM, EXPORT_GLYPH_MAX)) {
            points.push({
              lat: pt[0], lon: pt[1],
              glyph: treatmentGlyph(t.type), color: stroke.color,
              tooltip: escapeHtml(f.name || treatmentLabel(t.type)), popup,
              phase: t.status === "proposed" ? (phase ? phase.number : 1) : null,
            });
          }
        }
      } else if (lines.length) {
        legendRows.push({ t, isLine: true });
        groupFor(t).push({
          latlngs: lines.length === 1 ? lines[0] : lines,
          color: stroke.color,
          weight: stroke.weight,
          dash: stroke.dashArray,
          popup,
          tooltip: escapeHtml(f.name),
          // A superseded treatment draws no chevron when its replacement is on
          // the same map: the upgrade covers the old line exactly, so only the
          // stale arrow would show, claiming the new lane is one-way.
          arrows: t.travel === "one_way" ? lines.map(chevron) : [],
          id: t.id || "",
          upgrades: (t.upgrades || []).join(" "),
          phase: t.status === "proposed" && phase ? phase.number : null,
        });
      }
      for (const pt of f.points()) {
        legendRows.push({ t, isLine: false });
        points.push({
          lat: pt[0], lon: pt[1],
          glyph: treatmentGlyph(t.type),
          color: pointColor(t),
          tooltip: escapeHtml(f.name || treatmentLabel(t.type)),
          popup,
          phase: t.status === "proposed" ? (phase ? phase.number : 1) : null,
        });
      }
    }
  }

  const pts = features.flatMap((f) => f.geometry.flat());
  const center = pts.length
    ? [pts.reduce((s, q) => s + q[0], 0) / pts.length,
       pts.reduce((s, q) => s + q[1], 0) / pts.length]
    : [0, 0];

  // Slider stops: Today, then each phase that has proposed work.
  const phaseNums = [...new Set([...groups.values()]
    .map((g) => g.phase).filter((n) => n !== null))].sort((a, b) => a - b);
  const stops = [{ n: 0, caption: "Today" }];
  for (const n of phaseNums) {
    const cfg = [...phases.values()].find((p) => p.number === n);
    let caption = `Phase ${n}`;
    if (cfg && cfg.label) caption += `: ${cfg.label}`;
    if (cfg && cfg.target_date) caption += ` — by ${cfg.target_date}`;
    stops.push({ n, caption });
  }
  if (stops.length > 1) {
    stops[stops.length - 1].caption += " (full network)";
  }
  const firstPhase = phaseNums.length ? phaseNums[0] : 1;

  const data = {
    city: net.displayName || "",
    center,
    boundary: boundary || [],
    groups: [...groups.entries()]
      .sort((a, b) => (a[1].order[0] - b[1].order[0])
                      || (a[1].order[1] - b[1].order[1]))
      .map(([name, g]) => ({ name, features: g.features, phase: g.phase })),
    // Point treatments, drawn as glyph markers. A proposed one with no phase
    // is part of the plan but unscheduled: it appears at the first stop.
    spots: points.map((pt) => ({
      ...pt, phase: pt.phase === null ? null : (pt.phase || firstPhase),
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
${legendHtml(net, colorMode, legendRows, phased ? 96 : 24)}
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
