// Clip + summarize — port of bikenetwork/pipeline.py (minus file output: the
// web app renders exports in the browser; see export.js).
import { clipSegmentsLatlon } from "./boundary.js";
import { segmentsMiles } from "./geometry.js";
import { phaseMap } from "./network_format.js";

// Return copies of `paths` clipped to the city ring. Records warnings for
// proposed paths that fall entirely outside (they're dropped), notices for
// those trimmed at the line.
export function clipPaths(paths, ring, warnings, notices) {
  const borderFlagged = new Set(notices.map((n) => n.split(":", 1)[0]));
  const out = [];
  for (const p of paths) {
    if (!p.segments.some((s) => s.length >= 2)) continue;
    const fullMiles = p.length_miles || segmentsMiles(p.segments);
    const [clipped, miles] = clipSegmentsLatlon(p.segments, ring);
    if (!clipped.length) {
      if (p.status === "proposed") {
        warnings.push(`${p.name}: lies entirely outside the city boundary; dropped.`);
      }
      continue;
    }
    const q = { ...p, segments: clipped, length_miles: miles };
    const trimmed = fullMiles - miles;
    if (p.status === "proposed" && trimmed > 0.05 && !borderFlagged.has(p.name)) {
      notices.push(`${p.name}: clipped to the city line `
        + `(kept ${miles.toFixed(2)} mi in the city, trimmed ${trimmed.toFixed(2)} mi).`);
    }
    out.push(q);
  }
  return out;
}

// Mileage rollups (cost is computed live in the UI from costs.js rates).
export function summarize(paths, net) {
  const proposed = paths.filter((p) => p.status === "proposed");
  const build = proposed.filter((p) => p.jurisdiction !== "state");
  const state = proposed.filter((p) => p.jurisdiction === "state");
  const phases = [];
  const cfgMap = phaseMap(net);
  const nums = [...new Set(build.filter((p) => p.phase !== null && p.phase !== undefined)
    .map((p) => p.phase))].sort((a, b) => a - b);
  for (const num of nums) {
    const members = build.filter((p) => p.phase === num);
    const cfg = cfgMap.get(num);
    phases.push({
      phase: num,
      label: cfg ? cfg.label : `Phase ${num}`,
      deadline: cfg ? cfg.deadline : "",
      miles: members.reduce((s, p) => s + p.length_miles, 0),
      lane_miles: members.reduce((s, p) => s + p.length_miles * p.directions, 0),
    });
  }
  return {
    total_build_miles: build.reduce((s, p) => s + p.length_miles, 0),
    total_lane_miles: build.reduce((s, p) => s + p.length_miles * p.directions, 0),
    total_paths: build.length,
    state_miles: state.reduce((s, p) => s + p.length_miles, 0),
    committed_miles: paths.filter((p) => p.status === "funded")
      .reduce((s, p) => s + p.length_miles, 0),
    existing_miles: paths.filter((p) => p.status === "existing")
      .reduce((s, p) => s + p.length_miles, 0),
    phases,
  };
}
