// Clip + summarize the v2 network. Port of the shared half of
// bikenetwork/pipeline.py; file output lives in export.js.
//
// The arithmetic rules that matter, and why:
//
//  * Only BIKE-category treatments count toward lane distance. The moment a
//    bus lane or a row of trees can sit on the same corridor, the headline
//    number inflates unless the registry's category gates it.
//  * An upgraded corridor counts ONCE at full buildout (the final facility),
//    but per-phase rows and cost include EVERY phase's work — building in 2028
//    and rebuilding in 2040 is two projects.
//  * Distances are stored and computed in KILOMETRES; imperial is a display
//    preference applied at the presentation layer.
//  * An unknown treatment type contributes nothing and is reported, rather
//    than failing or being silently counted as something it isn't.
import { clipSegmentsLatlon, pointInBoundary } from "./boundary.js";
import { polylineMiles } from "./geometry.js";
import { KM_PER_MILE, registry } from "./registry.js";
import { supersededIds } from "./network_format.js";
import { ratePerKm, ratePerUnit } from "./costs.js";

export const partsKm = (parts) => (parts || [])
  .filter((p) => p.length >= 2)
  .reduce((sum, p) => sum + polylineMiles(p) * KM_PER_MILE, 0);

const CONTEXT = new Set(["existing", "under_construction", "funded"]);

// Clip features to the boundary (a multipolygon; see boundary.js). Line parts
// keep every in-boundary piece; point parts survive only if they're inside.
// Warnings for proposed features that fall entirely outside (they're dropped),
// notices for those trimmed at the line.
export function clipFeatures(features, boundary, warnings = [], notices = []) {
  const borderFlagged = new Set(notices.map((n) => n.split(":", 1)[0]));
  const out = [];
  for (const f of features) {
    const lines = f.lines();
    const points = f.points();
    if (!lines.length && !points.length) continue;

    const fullKm = partsKm(lines);
    const [clippedLines, clippedMiles] = lines.length
      ? clipSegmentsLatlon(lines, boundary) : [[], 0];
    const keptPoints = points.filter(
      (pt) => pointInBoundary(pt[0], pt[1], boundary));
    const km = clippedMiles * KM_PER_MILE;

    if (!clippedLines.length && !keptPoints.length) {
      if (f.treatments.some((t) => t.status === "proposed")) {
        warnings.push(`${f.name}: lies entirely outside the area boundary; dropped.`);
      }
      continue;
    }
    const geometry = [...clippedLines, ...keptPoints.map((pt) => [pt])];
    const q = { ...f, geometry, length_km: km,
                points: f.points, lines: f.lines,
                get geometryKind() {
                  const hasPt = this.points().length > 0;
                  const hasLine = this.lines().length > 0;
                  if (hasPt && hasLine) return "mixed";
                  if (hasPt) return "point";
                  return hasLine ? "line" : "empty";
                } };
    const trimmedKm = fullKm - km;
    if (f.treatments.some((t) => t.status === "proposed")
        && trimmedKm > 0.08 && !borderFlagged.has(f.name)) {
      notices.push(`${f.name}: clipped to the area line `
        + `(kept ${km.toFixed(2)} km inside, trimmed ${trimmedKm.toFixed(2)} km).`);
    }
    out.push(q);
  }
  return out;
}

// Which phase numbers a set of phases resolves ids to.
const phaseNumber = (net, phaseId) => {
  const p = net.phaseMap().get(phaseId);
  return p ? p.number : null;
};

// The cumulative network as of phase number `n` (0 = today): context
// treatments always, proposed ones once their phase arrives, minus anything
// superseded by an upgrade that is itself in the view.
export function treatmentsAsOfPhase(net, n) {
  const shown = [];
  for (const [f, t] of net.allTreatments()) {
    if (CONTEXT.has(t.status)) { shown.push([f, t]); continue; }
    const num = phaseNumber(net, t.phase);
    // A proposed treatment with no phase is part of the plan but unscheduled;
    // it shows in every phased view rather than in none.
    if (n > 0 && (num === null || num <= n)) shown.push([f, t]);
  }
  const shownIds = new Set(shown.map(([, t]) => t.id));
  const superseded = new Set();
  for (const [, t] of shown) {
    for (const u of t.upgrades) if (shownIds.has(u)) superseded.add(u);
  }
  return shown.filter(([, t]) => !superseded.has(t.id));
}

// Features as of a phase, carrying only the treatments visible then. A feature
// whose treatments are all hidden disappears with them.
export function featuresAsOfPhase(net, n) {
  const byFeature = new Map();
  for (const [f, t] of treatmentsAsOfPhase(net, n)) {
    if (!byFeature.has(f.id)) byFeature.set(f.id, { ...f, treatments: [],
                                                    points: f.points,
                                                    lines: f.lines });
    byFeature.get(f.id).treatments.push(t);
  }
  return net.features.filter((f) => byFeature.has(f.id))
    .map((f) => byFeature.get(f.id));
}

// Mileage/cost rollups. `units` only affects the labels a caller renders; the
// numbers here are always kilometres.
export function summarize(features, net, { reg, units = "imperial" } = {}) {
  const r = reg || registry();
  const areaId = net.areas.length ? net.areas[0].id : "";
  const costs = net.costs || {};

  // Pair every treatment with the length of the feature it sits on.
  const rows = [];
  for (const f of features) {
    const km = f.length_km || partsKm(f.lines());
    for (const t of f.treatments) rows.push({ f, t, km, spec: r.get(t.type) });
  }

  const superseded = supersededIds({ ...net, features,
                                     allTreatments: () => rows.map((x) => [x.f, x.t]) });
  const proposed = rows.filter((x) => x.t.status === "proposed");
  const counted = proposed.filter((x) => !superseded.has(x.t.id));

  const byAuthority = new Map();
  const byArea = new Map();
  const quantities = new Map();
  let buildKm = 0, laneKm = 0, buildCount = 0;
  let costLow = 0, costHigh = 0;

  for (const x of counted) {
    if (!x.spec.isBike) continue;             // a bus lane must not inflate this
    buildKm += x.km;
    laneKm += x.km * (x.t.sides || 2);
    buildCount += 1;
    const key = x.t.authority || "";
    byAuthority.set(key, (byAuthority.get(key) || 0) + x.km);
  }
  byArea.set(areaId, buildKm);

  // Cost includes EVERY phase's work, superseded or not — building twice
  // costs twice.
  for (const x of proposed) {
    const perKm = ratePerKm(x.t.type, { costs, areaId, reg: r });
    if (perKm && x.km) { costLow += x.km * perKm[0]; costHigh += x.km * perKm[1]; }
    const perUnit = ratePerUnit(x.t.type, { costs, areaId, reg: r });
    if (perUnit && x.t.quantity) {
      costLow += x.t.quantity * perUnit[0];
      costHigh += x.t.quantity * perUnit[1];
    }
    if (x.spec.measure === "counted" && x.t.quantity) {
      const k = `${x.spec.id}`;
      const prev = quantities.get(k) || { unit: x.spec.unit, label: x.spec.label, n: 0 };
      prev.n += x.t.quantity;
      quantities.set(k, prev);
    }
  }

  const phases = [];
  for (const p of [...net.phases].sort((a, b) => a.number - b.number)) {
    const members = proposed.filter((x) => x.t.phase === p.id && x.spec.isBike);
    if (!members.length) continue;
    phases.push({
      id: p.id, number: p.number, label: p.label || `Phase ${p.number}`,
      target_date: p.target_date,
      km: members.reduce((s, x) => s + x.km, 0),
      lane_km: members.reduce((s, x) => s + x.km * (x.t.sides || 2), 0),
    });
  }

  const contextKm = (status) => rows
    .filter((x) => x.t.status === status && x.spec.isBike)
    .reduce((s, x) => s + x.km, 0);

  return {
    units,
    total_build_km: buildKm,
    total_lane_km: laneKm,
    total_features: buildCount,
    existing_km: contextKm("existing"),
    under_construction_km: contextKm("under_construction"),
    funded_km: contextKm("funded"),
    by_authority: [...byAuthority.entries()]
      .map(([id, km]) => ({ id, name: net.authority(id).name, km }))
      .sort((a, b) => b.km - a.km),
    by_area: [...byArea.entries()].map(([id, km]) => ({
      id, name: (net.area(id) || {}).name || "", km })),
    quantities: [...quantities.values()].filter((q) => q.n > 0),
    cost_low: costLow,
    cost_high: costHigh,
    phases,
    unknown_types: net.unknownTreatmentTypes(r),
  };
}
