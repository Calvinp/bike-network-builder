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

import { buildArtifacts, buildPhaseArtifacts } from "./js/export.js";
import { clipPolylineLatlon, longestPiece } from "./js/boundary.js";
import { featuresFromGeojson, featuresToGeojson } from "./js/geojson.js";
import { renderPng } from "./js/render_png.js";
import { registry } from "./js/registry.js";
import {
  BOUNDARY_COLOR, EXISTING_COLOR, FUNDED_COLOR, PHASE_COLORS, SINGLE_COLOR,
  UNDER_CONSTRUCTION_COLOR, featureStrokes, pointColor, treatmentGlyph,
  treatmentLabel,
} from "./js/render_common.js";
import { KM_PER_MI, MI_PER_KM } from "./js/costs.js";
import { makeArea, makeFeature, makeNetwork, makePhase, makeTreatment, newId }
  from "./js/network_format.js";
import { applyMerge, describeMerge, planMerge } from "./js/merge.js";
import { partsKm, summarize } from "./js/pipeline.js";
import { snapRoute } from "./js/routing.js";
import { Store } from "./js/store.js";
import { zipCreate } from "./js/zip.js";

const BOUNDARY = BOUNDARY_COLOR;

const store = new Store();
let baseNet = null;         // last parsed stored network (uneditable fields)
let clipBoundary = null;    // assembled area multipolygon (clipping)
let place = null;           // the deployment default area (data/place.json)

let map, networkGroup, boundaryGroup, arrowsGroup, pointsGroup, overlayGroup;
let features = [];          // [{props, treatments, sel, layer, overlays, markers, arrows}]
let selected = null;
let options = {};
let config = { areas: [], authorities: [], phases: [], units: "metric",
               costs: {}, meta: {} };
let units = "imperial";     // DISPLAY preference; storage is always metric
let colorMode = "phase";
let phaseView = "all";
let editMode = false, dirty = false, combineFrom = null;

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
function strokesFor(f) {
  return featureStrokes({ treatments: f.treatments }, colorMode,
                        { phaseNumberOf, zoom: map ? map.getZoom() : undefined });
}
function strokeOpts(s, isSelected) {
  return { color: s.color, weight: s.weight + (isSelected ? 3 : 0),
           dashArray: s.dashArray, opacity: 0.95, lineCap: "round" };
}
/* The stroke count changes whenever treatments are added or removed, so the
   overlay layers are rebuilt rather than restyled. */
function restyle(f) {
  if (!f.layer) { syncMarkers(f); return; }
  const strokes = strokesFor(f);
  const isSel = selected === f;
  f.layer.setStyle(strokeOpts(strokes[0] || { color: "#444", weight: 4 }, isSel));
  f.overlays.forEach((o) => overlayGroup.removeLayer(o));
  f.overlays = strokes.slice(1).map((s) => {
    const o = L.polyline(f.layer.getLatLngs(), {
      ...strokeOpts(s, isSel), interactive: false, pmIgnore: true });
    overlayGroup.addLayer(o);
    return o;
  });
  if (isSel) { f.layer.bringToFront(); f.overlays.forEach((o) => o.bringToFront()); }
  syncMarkers(f);
}
function restyleAll() { features.forEach(restyle); }
/* Overlays share the editable layer's geometry; anything that reshapes the
   line has to bring them along. */
function syncOverlays(f) {
  if (!f.layer) return;
  const ll = f.layer.getLatLngs();
  f.overlays.forEach((o) => o.setLatLngs(ll));
}
function pointIcon(t) {
  return L.divIcon({ className: "spot-glyph", iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<div style="color:${pointColor(t)}">${treatmentGlyph(t.type)}</div>` });
}
function syncMarkers(f) {
  const t = f.treatments[Math.min(f.sel, f.treatments.length - 1)] || f.treatments[0];
  if (t) f.markers.forEach((m) => m.setIcon(pointIcon(t)));
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
              markers: [], arrows: null };
  if (lines && lines.length) {
    f.layer = L.polyline(lines.length === 1 ? lines[0] : lines,
                         { color: "#444", weight: 4 });
    f.layer.on("click", () => {
      if (combineFrom) { if (f !== combineFrom) combineInto(combineFrom, f); return; }
      if (!editMode) selectFeature(f);
    });
    f.layer.on("pm:edit", () => {
      markDirty(); syncOverlays(f); updateArrows(f);
      if (selected === f) updateLenField(f);
      recomputeTotals();
    });
    f.layer.addTo(networkGroup);
  }
  for (const pt of points || []) {
    const m = L.marker(pt, { icon: pointIcon(treatments[0] || defaultTreatment()),
                             draggable: true, pmIgnore: true, keyboard: false });
    m.on("click", () => { if (!editMode) selectFeature(f); });
    m.on("dragend", () => markDirty());
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
  markDirty(); recomputeTotals(); renderLegend();
}
function clearFeatures() {
  deselect();
  features.forEach((f) => {
    if (f.layer) networkGroup.removeLayer(f.layer);
    f.overlays.forEach((o) => overlayGroup.removeLayer(o));
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
  const prev = selected; selected = f;
  if (prev && prev !== f) restyle(prev);
  restyle(f);
  fillForm(f);
  if (isMobile() && !document.querySelector(".sidebar").classList.contains("open")) {
    document.getElementById("peek-name").textContent = f.props.name || "(unnamed)";
    document.getElementById("peek").classList.add("show");
  }
}
function deselect() {
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
    b.textContent = treatmentLabel(t.type);
    b.title = `${t.status.replace(/_/g, " ")}`;
    b.addEventListener("click", () => { f.sel = i; fillForm(f); restyle(f); });
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
  opt(document.getElementById("f-type"),
      (options.treatments || []).map((x) => x.id), t.type, treatmentLabel);
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
  const isLine = Boolean(f.layer);
  document.getElementById("line-only-fields").style.display = isLine ? "" : "none";
  document.getElementById("btn-reverse").style.display =
    (isLine && t.travel === "one_way") ? "" : "none";
  document.getElementById("btn-snap-sel").style.display = isLine ? "" : "none";
  document.getElementById("btn-combine").style.display = isLine ? "" : "none";

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
    f.markers.forEach((m) => {
      if (show && !pointsGroup.hasLayer(m)) pointsGroup.addLayer(m);
      if (!show && pointsGroup.hasLayer(m)) pointsGroup.removeLayer(m);
    });
    if (!show && selected === f) deselect();
  });
  syncArrows(shownSet);
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
  try { entries = await store.layersManifest(); } catch (e) { return; }
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
function markDirty() {
  dirty = true; setStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, AUTOSAVE_MS);
}
function setStatus(msg) {
  const el = document.getElementById("status");
  if (msg) { el.innerHTML = msg; return; }
  el.innerHTML = dirty ? '<span class="dirty">Saving…</span>' : "All changes saved";
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
    { colorMode, renderPng: withPng ? renderPng : null, contextLayers: chosen });
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
    const art = await makeArtifacts(true);
    showExportNotes(art.summary);
    const entries = [
      { name: "network.yaml", data: await store.exportYamlText() },
      { name: "map.png", data: new Uint8Array(await art.pngBlob.arrayBuffer()) },
      { name: "map.html", data: art.html },
      { name: "network.geojson", data: JSON.stringify(art.geojson, null, 2) },
    ];
    const net = await store.loadNetwork();
    const phaseFiles = await buildPhaseArtifacts(
      net, await store.boundaryRings(), await store.boundary(),
      { colorMode, renderPng, features: art.features,
        onProgress: (msg) => setStatus(msg) });
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
async function importYamlFile(file) {
  setStatus("Importing…");
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

/* Wholesale replacement — the empty-map case, and what "use theirs everywhere"
   collapses to once it has been confirmed. */
function replaceWith(j, notes) {
  clearFeatures();
  config = { ...config, ...j.config };
  loadFeatureCollection(j.network);
  afterImport(j, notes);
}
function afterImport(j, notes) {
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
  document.getElementById("import-title").textContent =
    `This file covers ${decided} area${decided === 1 ? "" : "s"}.`;
  renderImportAreas();
  renderImportSeam();
  renderImportFeatures();
  renderImportPhases();
  document.getElementById("import-sheet").hidden = false;
  setStatus();
}
function closeImportSheet() {
  document.getElementById("import-sheet").hidden = true;
  importState = null;
}
function renderImportAreas() {
  const box = document.getElementById("import-areas");
  box.innerHTML = "";
  for (const a of importState.plan.areas) {
    const row = document.createElement("div");
    row.className = "area-row" + (a.untouched ? " untouched" : "");
    const key = String(a.id);
    const counts = a.untouched
      ? `not in this file — your ${a.mineCount} `
        + `${a.mineCount === 1 ? "feature is" : "features are"} untouched`
      : `${a.theirsCount} in the file · you have `
        + `${a.mineCount === 0 ? "none" : a.mineCount}`;
    row.innerHTML = `<span class="area-name">${a.name}</span>`
      + `<span class="area-counts">${counts}</span>`;
    if (!a.untouched) {
      const choice = document.createElement("span");
      choice.className = "area-choice";
      for (const [value, label] of [["theirs", a.isNew ? "Add theirs" : "Use theirs"],
                                    ["mine", "Keep mine"]]) {
        if (a.isNew && value === "mine") continue;   // nothing of mine to keep
        const l = document.createElement("label");
        const r = document.createElement("input");
        r.type = "radio"; r.name = `area-${key}`; r.value = value;
        r.checked = importState.areaChoices[key] === value;
        r.addEventListener("change", () => {
          importState.areaChoices[key] = value;
          renderImportFeatures();
        });
        l.appendChild(r);
        l.appendChild(document.createTextNode(label));
        choice.appendChild(l);
      }
      if (a.isNew) {
        const l = document.createElement("label");
        const r = document.createElement("input");
        r.type = "checkbox"; r.checked = importState.areaChoices[key] === "theirs";
        r.addEventListener("change", () => {
          importState.areaChoices[key] = r.checked ? "theirs" : "mine";
          renderImportFeatures();
        });
        choice.innerHTML = "";
        l.appendChild(r); l.appendChild(document.createTextNode("Add theirs"));
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
  const { plan, theirs, areaChoices, featureChoices } = importState;
  const incoming = theirs.features.filter(
    (f) => areaChoices[String(plan.theirsBy.get(f.id))] === "theirs");
  if (!incoming.length) {
    box.innerHTML = '<p class="hint">Nothing is coming in right now.</p>';
    return;
  }
  for (const f of incoming) {
    const l = document.createElement("label");
    l.className = "feature-pick";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !featureChoices || featureChoices[f.id] !== false;
    cb.addEventListener("change", () => {
      if (!importState.featureChoices) importState.featureChoices = {};
      importState.featureChoices[f.id] = cb.checked;
    });
    l.appendChild(cb);
    l.appendChild(document.createTextNode(" " + (f.name || "(unnamed)")));
    box.appendChild(l);
  }
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
function doImport() {
  const { theirs, mine, plan, areaChoices, phaseMapping, featureChoices }
    = importState;
  const merged = applyMerge(mine, theirs,
    { areaChoices, phaseMapping, featureChoices });
  const notes = describeMerge(plan, areaChoices);
  const j = importState.j;
  closeImportSheet();

  clearFeatures();
  config = { ...config,
             areas: merged.areas, authorities: merged.authorities,
             phases: merged.phases };
  loadFeatureCollection(featuresToGeojson(merged.features));
  afterImport(j, notes);
}

/* ---------- snap to roads ---------- */
let graphLoadFailed = false;
async function snapPoints(pts) {
  // pts: [[lat,lng],...]; returns road-following [[lat,lng],...] or null.
  try {
    if (!store._graph && !graphLoadFailed) {
      setStatus("Loading street data… (first time only)");
    }
    const graph = await store.streetGraph();
    // No street graph shipped for this deployment: snapping is simply
    // unavailable, and a click behaves exactly like an off-street click.
    if (!graph) { graphLoadFailed = true; return null; }
    let route = snapRoute(pts, graph.adj, graph.coord);
    clipBoundary = clipBoundary || await store.boundary();
    // A snapped preview wants ONE continuous line, so take the longest
    // in-boundary run rather than every piece — joining pieces across a gap
    // would draw a road that isn't there. Measurement still clips properly.
    const [pieces] = clipPolylineLatlon(route, clipBoundary);
    const clipped = longestPiece(pieces);
    if (clipped.length >= 2) route = clipped;
    return route.length >= 2 ? route : null;
  } catch (e) { graphLoadFailed = true; console.error(e); return null; }
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
let drawDefaults = null, placingPoint = false;
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
function startPlacePoint() {
  if (phaseView !== "all") setPhaseView("all");
  deselect();
  placingPoint = true;
  setStatus("Click the map where the improvement goes — Esc cancels.");
}
function undoDrawVertex() {
  const d = map.pm.Draw && map.pm.Draw.Line;
  if (d && d._enabled && typeof d._removeLastVertex === "function") {
    d._removeLastVertex();
    return true;
  }
  return false;
}
function toggleEdit() {
  editMode = !editMode;
  document.getElementById("btn-edit").classList.toggle("toggled", editMode);
  if (editMode) {
    map.pm.enableGlobalEditMode(); deselect();
    setStatus("Edit mode: drag the dots to reshape lines.");
  } else { map.pm.disableGlobalEditMode(); setStatus(); }
}

/* ---------- init ---------- */
async function init() {
  // The opening view comes from the deployment's place, never from a constant.
  // A place with no centre falls through to fitBounds() below, which frames
  // the network or the boundary — guessing a centre would drop the user
  // somewhere plausible-looking and wrong.
  place = await store.place();
  map = L.map("map", { zoomControl: true });
  if (place.mapCenter) map.setView(place.mapCenter, place.mapZoom);
  else map.setView([0, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { attribution: "© OpenStreetMap, © CARTO", maxZoom: 20 }).addTo(map);
  networkGroup = L.featureGroup().addTo(map);
  overlayGroup = L.layerGroup().addTo(map);
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
    config.areas = [{ id: place.id || newId("a-"), name: place.name,
                      kind: place.kind, context: place.context,
                      default_authority: place.defaultAuthority }];
  }
  if (!config.authorities.length) config.authorities = place.authorities || [];

  // An area with no boundary is not self-describing, and area assignment on
  // import has nothing to work with — every feature would land in "somewhere
  // else". A file upgraded from v1 has exactly that problem, because v1 kept
  // the boundary outside the file. Adopt the deployment's boundary once, and
  // autosave writes it into the network so the file carries its own outline
  // from then on (V2_PLAN.md D1).
  const deploymentBoundary = await store.boundary();
  if (deploymentBoundary.length && config.areas.length
      && !(config.areas[0].boundary || []).length) {
    config.areas[0] = { ...config.areas[0], boundary: deploymentBoundary };
    markDirty();
  }

  (data.boundary || []).forEach((ring) => {
    L.polyline(ring, { color: BOUNDARY, weight: 1.5, dashArray: "7,6",
                       opacity: 0.8, interactive: false, pmIgnore: true })
      .addTo(boundaryGroup);
  });

  loadFeatureCollection(data.network);

  if (networkGroup.getLayers().length) {
    map.fitBounds(networkGroup.getBounds().pad(0.05));
  } else if (boundaryGroup.getLayers().length) {
    map.fitBounds(boundaryGroup.getBounds());
  }
  map.on("zoomend", () => { syncArrowVisibility(); restyleAll(); });
  syncArrowVisibility();

  map.on("pm:create", async (e) => {
    const drawn = segsOf(e.layer)[0].map((p) => [p.lat, p.lng]);
    map.removeLayer(e.layer); map.pm.disableDraw();
    let geom = drawn;
    if (document.getElementById("snap").checked) {
      setStatus("Snapping to roads…");
      geom = await snapPoints(drawn) || drawn;
    }
    const f = addFeature(defaultProps(), [defaultTreatment(drawDefaults)],
                         [geom.map((c) => L.latLng(c[0], c[1]))], []);
    selectFeature(f); markDirty(); recomputeTotals(); setStatus();
  });
  map.on("click", (e) => {
    if (!placingPoint) return;
    placingPoint = false;
    const f = addFeature(defaultProps({ name: "New spot" }),
                         [defaultTreatment({ type: "speed_hump" })], [], [e.latlng]);
    selectFeature(f); markDirty(); recomputeTotals(); setStatus();
  });

  bindForm(); bindImportSheet(); renderPhases(); renderLegend(); recomputeTotals(); setStatus();
  applyPhaseView();   // a fresh load must already honour upgrades
  initContextLayers();

  document.getElementById("btn-add").onclick = () => startDraw({ status: "proposed" });
  document.getElementById("btn-add-existing").onclick = () => startDraw(
    { status: "existing", type: "shared_use_path", phase: null });
  document.getElementById("btn-add-spot").onclick = startPlacePoint;
  document.getElementById("btn-edit").onclick = toggleEdit;
  document.getElementById("btn-add-phase").onclick = addPhase;
  document.getElementById("btn-snap-sel").onclick = snapSelected;
  document.getElementById("btn-reverse").onclick = reverseSelected;
  document.getElementById("btn-combine").onclick = startCombine;
  document.getElementById("unnamed-warn").onclick = selectNextUnnamed;
  document.getElementById("group-by").addEventListener("change", recomputeTotals);
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
    if (e.key === "Escape" && placingPoint) { placingPoint = false; setStatus(); }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!typing && (e.key === "Backspace" || e.key === "Delete"
                    || (e.ctrlKey && e.key.toLowerCase() === "z"))) {
      if (undoDrawVertex()) e.preventDefault();
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
  document.getElementById("color-mode").addEventListener("change", (e) => {
    colorMode = e.target.value; restyleAll(); renderLegend();
    // Phases are front-and-center only when the map is coloured by them.
    phasesBox.open = (colorMode === "phase");
  });

  const exportBtn = document.getElementById("btn-export");
  const exportMenu = document.getElementById("export-menu");
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener("click", () => { exportMenu.hidden = true; });
  exportMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation(); exportMenu.hidden = true;
      const kind = b.dataset.export;
      if (kind === "yaml") exportYaml();
      else if (kind === "bundle") exportBundle();
      else exportOutput(kind);
    });
  });

  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files.length) importYamlFile(e.target.files[0]);
    e.target.value = "";
  });
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
