// Clip + summarize — port of bikenetwork/pipeline.py (minus file output: the
// web app renders exports in the browser; see export.js).
import { clipSegmentsLatlon, pointInRing } from "./boundary.js";
import { segmentsMiles } from "./geometry.js";
import { phaseMap, supersededIds } from "./network_format.js";

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

// Spots inside the city ring (out-of-city ones silently drop).
export function clipSpots(spots, ring) {
  return (spots || []).filter(
    (s) => s.location && pointInRing(s.location[0], s.location[1], ring));
}

// The cumulative network as of phase `n` (0 = today): existing + funded plus
// proposed paths with phase <= n, minus any path superseded by an upgrade
// that is itself in the view.
export function pathsAsOfPhase(paths, n) {
  const shown = paths.filter(
    (p) => p.status !== "proposed"
      || (p.phase !== null && p.phase !== undefined && p.phase <= n));
  const superseded = supersededIds(shown);
  return shown.filter((p) => !superseded.has(p.id));
}

// Spots visible as of phase `n` (0 = today): existing always; proposed once
// their phase arrives — a proposed spot with no phase shows in every phased
// view (it's part of the plan, just not scheduled).
export function spotsAsOfPhase(spots, n) {
  return (spots || []).filter(
    (s) => s.status !== "proposed"
      || (n > 0 && (s.phase === null || s.phase === undefined || s.phase <= n)));
}

// Mileage rollups (cost is computed live in the UI from costs.js rates).
export function summarize(paths, net) {
  const proposed = paths.filter((p) => p.status === "proposed");
  const build = proposed.filter((p) => p.jurisdiction !== "state");
  const state = proposed.filter((p) => p.jurisdiction === "state");
  // An upgraded corridor (quick-build now, rebuild later) counts once at
  // full buildout; the per-phase rows below still show every phase's work.
  const superseded = supersededIds(paths);
  const finalBuild = build.filter((p) => !superseded.has(p.id));
  const finalState = state.filter((p) => !superseded.has(p.id));
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
    total_build_miles: finalBuild.reduce((s, p) => s + p.length_miles, 0),
    total_lane_miles: finalBuild.reduce((s, p) => s + p.length_miles * p.directions, 0),
    total_paths: finalBuild.length,
    state_miles: finalState.reduce((s, p) => s + p.length_miles, 0),
    committed_miles: paths.filter((p) => p.status === "funded")
      .reduce((s, p) => s + p.length_miles, 0),
    existing_miles: paths.filter((p) => p.status === "existing")
      .reduce((s, p) => s + p.length_miles, 0),
    phases,
  };
}
