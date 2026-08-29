// Planning-grade cost estimates, and the metric/imperial display split.
//
// v2 stores METRIC. Imperial is a display preference, so every rate lives in
// the treatment registry as $/km and is converted at the presentation layer.
// The registry's figures are exact conversions of the published per-mile ones,
// so imperial display still reads $150K–$500K rather than $149K–$501K.
//
// Three tiers of cost adjustment, and the UI only ever shows the first by
// default (V2_PLAN.md §4.2 `costs:`):
//
//   1. nothing            — the registry's built-in ranges
//   2. a per-area multiplier — one number, behind "Advanced"
//   3. per-area, per-type overrides — file-editable, surfaced read-only
//
// If a file carries ANY override, every export says so. These numbers end up
// on a slide in front of a city council, and a footnote is the difference
// between a planning estimate and a misleading one.
import { KM_PER_MILE, registry } from "./registry.js";

export const KM_PER_MI = KM_PER_MILE;
export const MI_PER_KM = 1 / KM_PER_MILE;

export const kmToMiles = (km) => km * MI_PER_KM;
export const milesToKm = (mi) => mi * KM_PER_MILE;

// Distance in the user's chosen display unit, from stored kilometres.
export function displayDistance(km, units = "imperial") {
  return units === "metric" ? km : kmToMiles(km);
}

export function distanceLabel(units = "imperial", { lane = false } = {}) {
  if (units === "metric") return lane ? "lane-km" : "corridor-km";
  return lane ? "lane-mi" : "corridor-mi";
}

// The [low, high] $/km for a treatment in an area, after any file overrides.
// null means "not costed" — which is not the same as free, and the UI must
// show nothing rather than a zero.
export function ratePerKm(treatmentType, { costs = {}, areaId = "", reg } = {}) {
  const r = reg || registry();
  const byArea = (costs.by_area || {})[areaId] || {};

  const override = (byArea.per_km || {})[treatmentType]
    || (costs.per_km || {})[treatmentType];
  const base = override || r.get(treatmentType).costPerKm;
  if (!base) return null;

  const multiplier = Number.isFinite(Number(byArea.multiplier))
    ? Number(byArea.multiplier) : 1;
  return [base[0] * multiplier, base[1] * multiplier];
}

export function ratePerUnit(treatmentType, { costs = {}, areaId = "", reg } = {}) {
  const r = reg || registry();
  const byArea = (costs.by_area || {})[areaId] || {};
  const override = (byArea.per_unit || {})[treatmentType]
    || (costs.per_unit || {})[treatmentType];
  const base = override || r.get(treatmentType).costPerUnit;
  if (!base) return null;
  const multiplier = Number.isFinite(Number(byArea.multiplier))
    ? Number(byArea.multiplier) : 1;
  return [base[0] * multiplier, base[1] * multiplier];
}

// True when the file adjusts costs at all — exports must say so.
export function hasCostOverrides(costs = {}) {
  if (Object.keys(costs.per_km || {}).length) return true;
  if (Object.keys(costs.per_unit || {}).length) return true;
  for (const area of Object.values(costs.by_area || {})) {
    if (Number.isFinite(Number(area.multiplier)) && Number(area.multiplier) !== 1) {
      return true;
    }
    if (Object.keys(area.per_km || {}).length) return true;
    if (Object.keys(area.per_unit || {}).length) return true;
  }
  return false;
}

export const COST_DISCLAIMER =
  "Cost figures adjusted by the author from the tool's default ranges.";

export const currencyOf = (costs = {}) => costs.currency || "USD";
