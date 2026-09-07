/* Bike network builder — the editor.
 *
 * Leaflet + Geoman, everything client-side: state lives in localStorage
 * (Store), exports render in the browser (buildArtifacts / renderPng /
 * zipCreate), and snap-to-road runs on a street graph fetched as a static
 * asset.
 *
 * ## The v2 model
 *
 * A FEATURE is a place; its TREATMENTS are the things built there. One
 * corridor can carry a bike lane and a row of trees and a later streetcar,
 * each with its own status, phase and authority — so the editor selects a
 * feature and then edits one of its treatments at a time.
 *
 * On the map a feature draws EVERY treatment it carries, as stacked strokes
 * on one geometry: `f.layer` carries the widest stroke and owns the geometry
 * (it is the one Geoman edits), and `f.overlays` are the narrower ones drawn
 * on top. Nothing reads `treatments[0]` as primary — order comes from the
 * registry's stack_rank, so shuffling the list changes nothing.
 */
"use strict";

import { buildArtifacts, buildPhaseArtifacts, shouldSplitByArea, splitByArea }
  from "./js/export.js";
import { boundaryFromWays, clipPolylineLatlon, normalizeBoundary,
         pointInBoundary, splitBoundaryEdges } from "./js/boundary.js";
import { featuresFromGeojson, featuresToGeojson } from "./js/geojson.js";
import { renderPng } from "./js/render_png.js";
import { registry } from "./js/registry.js";
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, PHASE_COLORS, SINGLE_COLOR,
  MIN_SPOT_ZOOM, MIN_STACK_ZOOM, UNDER_CONSTRUCTION_COLOR, featureLayers,
  glyphRunPoints, pointColor, treatmentGlyph,
  treatmentLabel,
} from "./js/render_common.js";
import { KM_PER_MI, MI_PER_KM } from "./js/costs.js";
import { makeArea, makeFeature, makeNetwork, makePhase, makeTreatment,
         newId, parseNetwork, serializeNetwork }
  from "./js/network_format.js";
import { applyMerge, describeMerge, licenseConflict, planMerge }
  from "./js/merge.js";
import { assignAreas, partsKm, summarize } from "./js/pipeline.js";
import { snapRoute } from "./js/routing.js";
import { Store } from "./js/store.js";
import { areaAt, areaBoundary, censusId, nearbyAreas, searchAreas, stateAbbr }
  from "./js/census.js";
import { MAX_AREA_SQKM, OverpassSession, bboxAreaSqKm, bboxOfBoundary,
         featuresFromOverpass, isHeavy } from "./js/osm.js";
import { History } from "./js/history.js";
import { zipCreate } from "./js/zip.js";

const BOUNDARY = BOUNDARY_COLOR;
// The outer edge has to out-shout the basemap's own town borders.
const BOUNDARY_STRONG = "#334155";

const store = new Store();
let baseNet = null;         // last parsed stored network (uneditable fields)
let place = null;           // the deployment default area (data/place.json)

let map, networkGroup, boundaryGroup, arrowsGroup, pointsGroup, overlayGroup;
let maskGroup, glyphGroup, previewGroup;
let networkRenderer = null;
let features = [];          // [{props, treatments, sel, layer, overlays, markers, arrows}]
let selected = null;
let options = {};
let config = { areas: [], authorities: [], phases: [], units: "metric",
               costs: {}, meta: {} };
let units = "imperial";     // DISPLAY preference; storage is always metric
let colorMode = "treatment";
let phaseView = "all";
let dirty = false, combineFrom = null;

/* Undo/redo. Snapshots of the serialized network, bounded by bytes so a big
   network gets shallow history rather than eating the tab (see history.js).
   `restoring` guards the reload: applying a snapshot must not record itself as
   a new edit, or undo would never get anywhere. */
const history = new History();
let restoring = false;

/* ---------- units ---------- */
/* v2 stores metric. Imperial is a display preference, converted here and
   nowhere else, so no arithmetic ever depends on which one is showing. */
const showDist = (km) => (units === "metric" ? km : km * MI_PER_KM);
const distUnit = (lane) => (units === "metric"
  ? (lane ? "lane-km" : "corridor-km") : (lane ? "bike-lane-mi" : "corridor-mi"));

/* ---------- geometry helpers ---------- */
function haversineKm(a, b) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const la1 = a.lat * rad, la2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* A feature's line geometry is one or more parts (a combined corridor — a
   trail split by street crossings — is one feature with several). */
function segsOf(layer) {
  const l = layer.getLatLngs();
  return (l.length && Array.isArray(l[0])) ? l : [l];
}
function setSegs(layer, segs) { layer.setLatLngs(segs.length === 1 ? segs[0] : segs); }
function featureKm(f) {
  if (!f.layer) return 0;
  let km = 0;
  for (const pts of segsOf(f.layer)) {
    for (let i = 0; i < pts.length - 1; i++) km += haversineKm(pts[i], pts[i + 1]);
  }
  return km;
}
/* GeoJSON (any of the shapes geojson.js writes) -> {lines, points} in Leaflet
   coordinates. A feature may have both. */
function geometryToLeaflet(geom) {
  const lines = [], points = [];
  const walk = (g) => {
    if (!g) return;
    if (g.type === "GeometryCollection") { (g.geometries || []).forEach(walk); return; }
    const c = g.coordinates || [];
    if (g.type === "LineString" && c.length >= 2) {
      lines.push(c.map((q) => L.latLng(q[1], q[0])));
    } else if (g.type === "MultiLineString") {
      c.filter((s) => s.length >= 2).forEach((s) => lines.push(s.map((q) => L.latLng(q[1], q[0]))));
    } else if (g.type === "Point" && c.length === 2) {
      points.push(L.latLng(c[1], c[0]));
    } else if (g.type === "MultiPoint") {
      c.forEach((q) => points.push(L.latLng(q[1], q[0])));
    }
  };
  walk(geom);
  return { lines, points };
}

/* ---------- styling: stacked strokes ---------- */
const phaseNumberOf = (id) => {
  const p = config.phases.find((x) => x.id === id);
  return p ? p.number : null;
};
function layersFor(f) {
  return featureLayers({ treatments: f.treatments }, colorMode,
                       { phaseNumberOf, zoom: map ? map.getZoom() : undefined });
}
function strokeOpts(s, isSelected) {
  return { color: s.color, weight: s.weight + (isSelected ? 3 : 0),
           dashArray: s.dashArray, opacity: s.opacity === undefined ? 0.95 : s.opacity,
           lineCap: "round" };
}
/* A line whose treatments are ALL counted (a row of street trees) has no
   stroke of its own. It still needs a body: something to show it is one object
   spanning a block, and something to click. A hairline in the glyph's own
   colour reads as an annotation rather than as a facility — which is the whole
   complaint about the old black dashed line. */
function spineStroke(run) {
  return { color: run.color, weight: 2, dashArray: "1,6", opacity: 0.55 };
}
/* Glyphs are spaced by DISTANCE, so how far apart they look depends on zoom.
   Recomputed on zoomend (restyleAll), which keeps a row of trees legible when
   you zoom in and stops it turning into a smear when you zoom out. */
function glyphSpacingKm() {
  const z = map ? map.getZoom() : 15;
  return Math.min(2, Math.max(0.04, 0.06 * Math.pow(2, 16 - z)));
}
function glyphIcon(run) {
  return L.divIcon({ className: "run-glyph", iconSize: [16, 16], iconAnchor: [8, 8],
    html: `<div style="color:${run.color}">${run.glyph}</div>` });
}
/* Rebuild the glyph markers for a line feature's counted treatments. */
function syncGlyphs(f, runs) {
  f.glyphs.forEach((m) => glyphGroup.removeLayer(m));
  f.glyphs = [];
  if (!f.layer || !runs.length) return;
  // Nothing to build at all when they would not be shown. This is most of the
  // saving: at city zoom the expensive work simply does not happen.
  if (map && map.getZoom() < MIN_SPOT_ZOOM) return;
  const everyKm = glyphSpacingKm();
  const parts = segsOf(f.layer).map((seg) => seg.map((p) => [p.lat, p.lng]));
  runs.forEach((run) => {
    const icon = glyphIcon(run);
    parts.forEach((part) => {
      glyphRunPoints(part, everyKm).forEach((pt) => {
        const m = L.marker(pt, { icon, interactive: false, keyboard: false,
                                 pmIgnore: true });
        glyphGroup.addLayer(m);
        f.glyphs.push(m);
      });
    });
  });
}
/* The stroke count changes whenever treatments are added or removed, so the
   overlay layers are rebuilt rather than restyled. */
function restyle(f) {
  if (!f.layer) { syncMarkers(f); return; }
  const { strokes, glyphRuns, spine } = layersFor(f);
  const isSel = selected === f;
  const base = strokes[0]
    || (spine ? spineStroke(glyphRuns[0]) : { color: "#444", weight: 4 });
  f.layer.setStyle(strokeOpts(base, isSel));
  f.overlays.forEach((o) => overlayGroup.removeLayer(o));
  f.overlays = strokes.slice(1).map((s) => {
    const o = L.polyline(f.layer.getLatLngs(), {
      ...strokeOpts(s, isSel), interactive: false, pmIgnore: true,
      renderer: networkRenderer });
    overlayGroup.addLayer(o);
    return o;
  });
  if (isSel) { f.layer.bringToFront(); f.overlays.forEach((o) => o.bringToFront()); }
  syncGlyphs(f, glyphRuns);
  syncMarkers(f);
}
function restyleAll() { features.forEach(restyle); }
/* Overlays share the editable layer's geometry; anything that reshapes the
   line has to bring them along. */
function syncOverlays(f) {
  if (!f.layer) return;
  const ll = f.layer.getLatLngs();
  f.overlays.forEach((o) => o.setLatLngs(ll));
  // Glyphs sit AT positions along the line rather than sharing its geometry,
  // so reshaping has to place them again, not just hand them new latlngs.
  syncGlyphs(f, layersFor(f).glyphRuns);
}
/* Spots are drawn on the CANVAS, not as DOM markers.
   A real OSM import of Boston and Cambridge is 3,473 spots — 2,651 of them
   bike racks — and as `L.marker` divIcons that was 3,473 DOM elements for
   Leaflet to reposition on every pan and zoom. Hiding them below a zoom
   threshold only moved the problem to the first zoom where they appear, and a
   count-based threshold would make them blink in and out as you scrolled.
   Canvas has no such cliff: the same 3,473 cost about what one does.

   L.CircleMarker already gives us canvas drawing, hit-testing and a click
   event; only `_updatePath` is replaced, so the glyph is painted instead of a
   circle. The invisible radius is what stays clickable. */
const SpotMarker = L.CircleMarker.extend({
  options: { radius: 9, stroke: false, fill: false, glyph: "\u25cf",
             glyphColor: "#1a1a1a", big: true },
  _updatePath() {
    const r = this._renderer;
    const ctx = r && r._ctx;
    if (!ctx || !this._point) return;
    const { x, y } = this._point;
    ctx.save();
    if (!this.options.big) {
      // Zoomed out, a glyph is an illegible smudge and fillText is the
      // expensive call. A dot says "something is here" for a fraction of it.
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = this.options.glyphColor;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    } else {
      ctx.font = "bold 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // The same white halo the DOM version had, so a glyph stays readable
      // over a busy basemap.
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(this.options.glyph, x, y);
      ctx.fillStyle = this.options.glyphColor;
      ctx.fillText(this.options.glyph, x, y);
    }
    ctx.restore();
  },
});
const spotMarker = (latlng, t, big) => new SpotMarker(latlng, {
  renderer: networkRenderer, pmIgnore: true,
  glyph: treatmentGlyph(t.type), glyphColor: pointColor(t), big,
});

function syncMarkers(f) {
  const t = f.treatments[Math.min(f.sel, f.treatments.length - 1)] || f.treatments[0];
  if (!t) return;
  const big = !map || map.getZoom() >= MIN_SPOT_ZOOM;
  for (const m of f.markers) {
    m.options.glyph = treatmentGlyph(t.type);
    m.options.glyphColor = pointColor(t);
    m.options.big = big;
    if (m._renderer) m.redraw();
  }
  // NOT syncDragHandle() — restyle() calls this for EVERY feature, and the
  // handle belongs to the selection, not to each redraw.
}

/* The ONE DOM marker in the app: a drag handle for the selected spot.
   Everything is drawn on canvas, which cannot be dragged — so the thing being
   edited, and only that, gets the expensive interactive treatment. */
let dragHandle = null;
function syncDragHandle() {
  if (dragHandle) { pointsGroup.removeLayer(dragHandle); dragHandle = null; }
  if (!selected || !selected.markers.length) return;
  const m = selected.markers[0];
  const t = selected.treatments[Math.min(selected.sel,
                                         selected.treatments.length - 1)];
  dragHandle = L.marker(m.getLatLng(), {
    draggable: true, pmIgnore: true, keyboard: false,
    icon: L.divIcon({ className: "spot-handle", iconSize: [22, 22],
      iconAnchor: [11, 11],
      html: `<div style="color:${pointColor(t || {})}">`
            + `${treatmentGlyph((t || {}).type)}</div>` }),
  });
  dragHandle.on("drag", () => m.setLatLng(dragHandle.getLatLng()));
  dragHandle.on("dragend", () => { m.setLatLng(dragHandle.getLatLng()); markDirty(); });
  dragHandle.addTo(pointsGroup);
}

/* Chevrons showing which way a one-way treatment runs (the drawing order of
   the points IS the direction). A rotated dark glyph with a white halo, the
   same look as every other surface. */
function updateArrows(f) {
  // Arrows live in their own group (NOT networkGroup): a FeatureGroup's
  // getBounds() chokes on layers without bounds, which would break fitBounds.
  if (f.arrows) { arrowsGroup.removeLayer(f.arrows); f.arrows = null; }
  if (!f.layer || !f.treatments.some((t) => t.travel === "one_way")) return;
  const g = L.layerGroup();
  segsOf(f.layer).forEach((seg) => {
    if (seg.length < 2) return;
    const k = Math.max(1, Math.floor(seg.length / 2));
    const a = seg[k - 1], b = seg[k];
    const dx = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
    const theta = Math.atan2(-(b.lat - a.lat), dx) * 180 / Math.PI;
    const icon = L.divIcon({ className: "dir-arrow", iconSize: [16, 16],
      iconAnchor: [8, 8],
      html: `<div style="transform:rotate(${theta.toFixed(0)}deg)">➤</div>` });
    g.addLayer(L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2],
      { icon, interactive: false, keyboard: false, pmIgnore: true }));
  });
  f.arrows = g;
  // Membership is decided centrally: arrows get rebuilt on load, on edit and
  // on import, and each of those would otherwise resurrect the chevron of a
  // treatment that a shown upgrade has replaced.
  syncArrows();
}

/* Treatment ids that something visible replaces. */
function supersededIdSet(list) {
  const ids = new Set(list.flatMap((f) => f.treatments.map((t) => t.id)).filter(Boolean));
  const out = new Set();
  list.forEach((f) => f.treatments.forEach((t) => {
    (t.upgrades || []).forEach((u) => { if (ids.has(u)) out.add(u); });
  }));
  return out;
}
/* Which features the current "Show" setting puts on the map. */
function visibleFeatureSet() {
  if (phaseView === "all") return new Set(features);
  const n = parseInt(phaseView, 10);   // 0 = today (context statuses only)
  const shown = features.filter((f) => f.treatments.some((t) => {
    if (t.status !== "proposed") return true;
    const num = phaseNumberOf(t.phase);
    return n > 0 && (num === null || num <= n);
  }));
  const superseded = supersededIdSet(shown);
  return new Set(shown.filter(
    (f) => !f.treatments.every((t) => t.id && superseded.has(t.id))));
}
/* A treatment keeps its one-way chevron only while it is on the map AND
   nothing shown replaces it: the replacement covers the old line exactly, so
   the arrow would be all that shows, claiming the new lane is one-way. */
function syncArrows(shownSet) {
  if (!arrowsGroup) return;                 // not built yet during early init
  const shown = shownSet || visibleFeatureSet();
  const replaced = supersededIdSet([...shown]);
  features.forEach((f) => {
    if (!f.arrows) return;
    const live = f.treatments.some(
      (t) => t.travel === "one_way" && !(t.id && replaced.has(t.id)));
    const want = shown.has(f) && live;
    if (want && !arrowsGroup.hasLayer(f.arrows)) arrowsGroup.addLayer(f.arrows);
    if (!want && arrowsGroup.hasLayer(f.arrows)) arrowsGroup.removeLayer(f.arrows);
  });
}
/* Chevron icons are fixed-size DivIcons, so zoomed way out they'd dwarf the
   streets themselves — below this zoom the whole arrows layer comes off. */
const ARROW_MIN_ZOOM = 14;
/* What the current zoom changes about drawing. restyleAll() walks every
   feature and rebuilds its overlays and glyph markers, which is fine for a
   hand-drawn network and much too expensive for a city-sized import — so it
   runs only when crossing a threshold that actually changes the picture,
   rather than on every zoom step. */
let lastBand = null;
function renderBand() {
  const z = map.getZoom();
  // The glyph spacing varies with zoom, so the level is part of the band —
  // but only while spots are being drawn at all.
  return [z >= MIN_STACK_ZOOM, z >= MIN_SPOT_ZOOM,
          z >= MIN_SPOT_ZOOM ? z : 0].join("|");
}
function onZoomChanged() {
  syncArrowVisibility();
  syncSpotVisibility();
  const band = renderBand();
  if (band === lastBand) return;
  lastBand = band;
  restyleAll();
}
/* Thousands of spot markers are thousands of DOM nodes that Leaflet moves on
   every pan. Taking the GROUP off the map is one call; taking the markers off
   one at a time is the thing being avoided. */
/* Spots are OFF by default. They are cheap to draw now, but a city import is
   thousands of them and they sit on top of the lanes the map is actually
   about — at low zoom they merge into a grey smear. Someone who wants to work
   on bike parking turns them on; everyone else gets the network. */
let showSpots = false;
function syncSpotVisibility() {
  // Spots themselves are canvas and cost nothing, so when they are ON they
  // stay visible at every zoom. Glyph RUNS along lines are still DOM markers,
  // and a city import can have a lot of them, so those also keep the zoom
  // threshold on top of the toggle.
  for (const g of [pointsGroup, glyphGroup]) {
    const show = showSpots && (g !== glyphGroup || map.getZoom() >= MIN_SPOT_ZOOM);
    if (show && !map.hasLayer(g)) map.addLayer(g);
    else if (!show && map.hasLayer(g)) map.removeLayer(g);
  }
}
function setShowSpots(on) {
  showSpots = Boolean(on);
  for (const id of ["show-spots", "show-spots-roomy"]) {
    const el = document.getElementById(id);
    if (el) el.checked = showSpots;
  }
  syncSpotVisibility();
  updateDebug();
}
function syncArrowVisibility() {
  const show = map.getZoom() >= ARROW_MIN_ZOOM;
  if (show && !map.hasLayer(arrowsGroup)) map.addLayer(arrowsGroup);
  else if (!show && map.hasLayer(arrowsGroup)) map.removeLayer(arrowsGroup);
}

/* ---------- feature management ---------- */
const firstPhaseId = () => (config.phases[0] || {}).id || null;

function defaultTreatment(over) {
  return makeTreatment({
    id: newId("t-"),
    type: (options.treatments && options.treatments[0]
      && options.treatments[0].id) || "quick_build_separated",
    status: "proposed",
    phase: firstPhaseId(),
    authority: (place && place.defaultAuthority)
      || (config.authorities[0] || {}).id || "",
    ...(over || {}),
  });
}
function defaultProps(over) {
  return { id: newId("f-"), name: "New feature", on_street: "", start: "",
           end: "", notes: "", tags: {}, ...(over || {}) };
}

/* Add a feature to the map. `lines` are Leaflet latlng arrays, `points` are
   Leaflet latlngs. A feature may have either or both. */
function addFeature(props, treatments, lines, points) {
  const f = { props, treatments, sel: 0, layer: null, overlays: [],
              glyphs: [], markers: [], arrows: null };
  if (lines && lines.length) {
    f.layer = L.polyline(lines.length === 1 ? lines[0] : lines,
                         { color: "#444", weight: 4, renderer: networkRenderer });
    f.layer.on("click", () => {
      if (combineFrom) { if (f !== combineFrom) combineInto(combineFrom, f); return; }
      selectFeature(f);
    });
    f.layer.on("pm:edit", () => {
      markDirty(); syncOverlays(f); updateArrows(f);
      if (selected === f) updateLenField(f);
      recomputeTotals();
    });
    f.layer.addTo(networkGroup);
  }
  for (const pt of points || []) {
    const m = spotMarker(pt, treatments[0] || defaultTreatment(),
                         !map || map.getZoom() >= MIN_SPOT_ZOOM);
    m.on("click", () => selectFeature(f));
    m.addTo(pointsGroup);        // own group — never networkGroup (getBounds)
    f.markers.push(m);
  }
  features.push(f);
  restyle(f);
  updateArrows(f);
  renderLegend();
  return f;
}
function removeFeature(f) {
  if (f.layer) networkGroup.removeLayer(f.layer);
  f.overlays.forEach((o) => overlayGroup.removeLayer(o));
  f.glyphs.forEach((m) => glyphGroup.removeLayer(m));
  f.markers.forEach((m) => pointsGroup.removeLayer(m));
  if (f.arrows) arrowsGroup.removeLayer(f.arrows);
  features = features.filter((x) => x !== f);
  // Don't leave upgrade links pointing at a deleted treatment (the file would
  // fail validation on the next import).
  const gone = new Set(f.treatments.map((t) => t.id));
  features.forEach((x) => x.treatments.forEach((t) => {
    t.upgrades = (t.upgrades || []).filter((u) => !gone.has(u));
  }));
  if (selected === f) deselect();
  markDirty("delete"); recomputeTotals(); renderLegend();
}
function clearFeatures() {
  deselect();
  features.forEach((f) => {
    if (f.layer) networkGroup.removeLayer(f.layer);
    f.overlays.forEach((o) => overlayGroup.removeLayer(o));
    f.glyphs.forEach((m) => glyphGroup.removeLayer(m));
    f.markers.forEach((m) => pointsGroup.removeLayer(m));
    if (f.arrows) arrowsGroup.removeLayer(f.arrows);
  });
  features = [];
}

/* ---------- upgrades (quick-build now, better build later) ---------- */
function planUpgrade() {
  if (!selected) return;
  const target = selected;
  const t = target.treatments[target.sel];
  if (!t) return;
  const nums = config.phases.slice().sort((a, b) => a.number - b.number);
  const after = phaseNumberOf(t.phase);
  const next = nums.find((p) => after === null || p.number > after)
    || nums[nums.length - 1];
  // The upgrade is a TREATMENT on the same feature, not a copy of the
  // geometry: one line, two projects. That is what stops a superseded path
  // from drawing a stale chevron over its own replacement.
  const up = defaultTreatment({
    type: t.type, authority: t.authority, travel: t.travel, sides: t.sides,
    side: t.side, phase: next ? next.id : firstPhaseId(), upgrades: [t.id],
  });
  target.treatments.push(up);
  target.sel = target.treatments.length - 1;
  setPhaseView("all");
  restyle(target); fillForm(target); markDirty(); recomputeTotals(); renderLegend();
  setStatus(`Added a later-phase replacement on “${target.props.name}” — `
    + `pick its phase and type.`);
}

/* ---------- combining corridors ---------- */
function startCombine() {
  if (!selected) return;
  combineFrom = selected;
  setStatus(`Click the corridor to merge into “${selected.props.name}” — Esc cancels.`);
}
function combineInto(target, other) {
  // The other feature's line(s) become extra parts of the target; the
  // target's properties and treatments win.
  if (target.layer && other.layer) {
    setSegs(target.layer, segsOf(target.layer).concat(segsOf(other.layer)));
  }
  combineFrom = null;
  removeFeature(other);
  syncOverlays(target); updateArrows(target);
  selectFeature(target);
  updateLenField(target); recomputeTotals(); markDirty();
  setStatus(`Combined into “${target.props.name}”.`);
}

/* ---------- selection + property form ---------- */
function isMobile() { return window.matchMedia("(max-width: 760px)").matches; }
function selectFeature(f) {
  if (selected !== f) stopEditingShape();
  const prev = selected; selected = f;
  if (prev && prev !== f) restyle(prev);
  restyle(f);
  syncDragHandle();          // the selection is what has a handle
  fillForm(f);
  if (isMobile() && !document.querySelector(".sidebar").classList.contains("open")) {
    document.getElementById("peek-name").textContent = f.props.name || "(unnamed)";
    document.getElementById("peek").classList.add("show");
  }
}
function deselect() {
  if (dragHandle) { pointsGroup.removeLayer(dragHandle); dragHandle = null; }
  stopEditingShape();
  const prev = selected; selected = null;
  if (prev) restyle(prev);
  document.getElementById("prop-form").style.display = "none";
  document.getElementById("prop-empty").style.display = "";
  document.getElementById("sel-pill").textContent = "";
  document.getElementById("peek").classList.remove("show");
}
function opt(sel, values, current, labelFn) {
  sel.innerHTML = "";
  values.forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v); o.textContent = labelFn ? labelFn(v) : String(v);
    if (String(v) === String(current)) o.selected = true;
    sel.appendChild(o);
  });
}
const currentTreatment = () => (selected
  ? selected.treatments[Math.min(selected.sel, selected.treatments.length - 1)]
  : null);

/* The treatment picker: one chip per treatment on this feature. Order follows
   the file, but nothing downstream depends on it — the map orders by the
   registry's stack_rank. */
function renderTreatmentTabs(f) {
  const box = document.getElementById("treatment-tabs");
  box.innerHTML = "";
  f.treatments.forEach((t, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "treatment-tab" + (i === f.sel ? " active" : "");
    b.title = `${t.status.replace(/_/g, " ")}`;
    b.addEventListener("click", () => { f.sel = i; fillForm(f); restyle(f); });

    const label = document.createElement("span");
    label.textContent = treatmentLabel(t.type);
    b.appendChild(label);

    // Removing one of several treatments used to live only on the Delete
    // button, which reads as "delete the whole thing" — so the way to undo
    // "+ Add another" was hidden behind the scariest control on the panel.
    // The last one has no x: a place with nothing built or proposed there is
    // not part of the network, and deleting it is Delete's job.
    if (f.treatments.length > 1) {
      const x = document.createElement("span");
      x.className = "tab-x";
      x.textContent = "×";
      x.title = `Remove ${treatmentLabel(t.type)} from this place`;
      x.addEventListener("click", (e) => {
        e.stopPropagation();          // removing is not selecting
        f.treatments.splice(i, 1);
        f.sel = Math.min(f.sel, f.treatments.length - 1);
        restyle(f); fillForm(f); renderLegend();
        markDirty(); recomputeTotals();
      });
      b.appendChild(x);
    }
    box.appendChild(b);
  });
  document.getElementById("btn-add-treatment").style.display =
    f.treatments.length ? "" : "none";
}
function fillForm(f) {
  const p = f.props;
  const t = f.treatments[Math.min(f.sel, f.treatments.length - 1)];
  document.getElementById("prop-empty").style.display = "none";
  document.getElementById("prop-form").style.display = "";
  document.getElementById("sel-pill").textContent = p.name || "";
  document.getElementById("f-name").value = p.name || "";
  document.getElementById("f-name").classList.toggle("warn-field", isDefaultName(p.name));
  document.getElementById("f-on").value = p.on_street || "";
  document.getElementById("f-start").value = p.start || "";
  document.getElementById("f-end").value = p.end || "";
  document.getElementById("f-notes").value = p.notes || "";
  renderTreatmentTabs(f);
  if (!t) return;

  opt(document.getElementById("f-status"), options.statuses || [], t.status,
      (v) => v.replace(/_/g, " "));
  // Offer the treatments that suit this feature's geometry. Without this the
  // same list appeared on both, so you could put bike parking on a corridor
  // (drawn as a black dashed line, because a counted treatment carries no
  // colour) or a separated bike lane on a spot (drawn as a black dot). The
  // five treatments that are genuinely either — street trees, bollards, speed
  // humps, parking removal, other — appear on both, which is the whole point.
  const kind = f.layer ? "line" : "point";
  const fits = registry().forGeometry(kind).map((x) => x.id);
  // A file may legitimately carry a combination this list excludes; show it
  // rather than silently retyping the user's data.
  const typeIds = fits.includes(t.type) ? fits : [t.type, ...fits];
  opt(document.getElementById("f-type"), typeIds, t.type,
      (id) => treatmentLabel(id)
        + (registry().get(id).appliesTo(kind) ? "" : "  (unusual here)"));
  opt(document.getElementById("f-auth"),
      config.authorities.map((a) => a.id), t.authority,
      (id) => (config.authorities.find((a) => a.id === id) || {}).name || id);
  opt(document.getElementById("f-side"), options.side_values || [""], t.side,
      (v) => (v === "" ? "— not recorded —" : v.replace(/_/g, " ")));
  document.getElementById("f-travel").value = t.travel;
  document.getElementById("f-sides").value = String(t.sides);
  document.getElementById("f-proposed-by").value = t.proposed_by || "";
  fillPhaseSelect(f, t);

  // travel/sides describe a line. On a point they mean nothing, so they go
  // away rather than sitting there inviting a value the file would reject.
  const isLine = f.layer !== null && f.layer !== undefined;
  document.getElementById("line-only-fields").style.display = isLine ? "" : "none";
  document.getElementById("btn-reverse").style.display =
    (isLine && t.travel === "one_way") ? "" : "none";
  document.getElementById("btn-snap-sel").style.display = isLine ? "" : "none";
  document.getElementById("btn-combine").style.display = isLine ? "" : "none";
  document.getElementById("btn-edit").style.display = isLine ? "" : "none";
  document.getElementById("btn-edit").classList.toggle(
    "toggled", Boolean(f.layer && f.layer.pm && f.layer.pm.enabled()));

  // `quantity` only means something for a counted treatment, and the unit
  // comes from the registry so the label reads "How many trees".
  const spec = registry().get(t.type);
  const qf = document.getElementById("quantity-field");
  if (spec.measure === "counted") {
    qf.style.display = "";
    document.getElementById("quantity-label").textContent =
      `How many ${spec.unit || "items"}`;
    document.getElementById("f-quantity").value =
      t.quantity === null || t.quantity === undefined ? "" : String(t.quantity);
  } else qf.style.display = "none";

  updateUpgradeRow(f, t);
  updateLenField(f);
}
function updateUpgradeRow(f, t) {
  const row = document.getElementById("upgrade-row");
  if (t && t.upgrades && t.upgrades.length) {
    const names = t.upgrades.map((id) => {
      for (const g of features) {
        const hit = g.treatments.find((x) => x.id === id);
        if (hit) return `${g.props.name || "(unnamed)"} — ${treatmentLabel(hit.type)}`;
      }
      return "a removed treatment";
    });
    document.getElementById("upgrade-target").textContent = `Replaces ${names.join(", ")}`;
    row.style.display = "";
  } else row.style.display = "none";
}
function fillPhaseSelect(f, t) {
  // Phase only applies to proposed work; context statuses carry none.
  const sel = document.getElementById("f-phase");
  if (t.status === "proposed") {
    sel.disabled = false;
    if (!t.phase) t.phase = firstPhaseId();
    opt(sel, config.phases.map((x) => x.id), t.phase,
        (id) => {
          const p = config.phases.find((x) => x.id === id) || {};
          return `Phase ${p.number}${p.label ? ": " + p.label : ""}`;
        });
  } else {
    sel.innerHTML = "<option>— n/a —</option>"; sel.disabled = true;
  }
}
function updateLenField(f) {
  const km = featureKm(f);
  const t = currentTreatment();
  if (!km) {
    document.getElementById("f-len").value = "a point";
    return;
  }
  const lane = km * ((t && t.sides) || 2);
  document.getElementById("f-len").value =
    `${showDist(km).toFixed(2)} ${distUnit(false)}  ·  `
    + `${showDist(lane).toFixed(2)} ${distUnit(true)}`;
}
function bindForm() {
  // Feature-level fields describe the PLACE.
  const setFeature = (id, key) => {
    document.getElementById(id).addEventListener("input", (e) => {
      if (!selected) return;
      selected.props[key] = e.target.value;
      if (key === "name") {
        document.getElementById("sel-pill").textContent = e.target.value;
        e.target.classList.toggle("warn-field", isDefaultName(e.target.value));
        recomputeTotals();
      }
      markDirty();
    });
  };
  setFeature("f-name", "name"); setFeature("f-on", "on_street");
  setFeature("f-start", "start"); setFeature("f-end", "end");
  setFeature("f-notes", "notes");

  // Treatment-level fields describe the FACILITY.
  const setTreatment = (id, key, cast) => {
    document.getElementById(id).addEventListener("input", (e) => {
      const t = currentTreatment();
      if (!t) return;
      t[key] = cast ? cast(e.target.value) : e.target.value;
      if (key === "status") {
        t.phase = t.status === "proposed" ? firstPhaseId() : null;
        // Only proposed work can replace something else.
        if (t.status !== "proposed" && t.upgrades.length) t.upgrades = [];
        fillPhaseSelect(selected, t);
        updateUpgradeRow(selected, t);
      }
      if (["status", "type", "phase"].includes(key)) {
        restyle(selected);
        // The legend lists only the treatments in use, so retyping the last
        // one of a kind (or the first of a new one) changes it.
        renderLegend();
        if (key === "type") fillForm(selected);      // quantity unit may change
      }
      if (key === "travel") {
        updateArrows(selected);
        document.getElementById("btn-reverse").style.display =
          t.travel === "one_way" ? "" : "none";
      }
      if (["sides", "type", "status", "phase", "quantity"].includes(key)) {
        updateLenField(selected); recomputeTotals();
      }
      markDirty();
    });
  };
  setTreatment("f-status", "status"); setTreatment("f-type", "type");
  setTreatment("f-auth", "authority"); setTreatment("f-phase", "phase");
  setTreatment("f-travel", "travel");
  setTreatment("f-sides", "sides", (v) => parseInt(v, 10));
  setTreatment("f-side", "side");
  setTreatment("f-proposed-by", "proposed_by");
  setTreatment("f-quantity", "quantity",
               (v) => (v === "" ? null : Math.max(0, parseInt(v, 10) || 0)));

  document.getElementById("btn-add-treatment").addEventListener("click", () => {
    if (!selected) return;
    selected.treatments.push(defaultTreatment());
    selected.sel = selected.treatments.length - 1;
    restyle(selected); fillForm(selected); renderLegend();
    markDirty(); recomputeTotals();
  });
  document.getElementById("btn-delete").addEventListener("click", () => {
    if (!selected) return;
    // Deleting the last treatment deletes the feature: a place with nothing
    // built or proposed there isn't part of the network.
    if (selected.treatments.length > 1) {
      if (!confirm("Remove this treatment from this place?")) return;
      selected.treatments.splice(selected.sel, 1);
      selected.sel = 0;
      restyle(selected); fillForm(selected); renderLegend();
      markDirty(); recomputeTotals();
    } else if (confirm("Delete this whole feature?")) removeFeature(selected);
  });
  document.getElementById("btn-upgrade").addEventListener("click", planUpgrade);
  document.getElementById("btn-unlink").addEventListener("click", () => {
    const t = currentTreatment();
    if (!t) return;
    t.upgrades = [];
    updateUpgradeRow(selected, t); markDirty(); recomputeTotals();
  });
}

/* ---------- totals ---------- */
const DEFAULT_NAMES = new Set(["new feature", "new path", "existing path",
                               "new corridor", ""]);
function isDefaultName(name) {
  return DEFAULT_NAMES.has(String(name || "").trim().toLowerCase());
}
function money(v) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 10e6 ? 0 : 1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}
/* The live panel runs the SAME summarize() the exports do, over the current
   on-screen geometry — so the number on screen and the number in the file can
   never drift apart. It does not clip (clipping needs the boundary and is an
   export-time concern); the export notes say what got trimmed. */
function liveNetwork() {
  // Built with makeNetwork rather than hand-rolled, so it carries every method
  // the shared modules expect (allIds, allTreatments, phaseMap, authority, …).
  // A hand-rolled stand-in silently loses one the moment a module starts using
  // it, which is exactly how the merge first broke.
  return makeNetwork({
    areas: config.areas.map((a) => makeArea({ ...a })),
    authorities: config.authorities,
    phases: config.phases.map((p) => makePhase({ ...p })),
    costs: config.costs,
    units: config.units,
    meta: config.meta,
    features: features.map(toModelFeature),
    crs: baseNet ? baseNet.crs : undefined,
    extra: baseNet ? baseNet.extra : {},
  });
}
function toModelFeature(f) {
  const lines = f.layer ? segsOf(f.layer).map((s) => s.map((p) => [p.lat, p.lng])) : [];
  const pts = f.markers.map((m) => [[m.getLatLng().lat, m.getLatLng().lng]]);
  return makeFeature({ ...f.props, treatments: f.treatments,
                       geometry: [...lines, ...pts], length_km: featureKm(f) });
}
function recomputeTotals() {
  // The Areas card carries a per-area feature count, so it goes stale on every
  // add, delete and reshape unless it is rebuilt alongside the totals.
  renderAreas();
  updateDebug();
  const net = liveNetwork();
  const s = summarize(net.features, net, { units });
  const num = (id, v) => { document.getElementById(id).textContent = v; };
  num("t-city", showDist(s.total_build_km).toFixed(1));
  num("t-lane", showDist(s.total_lane_km).toFixed(1));
  num("t-existing", showDist(s.existing_km + s.under_construction_km
                             + s.funded_km).toFixed(1));
  num("t-count", s.total_features);
  document.getElementById("t-city-lbl").textContent = distUnit(false);
  document.getElementById("t-lane-lbl").textContent = distUnit(true);
  document.getElementById("c-total").textContent =
    (s.cost_low || s.cost_high) ? `${money(s.cost_low)} – ${money(s.cost_high)}` : "–";

  // The sentence a council actually hears: "plants 1,200 trees, removes 210
  // parking spaces".
  const qrow = document.getElementById("t-quantities-row");
  if (s.quantities.length) {
    qrow.style.display = "";
    document.getElementById("t-quantities").textContent = s.quantities
      .map((q) => `${q.n} ${q.unit}`).join(" · ");
  } else qrow.style.display = "none";

  renderBreakdown(s);

  // An unknown treatment is drawn and kept, but says so rather than being
  // silently counted as something it isn't.
  const uw = document.getElementById("unknown-warn");
  if (s.unknown_types.length) {
    uw.style.display = "";
    uw.textContent = `⚠ ${s.unknown_types.length} kind`
      + `${s.unknown_types.length > 1 ? "s" : ""} of improvement this version `
      + `doesn't know about — shown in grey, left out of the totals`;
  } else uw.style.display = "none";

  const unnamed = features.filter((f) => isDefaultName(f.props.name)).length;
  const warn = document.getElementById("unnamed-warn");
  warn.style.display = unnamed ? "" : "none";
  if (unnamed) {
    warn.textContent = `⚠ ${unnamed} feature${unnamed > 1 ? "s" : ""} still `
      + `${unnamed > 1 ? "have" : "has"} a default name — click to review`;
  }
}
/* "How many km are in Medford" and "how many need MassDOT to say yes" are
   both real questions; declared authorities make both one group-by away. */
function renderBreakdown(s) {
  const box = document.getElementById("by-group");
  const wrap = document.getElementById("by-group-box");
  const by = document.getElementById("group-by").value;
  const rows = by === "area" ? s.by_area : s.by_authority;
  const useful = rows.filter((r) => r.km > 0.001);
  wrap.style.display = useful.length > 1 ? "" : "none";
  box.innerHTML = "";
  useful.forEach((r) => {
    const d = document.createElement("div");
    d.className = "costrow";
    d.innerHTML = `<span>${r.name || r.id || "(unassigned)"}</span>`
      + `<b>${showDist(r.km).toFixed(1)} ${distUnit(false)}</b>`;
    box.appendChild(d);
  });
}
function selectNextUnnamed() {
  const unnamed = features.filter((f) => isDefaultName(f.props.name));
  if (!unnamed.length) return;
  const start = selected ? unnamed.indexOf(selected) + 1 : 0;
  const f = unnamed[start % unnamed.length];
  if (f.layer) map.fitBounds(f.layer.getBounds().pad(0.3));
  else if (f.markers.length) map.setView(f.markers[0].getLatLng(), 17);
  selectFeature(f);
  document.getElementById("f-name").focus();
}

/* ---------- phases ---------- */
function renderPhases() {
  const box = document.getElementById("phases"); box.innerHTML = "";
  config.phases.forEach((ph, i) => {
    const div = document.createElement("div"); div.className = "phase";
    div.innerHTML = `
      <div class="ph-top">
        <span class="swatch" style="background:${PHASE_COLORS[ph.number] || "#444"}"></span>
        <strong>Phase ${ph.number}</strong>
        <span class="spacer" style="flex:1"></span>
        <button class="rm danger" data-i="${i}">Remove</button>
      </div>`;
    const label = document.createElement("input");
    label.value = ph.label || ""; label.placeholder = "Label";
    const date = document.createElement("input");
    date.value = ph.target_date || ""; date.placeholder = "Target date e.g. 2029";
    label.addEventListener("input", (e) => { ph.label = e.target.value; markDirty(); });
    date.addEventListener("input", (e) => {
      ph.target_date = e.target.value; markDirty();
    });
    div.appendChild(label); div.appendChild(date);
    div.querySelector(".rm").addEventListener("click", () => {
      config.phases.splice(i, 1);
      renderPhases(); if (selected) fillForm(selected); markDirty();
    });
    box.appendChild(div);
  });
  renderPhaseView();
}
function addPhase() {
  const next = config.phases.reduce((m, p) => Math.max(m, p.number), 0) + 1;
  // A phase's ID is its identity and never changes; the number is display
  // order, which a merge is free to renumber.
  config.phases.push({ id: newId("p-"), number: next, label: `Phase ${next}`,
                       target_date: "" });
  renderPhases(); if (selected) fillForm(selected); markDirty();
}

/* ---------- phase view (Show: full network / today / as of phase N) ------- */
function renderPhaseView() {
  const sel = document.getElementById("phase-view");
  sel.innerHTML = "";
  const add = (v, label) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label; sel.appendChild(o);
  };
  add("all", "Full network");
  add("0", "Today (already built)");
  config.phases.slice().sort((a, b) => a.number - b.number).forEach((ph) =>
    add(String(ph.number), `As of Phase ${ph.number}${ph.label ? ": " + ph.label : ""}`));
  sel.value = [...sel.options].some((o) => o.value === phaseView) ? phaseView : "all";
  phaseView = sel.value;
}
function setPhaseView(v) {
  phaseView = v;
  document.getElementById("phase-view").value = v;
  applyPhaseView();
}
function applyPhaseView() {
  const shownSet = visibleFeatureSet();
  features.forEach((f) => {
    const show = shownSet.has(f);
    if (f.layer) {
      if (show && !networkGroup.hasLayer(f.layer)) networkGroup.addLayer(f.layer);
      if (!show && networkGroup.hasLayer(f.layer)) networkGroup.removeLayer(f.layer);
    }
    f.overlays.forEach((o) => {
      if (show && !overlayGroup.hasLayer(o)) overlayGroup.addLayer(o);
      if (!show && overlayGroup.hasLayer(o)) overlayGroup.removeLayer(o);
    });
    f.glyphs.forEach((o) => {
      if (show && !glyphGroup.hasLayer(o)) glyphGroup.addLayer(o);
      if (!show && glyphGroup.hasLayer(o)) glyphGroup.removeLayer(o);
    });
    f.markers.forEach((m) => {
      if (show && !pointsGroup.hasLayer(m)) pointsGroup.addLayer(m);
      if (!show && pointsGroup.hasLayer(m)) pointsGroup.removeLayer(m);
    });
    if (!show && selected === f) deselect();
  });
  syncArrows(shownSet);
}

/* ---------- the debug readout ----------
   Turned on by `serve.py --debug`, or `?debug` in the URL. It exists so that
   "it lags a bit" can become "it lags at z14 with 3,473 spots drawn", which is
   a report someone can actually act on. Off by default and never shipped on:
   a deployed copy has no server flag and the fetch simply fails. */
let debugOn = false;
async function initDebug() {
  if (new URLSearchParams(location.search).has("debug")) debugOn = true;
  else {
    try {
      const res = await fetch("debug-mode");
      debugOn = res.ok && (await res.json()).debug === true;
    } catch { debugOn = false; }
  }
  if (!debugOn) return;
  document.getElementById("debug-readout").hidden = false;
  map.on("zoomend moveend", updateDebug);
  updateDebug();
}
function updateDebug() {
  if (!debugOn) return;
  const z = map.getZoom();
  const spots = features.reduce((n, f) => n + f.markers.length, 0);
  const lines = features.filter((f) => f.layer).length;
  const verts = features.reduce((n, f) => n + (f.layer
    ? segsOf(f.layer).reduce((k, seg) => k + seg.length, 0) : 0), 0);
  const glyphRuns = features.reduce((n, f) => n + f.glyphs.length, 0);
  // The number that actually predicts lag: how many DOM elements the map has
  // to move on every pan. Canvas costs are counted separately because they
  // behave completely differently.
  const dom = document.querySelectorAll("#map .leaflet-marker-icon").length;
  document.getElementById("debug-readout").textContent = [
    `zoom      ${z}  spots ${!showSpots ? "OFF"
      : z >= MIN_SPOT_ZOOM ? "as glyphs" : "as dots"}`,
    `features  ${features.length}  (${lines} lines, ${spots} spots)`,
    `vertices  ${verts}`,
    `canvas    ${spots} spots + ${lines} lines`,
    `DOM       ${dom} markers  (${glyphRuns} glyph-run)`,
    `areas     ${config.areas.map((a) => a.name).join(", ") || "none"}`,
  ].join("\n");
}

/* ---------- areas ----------
   Which areas exist decides what gets drawn, counted and exported, so it is a
   real editing decision — and until now there was no way to see it, change it,
   or even find out that it was the reason a line got cut short. */
let areaClip = null;   // memoized union of every area boundary
function areasBoundary() {
  if (areaClip) return areaClip;
  // Concatenating multipolygons is a union here: pointInBoundary succeeds on
  // ANY polygon, and holes are resolved per-polygon, so one area cannot punch
  // a hole in its neighbour.
  // normalizeBoundary first: an area may carry a bare ring, one polygon, or a
  // multipolygon depending on where it came from (adopted from the deployment,
  // parsed from a file, uploaded as GeoJSON). Unioning without normalizing
  // treats a ring as a polygon and silently clips against nothing.
  areaClip = [];
  for (const a of config.areas) {
    for (const poly of normalizeBoundary(a.boundary)) areaClip.push(poly);
  }
  return areaClip;
}
function areasChanged() {
  areaClip = null;
  redrawBoundaries(); renderAreas(); recomputeTotals();
}
/* Clip a drawn line to the areas. Returns every in-boundary piece — a line
   that leaves and comes back is two pieces of one feature, not one piece with
   the middle quietly joined up. [] means it was entirely outside. */
function clipToAreas(latlngs) {
  const boundary = areasBoundary();
  const geom = latlngs.map((p) => (p.lat === undefined ? p : [p.lat, p.lng]));
  if (!boundary.length) return { pieces: [geom], trimmed: false, outside: null };
  const [pieces] = clipPolylineLatlon(geom, boundary);
  const before = geom.length;
  const after = pieces.reduce((n, pc) => n + pc.length, 0);
  // A vertex that did NOT survive names the place the user was trying to reach.
  const outside = geom.find((pt) => !pointInBoundary(pt[0], pt[1], boundary));
  // Counting vertices is not enough to notice a trim. Clipping a two-point
  // line that starts in the next town returns a two-point line with its first
  // vertex moved onto the border: same count, same piece, but the user lost
  // half of what they drew and was told nothing. A vertex outside the areas is
  // the honest test — that IS the thing being cut off.
  return { pieces,
           trimmed: Boolean(outside) || pieces.length !== 1 || after < before,
           outside: outside || null };
}
function insideAreas(latlng) {
  const boundary = areasBoundary();
  return !boundary.length || pointInBoundary(latlng.lat, latlng.lng, boundary);
}
const areaNames = () => config.areas.map((a) => a.name).filter(Boolean).join(" or ");
/* A notice with a way out. Trimming is correct but invisible, and the fix for
   "I meant to draw that" is a wider boundary — so the message that explains it
   also carries the button that widens. */
function showClipNotice(text, outsidePoint) {
  const bar = document.getElementById("clip-notice");
  document.getElementById("clip-notice-text").textContent = text;
  const btn = document.getElementById("clip-notice-add");
  btn.textContent = "Add an area…";
  btn.onclick = openAreaPicker;
  bar.hidden = false;
  // Name the town the line actually ran into, so the button is "Add Medford"
  // rather than a menu to go hunting in. Best-effort: no network, no name, and
  // the generic button still works.
  if (!outsidePoint) return;
  const shownFor = outsidePoint;
  areaAt(outsidePoint[0], outsidePoint[1], netOpts()).then((found) => {
    if (!found || bar.hidden || shownFor !== outsidePoint) return;
    if (haveArea(found)) return;
    document.getElementById("clip-notice-text").textContent =
      `${text} The rest is in ${found.name}.`;
    btn.textContent = `Add ${found.name}`;
    btn.onclick = () => addCensusArea(found);
  }).catch(() => {});
}
function hideClipNotice() { document.getElementById("clip-notice").hidden = true; }

function renderAreas() {
  const box = document.getElementById("areas-list");
  if (!box) return;
  box.innerHTML = "";
  if (!config.areas.length) {
    box.innerHTML = '<p class="hint">No areas yet — nothing is being clipped '
      + "or counted.</p>";
    return;
  }
  const owner = assignAreas(features.map(toModelFeature), config.areas);
  config.areas.forEach((a, i) => {
    const row = document.createElement("div");
    row.className = "area-row";
    const name = document.createElement("span");
    name.className = "area-name";
    name.textContent = a.name || a.id;
    const counts = document.createElement("span");
    counts.className = "area-counts";
    const n = [...owner.values()].filter((v) => v === a.id).length;
    counts.textContent = `${n} feature${n === 1 ? "" : "s"}`
      + ((a.boundary || []).length ? "" : " · no outline, nothing clipped to it");
    const rm = document.createElement("button");
    rm.className = "rm danger"; rm.textContent = "Remove";
    rm.title = "Stop covering this area. Nothing you already drew is deleted.";
    rm.addEventListener("click", () => {
      if (!confirm(`Stop covering ${a.name}?\n\nNothing you already drew is `
                   + "deleted, but new drawing will stop at the remaining "
                   + "boundaries.")) return;
      config.areas.splice(i, 1);
      areasChanged(); markDirty();
    });
    row.appendChild(name); row.appendChild(counts); row.appendChild(rm);
    box.appendChild(row);
  });
}
/* Redraw the dashed outlines from whatever areas the network now has. */
function redrawBoundaries() {
  if (!boundaryGroup) return;
  boundaryGroup.clearLayers();
  maskGroup.clearLayers();
  const show = document.getElementById("show-boundary");
  if (show && !show.checked) return;
  drawOutsideMask();
  // The line BETWEEN two of your areas is an internal division, not an edge of
  // the network. Drawing it with the same emphasis as the outside made a
  // two-town map look like two maps pushed together.
  const { outer, shared } = splitBoundaryEdges(config.areas.map((a) => a.boundary));
  for (const run of shared) {
    L.polyline(run, { color: BOUNDARY, weight: 1, dashArray: "2,7",
                      opacity: 0.45, interactive: false, pmIgnore: true })
      .addTo(boundaryGroup);
  }
  // The outer edge competes with every other administrative border the
  // basemap already draws, so it needs to win outright: a white casing under a
  // heavy dark dash reads as "this one is mine" at any zoom.
  for (const run of outer) {
    L.polyline(run, { color: "#ffffff", weight: 5, opacity: 0.75,
                      interactive: false, pmIgnore: true }).addTo(boundaryGroup);
  }
  for (const run of outer) {
    L.polyline(run, { color: BOUNDARY_STRONG, weight: 2.5, dashArray: "9,5",
                      opacity: 0.95, interactive: false, pmIgnore: true })
      .addTo(boundaryGroup);
  }
}

/* Everything outside your areas goes slightly dark, so the areas read as the
   subject of the map rather than as one more set of lines on it. One polygon
   covering the world with a hole punched for each area — cheap, and it moves
   and scales with the map for free.

   It lives in its own group because boundaryGroup feeds fitBounds(), and a
   world-sized rectangle in there would frame the planet. */
function drawOutsideMask() {
  const holes = [];
  for (const a of config.areas) {
    // Outer rings only: a hole inside an area (an enclave town) should stay
    // shaded, which is what dropping the inner rings gives us.
    for (const poly of normalizeBoundary(a.boundary)) {
      if (poly.length && poly[0].length >= 4) holes.push(poly[0]);
    }
  }
  if (!holes.length) return;
  // Latitude stops short of the poles: Web Mercator cannot project +/-90.
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  L.polygon([world, ...holes], {
    stroke: false, fillColor: "#0f172a", fillOpacity: 0.14,
    interactive: false, pmIgnore: true,
  }).addTo(maskGroup);
}
/* ---------- the area picker ----------
   Adding a town must not require owning a GeoJSON file. Almost nobody has one,
   and "I'll also do Medford this weekend" is the ordinary case, not an
   advanced one. Boundaries come from the Census by name, the picker opens
   already showing the neighbours, and the file upload stays for the case no
   registry can cover. */
const NET_TIMEOUT = 15000;
function netOpts() {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), NET_TIMEOUT);
  return { signal: ctl.signal };
}
/* The state the user is already working in, so a search for "Somerville"
   offers the one next door before the other four. */
function currentState() {
  for (const a of config.areas) {
    if (a.context) {
      const abbr = stateAbbr(String(a.id).replace(/^census:/, "").slice(0, 2));
      if (abbr) return abbr;
    }
    const m = String(a.id).match(/^census:(\d{2})/);
    if (m) return stateAbbr(m[1]);
  }
  return "";
}
/* Do we already cover this town? The id is the real answer, but it cannot be
   the only one: a network may predate the census id it should have had, or
   carry an area someone uploaded or typed by hand. Name-plus-state catches
   those without ever confusing two Springfields in different states. */
const norm = (v) => String(v || "").trim().toLowerCase();
function haveArea(cand) {
  const wanted = censusId(cand);
  return config.areas.some((a) => {
    if (String(a.id) === wanted) return true;
    if (norm(a.name) !== norm(cand.name)) return false;
    // Same name: only the same place if the state agrees, or neither says.
    const ctx = norm(a.context);
    if (!ctx) return true;
    return ctx === norm(cand.stateName) || ctx === norm(cand.state);
  });
}

function pickerNote(msg) {
  document.getElementById("area-picker-note").textContent = msg || "";
}
function renderChoices(box, list, { empty }) {
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<span class="none">${empty}</span>`;
    return;
  }
  for (const area of list) {
    const already = haveArea(area);
    const b = document.createElement("button");
    b.className = "ghost" + (already ? " added" : "");
    b.textContent = already
      ? `${area.name} ✓`
      : `${area.name}${area.state ? `, ${area.state}` : ""}`;
    b.title = already
      ? "Already one of your areas"
      : `Add ${area.name}${area.kind ? ` (${area.kind})` : ""}`;
    b.disabled = already;
    b.addEventListener("click", () => addCensusArea(area));
    box.appendChild(b);
  }
}
async function addCensusArea(area) {
  if (haveArea(area)) return;
  pickerNote(`Fetching the boundary of ${area.name}…`);
  try {
    const boundary = await areaBoundary(area, netOpts());
    if (!boundary.length) { pickerNote(`No boundary came back for ${area.name}.`); return; }
    config.areas = [...config.areas, makeArea({
      id: censusId(area), name: area.name, kind: area.kind || "municipality",
      context: area.stateName || area.state, boundary,
    })];
    areasChanged(); markDirty(); hideClipNotice();
    markStarted(true);
    document.getElementById("area-picker").hidden = true;
    map.fitBounds(boundaryGroup.getBounds().pad(0.05));
    setStatus(`Added ${area.name}. You can draw there now.`);
  } catch (e) {
    pickerNote(offlineNote(e, `Couldn't fetch ${area.name}'s boundary.`));
  }
}
/* A failed lookup must never look like a broken editor: the tool works fine
   without the Census, and the file upload is right there. */
function offlineNote(err, lead) {
  const aborted = err && (err.name === "AbortError" || /abort/i.test(err.message || ""));
  return `${lead} ${aborted ? "The Census service didn't answer in time."
    : "The Census service couldn't be reached."}`
    + " You can try again, or load a .geojson file instead.";
}
async function openAreaPicker() {
  const dlg = document.getElementById("area-picker");
  dlg.hidden = false;
  pickerNote("");
  document.getElementById("area-search").value = "";
  document.getElementById("area-results").innerHTML = "";
  document.getElementById("area-search").focus();

  const near = document.getElementById("area-near");
  const wrap = document.getElementById("area-near-wrap");
  const bbox = areasBbox();
  document.getElementById("area-near-name").textContent =
    config.areas.map((a) => a.name).filter(Boolean).join(" and ") || "here";
  if (!bbox) { wrap.hidden = true; return; }
  wrap.hidden = false;
  near.innerHTML = '<span class="none">Looking up the towns next to you…</span>';
  try {
    const list = await nearbyAreas(bbox, netOpts());
    renderChoices(near, list, { empty: "Nothing adjacent came back." });
  } catch (e) {
    near.innerHTML = `<span class="none">${offlineNote(e, "Couldn't list nearby areas.")}</span>`;
  }
}
function closeAreaPicker() {
  document.getElementById("area-picker").hidden = true;
  // Backing out of the picker having chosen nothing leaves an editor with no
  // areas at all — nothing clipped, nothing counted. Offer the way in again
  // rather than stranding the user on a map that belongs to no place.
  if (!config.areas.length && !features.length) {
    markStarted(false);
    document.getElementById("start-sheet").hidden = false;
  }
}
/* The bounding box of every area, padded enough that the neighbour query
   actually crosses the border into them. */
function areasBbox() {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  for (const a of config.areas) {
    for (const poly of normalizeBoundary(a.boundary)) {
      for (const ring of poly) {
        for (const [lat, lon] of ring) {
          any = true;
          if (lat < s) s = lat; if (lat > n) n = lat;
          if (lon < w) w = lon; if (lon > e) e = lon;
        }
      }
    }
  }
  if (!any) return null;
  const pad = 0.004;      // ~450 m: over the line, not into the next county
  return [s - pad, w - pad, n + pad, e + pad];
}

/* Add an area from a boundary file — the escape hatch for an area no registry
   has: a set of neighbourhoods, a corridor study, a campus. */
async function addAreaFromFile(file) {
  try {
    const doc = JSON.parse(await file.text());
    const ways = [];
    const walk = (g) => {
      if (!g) return;
      if (g.type === "Feature") return walk(g.geometry);
      if (g.type === "FeatureCollection") return (g.features || []).forEach(walk);
      if (g.type === "GeometryCollection") return (g.geometries || []).forEach(walk);
      const c = g.coordinates || [];
      const ring = (r) => ways.push(r.map(([lo, la]) => [la, lo]));
      if (g.type === "LineString") ring(c);
      else if (g.type === "MultiLineString" || g.type === "Polygon") c.forEach(ring);
      else if (g.type === "MultiPolygon") c.forEach((poly) => poly.forEach(ring));
    };
    walk(doc);
    const boundary = boundaryFromWays(ways);
    if (!boundary.length) {
      alert("Couldn't find a closed boundary in that file.\n\nIt should be a "
            + "GeoJSON Polygon or MultiPolygon — or the boundary ways of one, "
            + "which get chained into rings.");
      return;
    }
    const name = (prompt("What is this area called?",
                         file.name.replace(/[.][^.]+$/, "")) || "").trim();
    if (!name) return;
    config.areas = [...config.areas, makeArea({ id: newId("a-"), name, boundary })];
    areasChanged(); markDirty(); hideClipNotice(); markStarted(true);
    document.getElementById("area-picker").hidden = true;
    map.fitBounds(boundaryGroup.getBounds().pad(0.05));
    setStatus(`Added ${name}. You can draw there now.`);
  } catch (e) {
    alert(`Couldn't read that file: ${e.message}`);
  }
}

/* ---------- legend ---------- */
function renderLegend() {
  const items = [];
  const used = [...new Set(features.flatMap((f) => f.treatments.map((t) => t.type)))];
  if (colorMode === "phase") {
    config.phases.forEach((p) => items.push(
      [PHASE_COLORS[p.number] || "#444", `Phase ${p.number}`, null]));
    items.push([FUNDED_COLOR, "Approved / funded", "10,6"]);
    items.push([UNDER_CONSTRUCTION_COLOR, "Under construction", "2,6"]);
    items.push([EXISTING_COLOR, "Already built", null]);
  } else if (colorMode === "treatment") {
    // One row per treatment in use, in registry draw order — never one row
    // per combination, which would be unreadable.
    registry().sortedForDraw(used).forEach((spec) => {
      if (spec.color) items.push([spec.color, spec.label, null]);
    });
    items.push(["#555", "Dashed: not built yet", "6,6"]);
  } else {
    items.push([SINGLE_COLOR, "Bike network", null]);
    items.push([SINGLE_COLOR, "Dashed: not built yet", "6,6"]);
  }
  const box = document.getElementById("legend"); box.innerHTML = "";
  items.forEach(([c, label, dash]) => {
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span class="ln" style="border-top-color:${c};`
      + `border-top-style:${dash ? "dashed" : "solid"}"></span>${label}`;
    box.appendChild(d);
  });
  // Point treatments get a glyph row rather than a line swatch.
  registry().sortedForDraw(used).forEach((spec) => {
    if (spec.color || !spec.glyph) return;
    const d = document.createElement("div"); d.className = "item";
    d.innerHTML = `<span class="ln" style="border:0;text-align:center;`
      + `font-weight:bold">${spec.glyph}</span>${spec.label}`;
    box.appendChild(d);
  });
}

/* ---------- context layers (reference data, not part of the plan) ----------
   Lazy on every axis: nothing is fetched until a layer is first checked, and
   unchecked layers are plain removeLayer'd — zero cost while off. Points are
   drawn on a shared canvas renderer so thousands of markers stay smooth. */
const contextLayers = {};   // id -> {entry, leaflet layer or null, loading}
const contextRenderer = typeof L !== "undefined" ? L.canvas({ padding: 0.5 }) : null;

function contextPopupHtml(props) {
  const rows = Object.entries(props || {})
    .filter(([k, v]) => v != null && v !== "" && typeof v !== "object").slice(0, 6)
    .map(([k, v]) => `<div><b>${k.replace(/_/g, " ")}</b>: ${String(v)}</div>`);
  return rows.join("") || "<i>(no details)</i>";
}
async function toggleContextLayer(entry, on) {
  const state = contextLayers[entry.id];
  if (!on) {
    if (state && state.layer) map.removeLayer(state.layer);
    return;
  }
  if (state && state.layer) { state.layer.addTo(map); return; }
  if (state && state.loading) return;
  contextLayers[entry.id] = { entry, layer: null, loading: true };
  try {
    const data = await store.layerGeojson(entry.id);
    const style = entry.style || {};
    const layer = L.geoJSON(data, {
      renderer: contextRenderer,
      pointToLayer: (ft, ll) => L.circleMarker(ll, {
        renderer: contextRenderer,
        radius: style.radius || 4, color: style.color || "#666", weight: 1,
        fillColor: style.color || "#666", fillOpacity: 0.55, opacity: 0.8 }),
      style: () => ({ color: style.color || "#666", weight: 2, opacity: 0.7 }),
      onEachFeature: (ft, l) => l.bindPopup(
        `<b>${entry.label}</b>` + contextPopupHtml(ft.properties), { maxWidth: 260 }),
    });
    contextLayers[entry.id] = { entry, layer, data, loading: false };
    // Only add if the box is still checked (the user may have re-toggled).
    const box = document.querySelector(`#layers-list input[data-id="${entry.id}"]`);
    if (!box || box.checked) layer.addTo(map);
  } catch (e) {
    contextLayers[entry.id] = null;
    setStatus(`Couldn’t load the “${entry.label}” layer.`);
  }
}
async function initContextLayers() {
  let entries = [];
  // Only the layers with something to say about this area.
  try { entries = await store.layersForArea(); } catch (e) { return; }
  if (!entries.length) return;
  document.getElementById("layers-card").style.display = "";
  const box = document.getElementById("layers-list");
  entries.forEach((entry) => {
    const row = document.createElement("label");
    row.className = "layer-row";
    if (entry.description || entry.attribution) {
      row.title = [entry.description, entry.attribution].filter(Boolean).join(" — ");
    }
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.id = entry.id;
    cb.addEventListener("change", () => toggleContextLayer(entry, cb.checked));
    const sw = document.createElement("span"); sw.className = "layer-swatch";
    sw.style.background = (entry.style || {}).color || "#666";
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(entry.label || entry.id));
    box.appendChild(row);
  });
}

/* ---------- autosave ----------
   Every edit schedules a debounced save to localStorage, so closing the tab
   costs at most ~a second of work (and the pagehide flush covers even that).
   There is no Save button; the status pill shows the autosave state. */
const AUTOSAVE_MS = 1200;
let saveTimer = null, saving = false;
function markDirty(label = "") {
  dirty = true; setStatus();
  if (!restoring) recordHistory(label);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, AUTOSAVE_MS);
}
function recordHistory(label) {
  try {
    history.push(serializeNetwork(liveNetwork()), label);
  } catch (e) { /* history is a convenience; never break an edit over it */ }
  syncUndoButtons();
}
function syncUndoButtons() {
  const u = document.getElementById("btn-undo");
  const r = document.getElementById("btn-redo");
  if (!u || !r) return;
  u.disabled = !history.canUndo;
  r.disabled = !history.canRedo;
  u.title = history.canUndo
    ? `Undo${history.undoLabel ? " " + history.undoLabel : ""} (Ctrl+Z)`
    : "Nothing to undo";
  r.title = history.canRedo
    ? `Redo${history.redoLabel ? " " + history.redoLabel : ""} (Ctrl+Y)`
    : "Nothing to redo";
}
/* Rebuild the whole editor from a snapshot. Coarse, and deliberately so: the
   alternative is a command object per mutation, which is a large refactor of
   code that is currently direct and readable. */
function restoreSnapshot(text) {
  if (text === null || text === undefined) return;
  // Rebuilding the editor throws the selection away, which is jarring when the
  // thing you just undid was an edit to the feature you were looking at. Put
  // it back if it still exists.
  const wasSelected = selected ? selected.props.id : null;
  const wasTreatment = selected ? selected.sel : 0;
  restoring = true;
  try {
    const net = parseNetwork(text);
    clearFeatures();
    config = { ...config, areas: net.areas, authorities: net.authorities,
               phases: net.phases, meta: net.meta, costs: net.costs,
               units: net.units };
    loadFeatureCollection(featuresToGeojson(net.features));
    // Undo and import both swap the area list wholesale, so the memoized
  // clip boundary and the drawn outlines have to be rebuilt with it.
  areaClip = null; redrawBoundaries(); renderAreas();
  renderPhases(); renderLegend(); recomputeTotals(); applyPhaseView();
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosave, AUTOSAVE_MS);
  } finally { restoring = false; }
  if (wasSelected) {
    const again = features.find((f) => f.props.id === wasSelected);
    if (again) {
      again.sel = Math.min(wasTreatment, again.treatments.length - 1);
      selectFeature(again);
    }
  }
  syncUndoButtons();
  setStatus();
}
function doUndo() { restoreSnapshot(history.undo()); }
function doRedo() { restoreSnapshot(history.redo()); }
function setStatus(msg) {
  const el = document.getElementById("status");
  if (msg) { el.innerHTML = msg; el.classList.remove("idle"); return; }
  el.innerHTML = dirty ? '<span class="dirty">Saving…</span>' : "All changes saved";
  // The resting state is hidden on a phone, where the row has no space for a
  // message that says nothing; anything else still shows.
  el.classList.toggle("idle", !dirty);
}
function stateData() {
  return { network: featuresToGeojson(features.map(toModelFeature)),
           config: { areas: config.areas, authorities: config.authorities,
                     phases: config.phases, units: config.units,
                     costs: config.costs, meta: config.meta } };
}
async function autosave() {
  if (saving) { saveTimer = setTimeout(autosave, 500); return; }  // one at a time
  saving = true;
  try {
    await store.save(stateData());
    dirty = false; setStatus();
  } catch (e) {
    setStatus('<span class="dirty">Autosave failed — retrying…</span>');
    saveTimer = setTimeout(autosave, 5000);
  }
  saving = false;
}
async function flushSave() {
  clearTimeout(saveTimer);
  while (saving) await new Promise((r) => setTimeout(r, 100));
  if (dirty) await autosave();
  return !dirty;
}
function showExportNotes(s) {
  const c = document.getElementById("result-card"), box = document.getElementById("result");
  const msgs = [...(s.warnings || []).map((w) => `<span class="warn">! ${w}</span>`),
                ...(s.notices || [])];
  if (!msgs.length) { c.style.display = "none"; return; }
  c.style.display = "";
  box.innerHTML = msgs.join("\n");
}

/* ---------- import / export ---------- */
/* A download lands wherever the browser puts it — Downloads on desktop and
   Android, the share sheet on iOS — and a page cannot choose. So the file has
   to be recognisable on its own: name it for the area and the date, and a
   Downloads folder holding three towns' networks stays legible. */
function exportName(ext) {
  const slug = (config.areas.map((a) => a.name).join("-") || "bike-network")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const day = new Date().toISOString().slice(0, 10);
  return `${slug}-network-${day}.${ext}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename || "";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
async function exportYaml() {
  if (await flushSave()) {
    downloadBlob(new Blob([await store.exportYamlText()],
      { type: "application/yaml" }), exportName("yaml"));
  } else setStatus('<span class="dirty">Export failed — couldn’t save</span>');
}
async function makeArtifacts(withPng) {
  await flushSave();
  const net = await store.loadNetwork();
  const rings = await store.boundaryRings();
  const bounds = await store.boundary();
  // Only layers the reader actually turned on are worth embedding in a file
  // they'll email around; the rest stay a click away in the editor.
  const chosen = Object.values(contextLayers)
    .filter((s) => s && s.layer && s.data && map.hasLayer(s.layer))
    .map((s) => ({ entry: s.entry, geojson: s.data }));
  return buildArtifacts(net, rings, bounds,
    { colorMode, renderPng: withPng ? renderPng : null, contextLayers: chosen,
      basemap: place.basemap });
}
async function exportOutput(name) {
  setStatus("Preparing export… (a few seconds)");
  try {
    const art = await makeArtifacts(name === "map.png");
    showExportNotes(art.summary);
    if (name === "map.png") downloadBlob(art.pngBlob, exportName("png"));
    else if (name === "map.html") {
      downloadBlob(new Blob([art.html], { type: "text/html" }), exportName("html"));
    } else {
      downloadBlob(new Blob([JSON.stringify(art.geojson, null, 2)],
        { type: "application/geo+json" }), exportName("geojson"));
    }
    setStatus();
  } catch (e) { console.error(e); setStatus('<span class="dirty">Export failed</span>'); }
}
async function exportBundle() {
  setStatus("Preparing export… (a few seconds)");
  try {
    const net = await store.loadNetwork();
    const art = await makeArtifacts(true);
    showExportNotes(art.summary);
    // A network over many areas ships as one file per area plus an index: a
    // single YAML holding a whole metro is not something anyone emails.
    const entries = shouldSplitByArea(net)
      ? splitByArea(net, { serialize: serializeNetwork })
      : [{ name: "network.yaml", data: await store.exportYamlText() }];
    entries.push(...[
      { name: "map.png", data: new Uint8Array(await art.pngBlob.arrayBuffer()) },
      { name: "map.html", data: art.html },
      { name: "network.geojson", data: JSON.stringify(art.geojson, null, 2) },
    ]);
    const phaseFiles = await buildPhaseArtifacts(
      net, await store.boundaryRings(), await store.boundary(),
      { colorMode, renderPng, features: art.features,
        basemap: place.basemap, onProgress: (msg) => setStatus(msg) });
    for (const f of phaseFiles) {
      entries.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) });
    }
    const zip = await zipCreate(entries);
    downloadBlob(new Blob([zip], { type: "application/zip" }), exportName("zip"));
    setStatus();
  } catch (e) { console.error(e); setStatus('<span class="dirty">Export failed</span>'); }
}
function loadFeatureCollection(fc) {
  for (const gf of (fc && fc.features) || []) {
    const { lines, points } = geometryToLeaflet(gf.geometry);
    if (!lines.length && !points.length) continue;
    const model = featuresFromGeojson({ features: [gf] })[0];
    if (!model) continue;
    addFeature({ id: model.id, name: model.name, on_street: model.on_street,
                 start: model.start, end: model.end, notes: model.notes,
                 tags: model.tags },
               model.treatments.length ? model.treatments : [defaultTreatment()],
               lines, points);
  }
}
async function importFile(file) {
  setStatus("Importing…");
  // A .geojson has no areas, phases or authorities in it — it is geometry plus
  // whatever properties the exporter wrote. It comes in as features ONLY, on
  // top of the config already loaded, which is exactly right for "here is the
  // shape data, keep my setup".
  if (/\.(geojson|json)$/i.test(file.name)) return importGeojsonFile(file);
  // Raw bytes: a .zip bundle (we find the .yaml inside) and a plain YAML file
  // are told apart by content, not extension.
  const j = await store.importBytes(new Uint8Array(await file.arrayBuffer()));
  if (!j.ok) {
    setStatus("Import failed");
    alert("This file isn't a valid network file:\n\n" + (j.errors || []).join("\n"));
    return;
  }
  // Nothing to merge INTO: the first import of an empty map is just a load,
  // and asking a question with one possible answer is worse than not asking.
  if (!features.length) { replaceWith(j); return; }
  openImportSheet(j);
}

async function importGeojsonFile(file) {
  try {
    const doc = JSON.parse(await file.text());
    const parsed = featuresFromGeojson(doc);
    if (!parsed.length) {
      setStatus("");
      alert("No features found in that GeoJSON.\n\nIt should be a "
            + "FeatureCollection of lines and points — the kind this tool "
            + "exports under “GeoJSON (.geojson)”.");
      return;
    }
    clearFeatures();
    loadFeatureCollection(featuresToGeojson(parsed));
    dismissStart();       // this path does not go through afterImport
    areaClip = null; redrawBoundaries(); renderAreas();
    renderPhases(); renderLegend(); recomputeTotals(); applyPhaseView();
    if (networkGroup.getLayers().length) {
      map.fitBounds(networkGroup.getBounds().pad(0.05));
    }
    markDirty();
    setStatus(`Loaded ${parsed.length} feature${parsed.length === 1 ? "" : "s"}.`);
  } catch (e) {
    setStatus("");
    alert(`Couldn't read that GeoJSON: ${e.message}`);
  }
}

/* ---------- importing what OSM already knows ----------
   One query per area, on a click, never automatically — see web/js/osm.js for
   why this is allowed to call Overpass when nothing else in the browser is.
   The results are turned into an ordinary network file and handed to the SAME
   importer as any other file, so the review list, the additive merge and the
   attribution notice all come for free rather than being reimplemented. */
let overpass = null;
let osmAbort = null;
function osmSession() {
  if (!overpass) {
    overpass = new OverpassSession({
      url: (place.fetch || {}).overpass_url,
      // The store's own persistence, so a fetched town survives a reload and
      // never has to be asked for twice.
      cache: store.storage,
    });
  }
  return overpass;
}
function openOsmSheet() {
  const box = document.getElementById("osm-areas");
  box.innerHTML = "";
  if (!config.areas.length) {
    box.innerHTML = '<p class="hint">No areas yet — add one first and there '
      + "will be somewhere to look.</p>";
  }
  for (const a of config.areas) {
    const bbox = bboxOfBoundary(a.boundary);
    const sqkm = bbox ? bboxAreaSqKm(bbox) : 0;
    const tooBig = sqkm > MAX_AREA_SQKM;
    const why = !bbox ? "no outline yet"
      : tooBig ? `about ${Math.round(sqkm)} km² — too large for a live query`
      : `about ${Math.round(sqkm)} km²`;
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = Boolean(bbox) && !tooBig;
    cb.disabled = !bbox || tooBig;
    cb.dataset.areaId = a.id;
    const name = document.createElement("span");
    name.textContent = a.name || a.id;
    const note = document.createElement("span");
    note.className = "why";
    note.textContent = why;
    label.appendChild(cb); label.appendChild(name); label.appendChild(note);
    box.appendChild(label);
  }
  updateOsmWeight();          // also decides whether Look up is available
  document.getElementById("osm-sheet").hidden = false;
}
/* Say BEFORE the button that this one is big. "It failed" after a 40-second
   wait is a worse answer than "this is a lot to ask of a shared service". */
function updateOsmWeight() {
  const paths = document.getElementById("osm-paths").checked;
  const spots = document.getElementById("osm-spots").checked;
  const picked = [...document.querySelectorAll("#osm-areas input:checked")]
    .map((cb) => config.areas.find((a) => String(a.id) === cb.dataset.areaId))
    .filter(Boolean);
  // Grey the button out rather than let someone send a query that cannot
  // return anything.
  const go = document.getElementById("osm-go");
  go.disabled = !picked.length || !(paths || spots);
  if (!picked.length) { osmNote("Pick at least one area."); return; }
  if (!paths && !spots) { osmNote("Pick something to look for."); return; }
  const heavy = picked
    .filter((a) => isHeavy(bboxOfBoundary(a.boundary), { paths, spots }))
    .map((a) => a.name);
  if (!heavy.length) { osmNote(""); return; }
  osmNote(`${heavy.join(" and ")} ${heavy.length === 1 ? "is" : "are"} large, `
    + "so this may take a few minutes of waiting for a free slot. That is "
    + "fine — waiting is what keeps a shared service usable, and anything "
    + "that arrives is cached, so nothing is ever fetched twice. For a very "
    + "large city, adding its boroughs or districts as separate areas works "
    + "better than one giant query.");
}
const closeOsmSheet = () => {
  document.getElementById("osm-sheet").hidden = true;
};
function osmNote(msg, busy = false) {
  const el = document.getElementById("osm-note");
  el.textContent = msg || "";
  // A grey sentence changing every 30 seconds does not read as "working".
  // The pulsing dot does, and it is the difference between a slow tool and a
  // frozen one.
  el.classList.toggle("working", Boolean(busy));
}
/* Look each chosen area up, one at a time, and hand the result to the importer
   as a normal network file. */
async function runOsmImport() {
  const picked = [...document.querySelectorAll("#osm-areas input:checked")]
    .map((cb) => config.areas.find((a) => String(a.id) === cb.dataset.areaId))
    .filter(Boolean);
  if (!picked.length) { osmNote("Pick at least one area."); return; }

  const go = document.getElementById("osm-go");
  const stop = document.getElementById("osm-stop");
  const paths = document.getElementById("osm-paths").checked;
  const spots = document.getElementById("osm-spots").checked;
  go.disabled = true;
  go.textContent = "Looking up…";
  stop.hidden = false;
  osmAbort = new AbortController();
  const session = osmSession();

  // Whatever comes back is KEPT. A run over five boroughs that fails on the
  // fourth used to throw away the first three, so the retry asked the service
  // for them all over again — the single most wasteful thing this tool could
  // do to a rate limit.
  const found = [];
  const failed = [];
  const done = [];
  for (let i = 0; i < picked.length; i++) {
    const a = picked[i];
    const where = `${a.name} (${i + 1} of ${picked.length})`;
    osmNote(`Looking up ${where}…`, true);
    try {
      const elements = await session.elementsForArea(a, {
        paths,
        spots,
        signal: osmAbort.signal,
        // Overpass says when the next slot frees up. Waiting costs it nothing;
        // an error message costs it a button press. Say what we are doing.
        onWait: (secs) => osmNote(
          `OpenStreetMap is busy — waiting ${secs}s for a free slot, then `
          + `${where}. You can stop and keep whatever has arrived.`, true),
      });
      const feats = featuresFromOverpass({ elements }, a.boundary, pointInBoundary);
      for (const f of feats) found.push(f);
      done.push(a.name);
    } catch (e) {
      if (e && e.name === "AbortError") break;
      failed.push({ name: a.name, why: e.message || "the lookup failed" });
    }
  }
  osmAbort = null;
  stop.hidden = true;
  go.disabled = false;
  go.textContent = "Look up";

  if (!found.length) {
    osmNote(failed.length
      ? `Nothing came back. ${failed[0].why}`
      : "OpenStreetMap has nothing mapped in "
        + `${picked.map((a) => a.name).join(", ")} that this tool recognises.`);
    return;
  }
  if (failed.length) {
    // Untick what worked, so pressing Look up again asks ONLY for what didn't.
    const ok = new Set(done);
    for (const cb of document.querySelectorAll("#osm-areas input")) {
      const area = config.areas.find((x) => String(x.id) === cb.dataset.areaId);
      if (area && ok.has(area.name)) cb.checked = false;
    }
    osmNote(`Got ${done.join(", ")}. Couldn't get `
      + `${failed.map((f) => f.name).join(", ")}: ${failed[0].why} `
      + "Those are still ticked — press Look up again to retry just them. "
      + "What already arrived is below and costs nothing to keep.");
  }

  // Deduplicate: two overlapping areas can both return the same way.
  const byId = new Map(found.map((f) => [f.id, f]));
  const text = serializeNetwork(makeNetwork({
    areas: picked.map((a) => makeArea({ ...a })),
    authorities: config.authorities.map((x) => ({ ...x })),
    features: [...byId.values()].map((f) => makeFeature({
      ...f, treatments: f.treatments.map((t) => makeTreatment(t)),
    })),
    units: config.units,
    meta: { ...(config.meta || {}), license: "ODbL-1.0",
            attribution: "\u00a9 OpenStreetMap contributors" },
  }));
  if (spots && !showSpots) setShowSpots(true);   // or it looks like nothing came
  if (!failed.length) closeOsmSheet();
  const j = await store.importBytes(new TextEncoder().encode(text));
  if (!j.ok) {
    alert("The data came back in a shape this version can't read:\n\n"
          + (j.errors || []).join("\n"));
    return;
  }
  // NO empty-map shortcut here. For a FILE import, skipping the sheet on a
  // blank slate is kind — there is nothing to merge into, so the only question
  // has one answer. For an OSM import the question is completely different:
  // "which of these 116 do you actually want", which has many answers, and the
  // sheet has just finished promising to ask it. It asked on top of an
  // existing network and silently imported everything on an empty one.
  openImportSheet(j);
}

/* ---------- starting, and starting over ----------
   An empty map with no explanation is a dead end: nothing to click, no hint
   that importing is even possible. The start sheet is shown whenever there is
   nothing to edit and the user hasn't already said "start a new one". */
const STARTED_KEY = "bnb.started";
const hasStarted = () => {
  try { return localStorage.getItem(STARTED_KEY) === "1"; } catch { return false; }
};
const markStarted = (on) => {
  try {
    if (on) localStorage.setItem(STARTED_KEY, "1");
    else localStorage.removeItem(STARTED_KEY);
  } catch { /* private mode: the sheet reappears, which is survivable */ }
};
function maybeShowStart() {
  if (features.length || hasStarted()) return;
  document.getElementById("start-sheet").hidden = false;
}
/* Starting fresh must not assume WHERE. The deployment's place is a sensible
   default for someone who opened this to work on Malden, but it is noise for
   someone starting a network in Cleveland — and worse, it would silently lend
   them Malden's boundary. So: drop the presumed area and ask. */
function startFresh() {
  config.areas = [];
  areaClip = null;
  redrawBoundaries(); renderAreas(); recomputeTotals();
  document.getElementById("start-sheet").hidden = true;
  openAreaPicker();
}
function dismissStart() {
  markStarted(true);
  document.getElementById("start-sheet").hidden = true;
}
function openResetSheet() {
  const n = features.length;
  document.getElementById("reset-sub").textContent = n
    ? `This deletes all ${n} feature${n === 1 ? "" : "s"} and starts from an `
      + "empty map. Anything you haven't exported is gone for good — this is "
      + "not undoable."
    : "There is nothing drawn yet, so this only clears your settings and "
      + "starts over.";
  document.getElementById("reset-sheet").hidden = false;
}
async function doReset() {
  // Wipe the store, forget that the user ever started, and reload. Reloading
  // is the point: it rebuilds every layer, index and history from nothing,
  // which is what "the same screen you'd get from zero" has to mean.
  markStarted(false);
  dirty = false;                 // don't let a pending autosave rewrite it
  await store.clear();
  location.reload();
}

/* An area with no boundary is not self-describing: nothing to draw, nothing to
   clip against, and area assignment puts every feature in "somewhere else". A
   file upgraded from v1 has exactly that problem, because v1 kept the boundary
   outside the file — and so does any file written before this tool started
   storing it. Lend it the deployment's outline once; autosave then writes it
   into the network, so the file carries its own from then on (V2_PLAN.md D1).
   Only for an area that IS the deployment's place: handing Malden's outline to
   an imported Cleveland would be silently, invisibly wrong. */
async function adoptDeploymentBoundary() {
  const deployment = await store.boundary();
  if (!deployment.length) return false;
  const here = String(place.name || "").trim().toLowerCase();
  let changed = false;
  config.areas = config.areas.map((a) => {
    if ((a.boundary || []).length) return a;
    const name = String(a.name || "").trim().toLowerCase();
    if (name && here && name !== here) return a;
    changed = true;
    return makeArea({ ...a, boundary: deployment });
  });
  if (changed) { areaClip = null; markDirty(); }
  return changed;
}

/* Wholesale replacement — the empty-map case, and what "use theirs everywhere"
   collapses to once it has been confirmed. */
async function replaceWith(j, notes) {
  clearFeatures();
  config = { ...config, ...j.config };
  loadFeatureCollection(j.network);
  await afterImport(j, notes);
}
async function afterImport(j, notes) {
  // ONE place, so no import path can forget. Opening a file from the start
  // sheet used to leave it up over the network it had just loaded, with no
  // way to dismiss it: the .geojson path called dismissStart() and the
  // .yaml/.zip path did not.
  dismissStart();
  // An imported file may carry areas with no outline at all — v1 kept the
  // boundary outside the file, and plenty of v2 files predate this tool
  // writing it. Without this the import "worked" but left Malden with no
  // border, no clipping and zero features until you reloaded.
  await adoptDeploymentBoundary();
  // Undo and import both swap the area list wholesale, so the memoized
  // clip boundary and the drawn outlines have to be rebuilt with it.
  areaClip = null; redrawBoundaries(); renderAreas();
  renderPhases(); renderLegend(); recomputeTotals(); applyPhaseView();
  if (networkGroup.getLayers().length) {
    map.fitBounds(networkGroup.getBounds().pad(0.05));
  }
  markDirty();
  showExportNotes({ notices: notes || [], warnings: [] });
  // The ONE place upgrading an older file has to ask a human: v1 deadlines
  // were free text, and nothing is invented on the user's behalf.
  if ((j.needsDates || []).length) {
    const n = j.needsDates.length;
    setStatus(`Imported. ${n} phase date${n > 1 ? "s" : ""} couldn't be read — `
      + `set ${n > 1 ? "them" : "it"} under “Phases &amp; dates”.`);
    document.getElementById("phases-box").open = true;
  } else setStatus();
}

/* ---------- the import sheet ----------
   The unit of choice is a whole AREA: add theirs, or keep mine. No per-feature
   merge, no conflict resolution. "Advanced" is per-feature SELECTION, which is
   a different and much simpler thing. */
let importState = null;

/* ---------- seeing what you are importing ----------
   Every question the import sheet asks is about geography — which area, which
   feature, whose version of this street. Asking them over a dimmed-out map was
   the whole problem: "Somewhere else" is a perfectly good name for a bucket
   and a useless answer to "where?". So the sheet docks to one side and the
   incoming features are drawn on the map you already have. */
const PREVIEW = "#7c3aed";
let previewLayers = new Map();     // feature id -> layer

function clearPreview() {
  previewGroup.clearLayers();
  previewLayers = new Map();
}
/* Draw every incoming feature. Canvas, so a 3,000-feature OSM import previews
   as cheaply as it draws. */
function drawPreview() {
  clearPreview();
  if (!importState) return;
  for (const f of importState.theirs.features) {
    const parts = (f.geometry || []).filter((p) => p.length >= 2);
    const points = (f.geometry || []).filter((p) => p.length === 1);
    let layer = null;
    if (parts.length) {
      layer = L.polyline(parts.length === 1 ? parts[0] : parts, {
        color: PREVIEW, weight: 4, opacity: 0.9, dashArray: "6,4",
        renderer: networkRenderer, interactive: false, pmIgnore: true });
    } else if (points.length) {
      layer = L.circleMarker(points[0][0], {
        radius: 5, color: PREVIEW, weight: 2, fillColor: PREVIEW,
        fillOpacity: 0.6, renderer: networkRenderer, interactive: false,
        pmIgnore: true });
    }
    if (!layer) continue;
    previewGroup.addLayer(layer);
    previewLayers.set(f.id, layer);
  }
}
/* Highlight one incoming feature — what "hover a row" points at. */
let hotLayer = null;
function highlightIncoming(id) {
  if (hotLayer) {
    hotLayer.setStyle(hotLayer.options.__base);
    hotLayer = null;
  }
  const layer = previewLayers.get(id);
  if (!layer) return;
  layer.options.__base = layer.options.__base || {
    color: layer.options.color, weight: layer.options.weight,
    opacity: layer.options.opacity,
  };
  layer.setStyle({ color: "#f59e0b", weight: 8, opacity: 1 });
  if (layer.bringToFront) layer.bringToFront();
  hotLayer = layer;
}
/* Fit the map to a set of incoming features. This is the answer to "where is
   Somewhere else" — the question the old sheet could not answer at all. */
function focusIncoming(featureList) {
  const pts = [];
  for (const f of featureList) {
    for (const part of f.geometry || []) for (const pt of part) pts.push(pt);
  }
  if (!pts.length) return;
  const bounds = L.latLngBounds(pts);
  // A single point has no extent, so fitBounds would zoom to the maximum.
  if (pts.length === 1) map.setView(pts[0], 17);
  else map.fitBounds(bounds.pad(0.15));
}
const incomingIn = (areaId) => importState.theirs.features.filter(
  (f) => String(importState.plan.theirsBy.get(f.id)) === String(areaId));

/* Where a feature is, in words, for the row. The map is the real answer; this
   is what fits on one line beside a checkbox. */
function whereText(f) {
  if (f.on_street) return f.on_street;
  const first = (f.geometry || []).flat()[0];
  if (!first) return "";
  return `${first[0].toFixed(4)}, ${first[1].toFixed(4)}`;
}

function openImportSheet(j) {
  const theirs = j.parsed;
  const mine = liveNetwork();
  const plan = planMerge(mine, theirs);
  const areaChoices = {};
  plan.areas.forEach((a) => { areaChoices[String(a.id)] = a.choice; });
  const phaseMapping = {};
  plan.phases.rows.forEach((r) => { phaseMapping[r.fromId] = r.toId; });
  importState = { j, theirs, mine, plan, areaChoices, phaseMapping,
                  featureChoices: null };

  const decided = plan.areas.filter((a) => !a.untouched).length;
  const n = theirs.features.length;
  document.getElementById("import-title").textContent =
    `${n} feature${n === 1 ? "" : "s"} in ${decided} area${decided === 1 ? "" : "s"}`;

  // A file pulled from OpenStreetMap gets its review list OPEN, not tucked
  // behind "Advanced". OSM's idea of a bike lane is not always yours — a
  // painted strip between a bus lane and a traffic lane is tagged as a
  // cycleway and is not a facility anyone would call protected. You see the
  // candidates, you untick what you don't want, nothing lands blind.
  const fromOsm = theirs.features.some((f) => (f.tags || {}).source === "osm");
  const advanced = document.getElementById("import-advanced");
  // Collapsed by default, always. An OSM import is thousands of rows, and
  // opening it made the panel unreadable at the moment it mattered most.
  advanced.open = false;
  advanced.querySelector("summary").textContent =
    `Pick individual features (${theirs.features.length})`;
  document.getElementById("import-sub").textContent = fromOsm
    ? "From OpenStreetMap. Check what you would call existing infrastructure."
    : plan.additive
      ? "Existing conditions. Nothing of yours is replaced."
      : "Nothing is replaced unless you say so.";
  // An additive file has no keep-mine/use-theirs question to ask.
  document.getElementById("import-areas").hidden = plan.additive;
  document.getElementById("import-all").hidden = plan.additive;
  if (plan.additive) {
    document.getElementById("import-title").textContent =
      `${theirs.features.length} already on the ground`;
  }
  renderImportAreas();
  renderImportSeam();
  renderImportFeatures();
  renderImportPhases();
  document.getElementById("import-sheet").hidden = false;
  drawPreview();
  focusIncoming(theirs.features);
  setStatus();
}
function closeImportSheet() {
  document.getElementById("import-sheet").hidden = true;
  clearPreview();
  importState = null;
}
function renderImportAreas() {
  const box = document.getElementById("import-areas");
  box.innerHTML = "";
  for (const a of importState.plan.areas) {
    const row = document.createElement("div");
    row.className = "imp-area-row" + (a.untouched ? " untouched" : "");
    const key = String(a.id);
    const name = document.createElement("span");
    name.className = "area-name";
    name.textContent = a.name;
    const cnt = document.createElement("span");
    cnt.className = "area-counts";
    cnt.textContent = a.untouched ? "not in this file"
      : `${a.theirsCount} in the file \u00b7 you have ${a.mineCount || "none"}`;
    row.appendChild(name);
    row.appendChild(cnt);

    if (!a.untouched) {
      // "Somewhere else" is an honest label and a useless answer to "where?".
      // This is the button that answers it.
      const show = document.createElement("button");
      show.type = "button";
      show.className = "ghost show";
      show.textContent = "Show";
      show.title = `Zoom to what this file has in ${a.name}`;
      show.addEventListener("click", () => focusIncoming(incomingIn(a.id)));
      row.appendChild(show);

      const choice = document.createElement("span");
      choice.className = "area-choice";
      for (const [value, label] of [["theirs", a.isNew ? "Add" : "Use theirs"],
                                    ["mine", a.isNew ? "Skip" : "Keep mine"]]) {
        const l = document.createElement("label");
        const r = document.createElement("input");
        r.type = "radio";
        r.name = `area-${key}`;
        r.value = value;
        r.checked = importState.areaChoices[key] === value;
        r.addEventListener("change", () => {
          importState.areaChoices[key] = value;
          // The radio is a shortcut for ticking that area's features, not a
          // separate decision that overrules them.
          if (!importState.featureChoices) importState.featureChoices = {};
          for (const f of incomingIn(a.id)) {
            importState.featureChoices[f.id] = (value === "theirs");
          }
          renderImportSeam();
          renderImportFeatures();
        });
        l.appendChild(r);
        l.appendChild(document.createTextNode(" " + label));
        choice.appendChild(l);
      }
      row.appendChild(choice);
    }
    box.appendChild(row);
  }
}

function renderImportSeam() {
  const el = document.getElementById("import-seam");
  const names = importState.plan.seamCrossing;
  if (!names.length) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${names.length} `
    + `${names.length === 1 ? "feature crosses" : "features cross"} into areas `
    + `you're keeping — they stay as you have them.`;
}
function renderImportFeatures() {
  const box = document.getElementById("import-features");
  box.innerHTML = "";
  const { plan, featureChoices } = importState;
  const chosen = (f) => (featureChoices && featureChoices[f.id] !== undefined
    ? featureChoices[f.id]
    : plan.additive
      || importState.areaChoices[String(plan.theirsBy.get(f.id))] === "theirs");

  // Grouped by area, and ALWAYS showing every area — including ones set to
  // "keep mine". Deciding one street at a time used to be impossible: a
  // feature only appeared once its whole area had been accepted.
  let any = false;
  for (const a of plan.areas) {
    const list = incomingIn(a.id);
    if (!list.length) continue;
    any = true;
    const group = document.createElement("div");
    group.className = "imp-group";
    const h = document.createElement("h4");
    h.textContent = `${a.name} \u2014 ${list.length}`;
    group.appendChild(h);
    for (const f of list) {
      const row = document.createElement("label");
      row.className = "imp-feature";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = chosen(f);
      cb.addEventListener("change", () => {
        if (!importState.featureChoices) importState.featureChoices = {};
        importState.featureChoices[f.id] = cb.checked;
        renderImportSeam();
      });
      const name = document.createElement("span");
      name.textContent = f.name || "(unnamed)";
      const where = document.createElement("span");
      where.className = "where";
      where.textContent = whereText(f);
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(where);
      // Hover to find it, click to go there. "Bollards" means nothing on its
      // own; where it is means everything.
      row.addEventListener("mouseenter", () => highlightIncoming(f.id));
      row.addEventListener("mouseleave", () => highlightIncoming(null));
      row.addEventListener("click", (e) => {
        if (e.target !== cb) focusIncoming([f]);
      });
      group.appendChild(row);
    }
    box.appendChild(group);
  }
  if (!any) box.innerHTML = '<p class="hint">This file has no features.</p>';
}

function renderImportPhases() {
  const wrap = document.getElementById("import-phases");
  const plan = importState.plan.phases;
  // Skipped entirely when it would be trivial — the fantasy-map user who put
  // everything in one phase should never learn this screen exists.
  if (plan.trivial) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const box = document.getElementById("import-phase-rows");
  box.innerHTML = "";
  for (const r of plan.rows) {
    const row = document.createElement("div");
    row.className = "phase-row";
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = `Their “${r.fromLabel}”`
      + (r.fromDate ? ` (${r.fromDate})` : "") + " →";
    const sel = document.createElement("select");
    // Labels and dates, never bare numbers: "Phase 2" isn't a choice anyone
    // can make.
    for (const o of plan.options) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = `your ${o.label}${o.date ? ` — ${o.date}` : ""}`;
      sel.appendChild(opt);
    }
    const extra = document.createElement("option");
    extra.value = "__new__";
    extra.textContent = "…add it as a new phase at the end";
    sel.appendChild(extra);
    sel.value = importState.phaseMapping[r.fromId] || plan.options[0].id;
    sel.addEventListener("change", () => {
      importState.phaseMapping[r.fromId] = sel.value;
      checkPhaseOrder();
    });
    row.appendChild(from); row.appendChild(sel);
    box.appendChild(row);
  }
  checkPhaseOrder();
}
function checkPhaseOrder() {
  const plan = importState.plan.phases;
  const rows = plan.rows.map((r) => ({ ...r,
    toId: importState.phaseMapping[r.fromId] }));
  const warn = document.getElementById("import-phase-warn");
  // Many-to-one is a normal thing to want. Only order inversion warns.
  if (plan.isInverted(rows)) {
    warn.hidden = false;
    warn.textContent = "⚠ Their later phase is going into an earlier phase "
      + "than their earlier one. That's allowed, but their sequencing won't "
      + "survive the import.";
  } else warn.hidden = true;
}
function bindImportSheet() {
  document.getElementById("import-x").onclick = closeImportSheet;
  document.getElementById("import-show-all").onclick = () => {
    if (importState) focusIncoming(importState.theirs.features);
  };
  document.getElementById("import-show-mine").addEventListener("change", (e) => {
    // Seeing your own network under theirs is how you spot the overlap.
    for (const g of [networkGroup, overlayGroup]) {
      if (e.target.checked) map.addLayer(g); else map.removeLayer(g);
    }
  });
  document.getElementById("import-cancel").onclick = () => {
    closeImportSheet(); setStatus("Import cancelled.");
  };
  document.getElementById("import-all").onclick = async () => {
    // Naming the cost, and offering the only undo this tool has.
    const losing = importState.plan.areas
      .filter((a) => !a.untouched && a.mineCount > 0)
      .map((a) => `${a.mineCount} in ${a.name}`);
    if (losing.length) {
      const msg = `This replaces ${losing.join(" and ")} with the ones in this `
        + `file. There's no undo.\n\nSave a copy of your network first?`;
      if (confirm(msg)) await exportYaml();
      if (!confirm("Go ahead and use theirs everywhere?")) return;
    }
    for (const a of importState.plan.areas) {
      if (!a.untouched) importState.areaChoices[String(a.id)] = "theirs";
    }
    doImport();
  };
  document.getElementById("import-go").onclick = doImport;
}
async function doImport() {
  const { theirs, mine, plan, areaChoices, phaseMapping, featureChoices }
    = importState;
  const merged = applyMerge(mine, theirs,
    { areaChoices, phaseMapping, featureChoices, additive: plan.additive });
  const notes = describeMerge(plan, areaChoices, {
    additive: plan.additive,
    added: merged.features.length - mine.features.length });
  // Two files that each declare a different licence: say so and move on. The
  // tool cannot know whether they may be combined, and only the person who
  // knows the provenance can.
  const clash = licenseConflict(mine.meta, theirs.meta);
  if (clash) notes.push(clash);
  // OSM is ODbL: extracting geometry into a file you then share makes a
  // derivative database, which carries share-alike and attribution. Adopt the
  // licence rather than routing around it — a community-built map staying open
  // to the community that built it is what this project wants anyway.
  if (merged.features.some((f) => (f.tags || {}).source === "osm")) {
    merged.meta = { ...merged.meta,
      license: merged.meta.license || theirs.meta.license || "ODbL-1.0" };
    if (!(merged.meta.contributors || []).some(
      (c) => /openstreetmap/i.test(c.name || ""))) {
      merged.meta.contributors = [...(merged.meta.contributors || []),
        { name: "OpenStreetMap contributors", kind: "organization" }];
    }
    notes.push("This network now contains OpenStreetMap data, so it is "
      + "ODbL-1.0 and credits OpenStreetMap contributors. Keep that "
      + "attribution on anything you share or publish.");
  }
  const j = importState.j;
  closeImportSheet();

  clearFeatures();
  config = { ...config,
             areas: merged.areas, authorities: merged.authorities,
             phases: merged.phases, meta: merged.meta };
  loadFeatureCollection(featuresToGeojson(merged.features));
  await afterImport(j, notes);
}

/* ---------- snap to roads ---------- */
let snapUnavailable = false;
async function snapPoints(pts) {
  // pts: [[lat,lng],...]; returns road-following [[lat,lng],...] or null.
  if (snapUnavailable) return null;
  try {
    if (!store._graph) setStatus("Loading street data…");
    // Ask for the streets around what is being drawn, not for a city: the
    // graph grows to fit where you work (V2_PLAN.md §8.3).
    const lats = pts.map((p) => Number(p[0])), lons = pts.map((p) => Number(p[1]));
    const pad = 0.01;   // ~1 km, so a route can reach past its own endpoints
    const bbox = [Math.min(...lats) - pad, Math.min(...lons) - pad,
                  Math.max(...lats) + pad, Math.max(...lons) + pad];
    const source = await store.streetGraphFor(bbox);
    // No street data for here: snapping is unavailable, and a click behaves
    // exactly like an off-street click already does. Say it once, quietly,
    // rather than failing on every point.
    if (!source) {
      if (!snapUnavailable) {
        snapUnavailable = true;
        setStatus("Snapping isn’t available here yet — lines stay where you draw them.");
      }
      return null;
    }
    const route = snapRoute(pts, source.graph.adj, source.graph.coord, 0.02,
                            source.index);
    // Snapping no longer clips. It used to, which meant only SNAPPED lines
    // stopped at the border and only the longest piece survived; clipping is
    // now one rule applied to everything at commit time. See clipToAreas.
    return route.length >= 2 ? route : null;
  } catch (e) { snapUnavailable = true; console.error(e); return null; }
}
async function snapSelected() {
  if (!selected || !selected.layer) return;
  setStatus("Snapping to roads…");
  // Combined corridors snap part by part, so independent (off-street) pieces
  // that fail to snap simply keep their drawn shape.
  const out = []; let anySnapped = false;
  for (const seg of segsOf(selected.layer)) {
    const snapped = await snapPoints(seg.map((p) => [p.lat, p.lng]));
    if (snapped) { anySnapped = true; out.push(snapped.map((c) => L.latLng(c[0], c[1]))); }
    else out.push(seg);
  }
  setSegs(selected.layer, out);
  syncOverlays(selected); updateArrows(selected);
  if (anySnapped) { updateLenField(selected); recomputeTotals(); markDirty(); }
  setStatus(anySnapped ? "" : "Couldn’t snap (kept the drawn shape).");
}
function reverseSelected() {
  if (!selected || !selected.layer) return;
  const segs = segsOf(selected.layer).slice().reverse()
    .map((seg) => seg.slice().reverse());
  setSegs(selected.layer, segs);
  // `side` is relative to the point order, so reversing has to flip it too —
  // otherwise reversing silently moves the facility across the street.
  selected.treatments.forEach((t) => {
    if (t.side === "left") t.side = "right";
    else if (t.side === "right") t.side = "left";
  });
  syncOverlays(selected); updateArrows(selected);
  if (selected) fillForm(selected);
  markDirty();
}

/* ---------- drawing / edit mode ---------- */
let drawDefaults = null, placingPoint = null;
function startDraw(over) {
  // Drawing means editing the full plan — leave any phase preview first.
  if (phaseView !== "all") setPhaseView("all");
  drawDefaults = over; deselect();
  map.pm.enableDraw("Line", { finishOn: "dblclick", continueDrawing: false });
  const snap = document.getElementById("snap").checked;
  setStatus("Click along the route; double-click to finish; Backspace undoes "
    + "the last point."
    + (snap ? " Clicks near a street snap to it; clicks away from streets "
            + "(parks, trails) stay where you put them." : ""));
}
function startPlacePoint(over) {
  if (phaseView !== "all") setPhaseView("all");
  // Asking to add a spot is asking to see spots. Placing one into a hidden
  // layer would look exactly like the click doing nothing.
  if (!showSpots) setShowSpots(true);
  deselect();
  placingPoint = over || { status: "proposed" };
  setStatus(placingPoint.status === "existing"
    ? "Click the map where it is — Esc cancels."
    : "Click the map where the improvement goes — Esc cancels.");
}
function undoDrawVertex() {
  const d = map.pm.Draw && map.pm.Draw.Line;
  if (d && d._enabled && typeof d._removeLastVertex === "function") {
    d._removeLastVertex();
    return true;
  }
  return false;
}
/* Shape editing belongs to the thing being edited. It used to be a global
   mode toggled from the header, which meant "reshape a line" and "which line"
   were two separate acts; now it is a button on the selected feature and only
   that feature's vertices become draggable. */
function editingFeature() {
  return features.find((f) => f.layer && f.layer.pm && f.layer.pm.enabled());
}
function stopEditingShape() {
  const f = editingFeature();
  if (f) f.layer.pm.disable();
  const btn = document.getElementById("btn-edit");
  if (btn) btn.classList.remove("toggled");
}
function toggleEditShape() {
  if (!selected || !selected.layer) return;
  const on = selected.layer.pm.enabled();
  stopEditingShape();
  if (!on) {
    selected.layer.pm.enable({ allowSelfIntersection: true });
    document.getElementById("btn-edit").classList.add("toggled");
    setStatus("Drag the dots to reshape this line. Click Edit shape again when done.");
  } else setStatus();
}

/* ---------- init ---------- */
async function init() {
  // Nothing that happens while the editor is BUILDING ITSELF is an undoable
  // edit — adopting the deployment's boundary is housekeeping, and offering to
  // undo it would put a live Undo button on a freshly loaded page pointing at
  // a step the user never took.
  restoring = true;

  // The opening view comes from the deployment's place, never from a constant.
  // A place with no centre falls through to fitBounds() below, which frames
  // the network or the boundary — guessing a centre would drop the user
  // somewhere plausible-looking and wrong.
  place = await store.place();
  map = L.map("map", { zoomControl: true });
  if (place.mapCenter) map.setView(place.mapCenter, place.mapZoom);
  else map.setView([0, 0], 2);
  // The basemap comes from place.json. It used to be a hardcoded CARTO URL,
  // which broke the day CARTO began requiring an API key — and a static app
  // has nowhere to put a private key. Which tiles to draw is a deployment's
  // decision now.
  L.tileLayer(place.basemap.url, {
    attribution: place.basemap.attribution,
    maxZoom: place.basemap.maxZoom,
  }).addTo(map);
  // SVG stops being viable in the low thousands of polylines, which a
  // multi-town network reaches easily. One shared canvas renderer for the
  // network keeps panning smooth; context layers already had their own.
  // `tolerance` extends the clickable band around every line. Without it the
  // target is the stroke itself, so a 4px line is a 4px target — workable
  // zoomed in and genuinely annoying zoomed out, which is exactly where you
  // are when picking a corridor out of a whole town. 10px is about a
  // fingertip, and it costs nothing to draw.
  networkRenderer = L.canvas({ padding: 0.4, tolerance: 10 });
  networkGroup = L.featureGroup().addTo(map);
  overlayGroup = L.layerGroup().addTo(map);
  // Glyph runs get their OWN group so the whole lot can leave the map in one
  // call when zoomed out, the way arrows already do. Mixed in with the stroke
  // overlays they would have to be removed one at a time.
  glyphGroup = L.layerGroup().addTo(map);
  // What an import would bring in, drawn on the real map while you decide.
  previewGroup = L.layerGroup().addTo(map);
  // Before boundaryGroup so the shading sits UNDER the outlines, and separate
  // from it because boundaryGroup feeds fitBounds().
  maskGroup = L.layerGroup().addTo(map);
  boundaryGroup = L.featureGroup().addTo(map);
  arrowsGroup = L.layerGroup().addTo(map);
  pointsGroup = L.layerGroup().addTo(map);
  map.pm.setGlobalOptions({ pmIgnore: false });

  const data = await store.state();
  baseNet = await store.loadNetwork();
  options = data.options;
  config = { ...config, ...data.config };
  // A network with no areas of its own takes the deployment's, so a fresh
  // browser still says where it is on every export.
  if (!config.areas.length && place.name) {
    config.areas = [makeArea({ id: place.id || newId("a-"), name: place.name,
                               kind: place.kind, context: place.context,
                               default_authority: place.defaultAuthority })];
  }
  if (!config.authorities.length) config.authorities = place.authorities || [];

  // An area with no boundary is not self-describing, and area assignment on
  // import has nothing to work with — every feature would land in "somewhere
  // else". A file upgraded from v1 has exactly that problem, because v1 kept
  // the boundary outside the file. Adopt the deployment's boundary once, and
  // autosave writes it into the network so the file carries its own outline
  // from then on (V2_PLAN.md D1).
  await adoptDeploymentBoundary();

  redrawBoundaries();

  loadFeatureCollection(data.network);

  // Frame whatever there is to look at: the network, or failing that the
  // areas. A deployment with no `map` in place.json has nothing else to go on.
  const fitToContent = () => {
    if (networkGroup.getLayers().length) {
      map.fitBounds(networkGroup.getBounds().pad(0.05));
    } else if (boundaryGroup.getLayers().length) {
      map.fitBounds(boundaryGroup.getBounds());
    }
  };
  fitToContent();
  // ...but the container can be sized AFTER load: a pane that opens later, a
  // tab restored in the background, a split view being dragged. Leaflet
  // measures a zero-size container, clamps to zoom 0, and leaves the user
  // looking at the whole planet with no idea why. Re-measure when a size
  // arrives, and frame the content once, the first time there is a size to
  // frame it against — refitting on every resize would fight the user's own
  // panning.
  let everSized = map.getContainer().clientWidth > 0;
  new ResizeObserver(() => {
    if (!map.getContainer().clientWidth) return;
    map.invalidateSize();
    if (!everSized) { everSized = true; fitToContent(); }
  }).observe(map.getContainer());
  map.on("zoomend", onZoomChanged);
  syncArrowVisibility();
  setShowSpots(false);        // the default, and it draws the initial state
  lastBand = renderBand();

  map.on("pm:create", async (e) => {
    const drawn = segsOf(e.layer)[0].map((p) => [p.lat, p.lng]);
    map.removeLayer(e.layer); map.pm.disableDraw();
    let geom = drawn;
    if (document.getElementById("snap").checked) {
      setStatus("Snapping to roads…");
      geom = await snapPoints(drawn) || drawn;
    }
    // Clip once, here, for snapped and freehand lines alike.
    const { pieces, trimmed, outside } = clipToAreas(geom);
    if (!pieces.length) {
      // Refusing beats the old behaviour, which created an invisible stub with
      // a default name that you could not find or select to delete.
      showClipNotice(`That is entirely outside ${areaNames() || "your areas"}, `
        + "so nothing was added.", outside);
      setStatus();
      return;
    }
    if (trimmed) {
      showClipNotice(`Trimmed to the edge of ${areaNames() || "your areas"}.`,
                     outside);
    } else { hideClipNotice(); }
    const f = addFeature(defaultProps(), [defaultTreatment(drawDefaults)],
                         pieces.map((pc) => pc.map((c) => L.latLng(c[0], c[1]))), []);
    selectFeature(f); markDirty(); recomputeTotals(); setStatus();
  });
  map.on("click", (e) => {
    if (!placingPoint) return;
    const over = placingPoint;
    if (!insideAreas(e.latlng)) {
      showClipNotice(`That spot is outside ${areaNames() || "your areas"}, `
        + "so nothing was added.", [e.latlng.lat, e.latlng.lng]);
      return;   // stay in placing mode: the next click can land inside
    }
    placingPoint = null;
    hideClipNotice();
    const f = addFeature(
      defaultProps({ name: over.status === "existing" ? "Existing spot" : "New spot" }),
      [defaultTreatment({ type: "speed_hump", ...over })], [], [e.latlng]);
    selectFeature(f); markDirty(); recomputeTotals(); setStatus();
  });

  bindForm(); bindImportSheet(); renderPhases(); renderAreas(); renderLegend();
  recomputeTotals(); setStatus();
  // Startup is over; from here, edits count.
  restoring = false;
  // The baseline every undo walks back toward.
  recordHistory("");
  applyPhaseView();   // a fresh load must already honour upgrades
  maybeShowStart();
  initDebug();
  initContextLayers();

  document.getElementById("btn-edit").onclick = toggleEditShape;
  document.getElementById("btn-add-path").onclick =
    () => startDraw({ status: "proposed" });
  document.getElementById("btn-add-existing-path").onclick =
    () => startDraw({ status: "existing", type: "shared_use_path", phase: null });
  document.getElementById("btn-add-spot").onclick =
    () => startPlacePoint({ status: "proposed" });
  document.getElementById("btn-add-existing-spot").onclick =
    () => startPlacePoint({ status: "existing", phase: null });
  // Two snap checkboxes (one per header tier) driving one setting.
  const snapRoomy = document.getElementById("snap-roomy");
  const snapMenu = document.getElementById("snap");
  const syncSnap = (from, to) => { to.checked = from.checked; };
  snapRoomy.addEventListener("change", () => syncSnap(snapRoomy, snapMenu));
  snapMenu.addEventListener("change", () => syncSnap(snapMenu, snapRoomy));
  const importInput = document.getElementById("import-file");
  wireMenu("btn-import", "import-menu", (b) => {
    if (b.dataset.import === "osm") openOsmSheet();
    else importInput.click();
  });
  document.getElementById("osm-spots").addEventListener("change", updateOsmWeight);
  document.getElementById("osm-paths").addEventListener("change", updateOsmWeight);
  document.getElementById("osm-areas").addEventListener("change", updateOsmWeight);
  document.getElementById("osm-cancel").onclick = closeOsmSheet;
  document.getElementById("osm-x").onclick = closeOsmSheet;
  document.getElementById("osm-go").onclick = runOsmImport;
  document.getElementById("osm-stop").onclick = () => {
    if (osmAbort) osmAbort.abort();
  };
  document.getElementById("btn-undo").onclick = doUndo;
  document.getElementById("btn-redo").onclick = doRedo;
  document.getElementById("btn-add-phase").onclick = addPhase;
  document.getElementById("btn-snap-sel").onclick = snapSelected;
  document.getElementById("btn-reverse").onclick = reverseSelected;
  document.getElementById("btn-combine").onclick = startCombine;
  document.getElementById("unnamed-warn").onclick = selectNextUnnamed;
  document.getElementById("group-by").addEventListener("change", recomputeTotals);
  const areaInput = document.getElementById("area-file");
  document.getElementById("btn-add-area").onclick = openAreaPicker;
  document.getElementById("clip-notice-add").onclick = openAreaPicker;
  document.getElementById("clip-notice-x").onclick = hideClipNotice;
  document.getElementById("area-cancel").onclick = closeAreaPicker;
  document.getElementById("area-file-btn").onclick = () => {
    closeAreaPicker(); areaInput.click();
  };
  document.getElementById("area-picker").addEventListener("click", (e) => {
    if (e.target.id === "area-picker") closeAreaPicker();   // click the backdrop
  });
  let searchSeq = 0, searchTimer = null;
  document.getElementById("area-search").addEventListener("input", (e) => {
    const text = e.target.value;
    clearTimeout(searchTimer);
    // Debounced: one request per pause in typing, not one per keystroke.
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      const box = document.getElementById("area-results");
      if (text.trim().length < 2) { box.innerHTML = ""; return; }
      box.innerHTML = '<span class="none">Searching…</span>';
      try {
        const list = await searchAreas(text, { ...netOpts(), preferState: currentState() });
        if (seq !== searchSeq) return;      // a later keystroke already won
        renderChoices(box, list, { empty: `Nothing found for “${text}”.` });
      } catch (err) {
        if (seq !== searchSeq) return;
        box.innerHTML = `<span class="none">${offlineNote(err, "Search failed.")}</span>`;
      }
    }, 350);
  });
  areaInput.addEventListener("change", (e) => {
    if (e.target.files.length) addAreaFromFile(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("show-boundary").addEventListener("change", redrawBoundaries);
  // Two checkboxes (header on roomy screens, Display menu elsewhere), one
  // setting — the same arrangement Snap already uses.
  for (const id of ["show-spots", "show-spots-roomy"]) {
    document.getElementById(id).addEventListener("change",
      (e) => setShowSpots(e.target.checked));
  }
  const unitsSel = document.getElementById("units");
  if (unitsSel) {
    unitsSel.value = units;
    unitsSel.addEventListener("change", (e) => {
      units = e.target.value;
      recomputeTotals(); if (selected) updateLenField(selected);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && combineFrom) { combineFrom = null; setStatus(); }
    if (e.key === "Escape" && placingPoint) { placingPoint = null; setStatus(); }
    if (e.key === "Escape") stopEditingShape();
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+Z while drawing removes the last clicked point; otherwise it undoes
    // an edit. The in-progress drawing wins, because that is what the key was
    // doing a moment ago.
    if (!typing && (e.key === "Backspace" || e.key === "Delete"
                    || (mod && e.key.toLowerCase() === "z"))) {
      if (undoDrawVertex()) { e.preventDefault(); return; }
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
      e.preventDefault(); doUndo(); return;
    }
    if (mod && (e.key.toLowerCase() === "y"
                || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      e.preventDefault(); doRedo();
    }
  });
  // Mobile: the sidebar is a slide-over panel; a peek bar previews taps.
  const sidebar = document.querySelector(".sidebar");
  document.getElementById("mobile-details").onclick = () => {
    sidebar.classList.toggle("open");
    document.getElementById("peek").classList.remove("show");
  };
  document.getElementById("mobile-close").onclick = () => sidebar.classList.remove("open");
  document.getElementById("peek-edit").onclick = () => {
    sidebar.classList.add("open");
    document.getElementById("peek").classList.remove("show");
    document.getElementById("prop-form").scrollIntoView({ block: "center" });
  };

  document.getElementById("phase-view").addEventListener("change", (e) => {
    phaseView = e.target.value; applyPhaseView();
  });

  const phasesBox = document.getElementById("phases-box");
  phasesBox.open = (colorMode === "phase");
  document.getElementById("color-mode").value = colorMode;
  document.getElementById("color-mode").addEventListener("change", (e) => {
    colorMode = e.target.value; restyleAll(); renderLegend();
    // Phases are front-and-center only when the map is coloured by them.
    phasesBox.open = (colorMode === "phase");
  });

  // One behaviour for every header menu: click to open, click anywhere to
  // close, and a click inside a menu that isn't a command (a select, a
  // checkbox) leaves it open so you can change two things at once.
  function wireMenu(buttonId, menuId, onCommand) {
    const button = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = menu.hidden;
      closeMenus();
      menu.hidden = !wasHidden;
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
    menu.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => { menu.hidden = true; onCommand(b); });
    });
  }
  function closeMenus() {
    ["add-menu", "display-menu", "export-menu", "more-menu",
     "import-menu"].forEach((id) => {
      const m = document.getElementById(id);
      if (m) m.hidden = true;
    });
  }
  document.addEventListener("click", closeMenus);

  wireMenu("btn-add", "add-menu", (b) => {
    switch (b.dataset.add) {
      case "path": startDraw({ status: "proposed" }); break;
      case "existing-path":
        startDraw({ status: "existing", type: "shared_use_path", phase: null });
        break;
      case "spot": startPlacePoint({ status: "proposed" }); break;
      case "existing-spot":
        startPlacePoint({ status: "existing", phase: null });
        break;
      default: break;
    }
  });
  wireMenu("btn-display", "display-menu", () => {});
  wireMenu("btn-more", "more-menu", (b) => {
    if (b.dataset.more === "help") window.open("help.html", "_blank");
    else if (b.dataset.more === "reset") openResetSheet();
    else if (b.dataset.more === "osm") openOsmSheet();
    else document.getElementById("import-file").click();
  });
  wireMenu("btn-export", "export-menu", (b) => {
    const kind = b.dataset.export;
    if (kind === "yaml") exportYaml();
    else if (kind === "bundle") exportBundle();
    else exportOutput(kind);
  });

  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files.length) importFile(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("start-fresh").onclick = startFresh;
  // A modal with no way out is a trap however good its two options are, and
  // this one sits over a map the user may already be able to see.
  document.getElementById("start-x").onclick = dismissStart;
  document.getElementById("start-import").onclick = () => {
    document.getElementById("import-file").click();
  };
  document.getElementById("btn-reset").onclick = openResetSheet;
  const closeReset = () => {
    document.getElementById("reset-sheet").hidden = true;
  };
  document.getElementById("reset-cancel").onclick = closeReset;
  document.getElementById("reset-x").onclick = closeReset;
  document.getElementById("reset-go").onclick = doReset;
  document.getElementById("reset-export").onclick = async () => {
    // Export FIRST, and only reset if it actually produced a file — otherwise
    // "export, then reset" would happily throw the work away on a failure.
    try { await exportBundle(); } catch (e) {
      alert(`Export failed, so nothing was reset:\n\n${e.message}`);
      return;
    }
    await doReset();
  };
  // Last-ditch flush if the tab closes inside the autosave debounce window.
  // localStorage writes are synchronous, so this completes even during
  // teardown. Mobile browsers often kill tabs with no pagehide, so
  // visibilitychange (fires when the app is backgrounded) matters there.
  const syncFlush = () => {
    if (dirty && baseNet) {
      try { store.saveSync(stateData(), baseNet); dirty = false; setStatus(); }
      catch (e) { /* keep dirty; the debounced autosave will retry */ }
    }
  };
  // Leaflet doesn't notice its container changing size (phone rotation, a
  // header row wrapping, the browser chrome hiding), and leaves the new area
  // blank grey until told. Debounced so a drag-resize isn't a redraw storm.
  let resizeTimer = null;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => map.invalidateSize(), 150);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

  window.addEventListener("pagehide", syncFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") syncFlush();
  });
}
init();
