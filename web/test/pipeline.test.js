// Tests for clipping + summarizing — mirrors tests/test_pipeline.py (minus the
// render_all file outputs, which in the web port are exercised as exports).
import test from "node:test";
import assert from "node:assert/strict";
import {
  clipPaths, clipSpots, pathsAsOfPhase, spotsAsOfPhase, summarize,
} from "../js/pipeline.js";
import {
  makeNetwork, makePath, makePhase, makeSpot,
} from "../js/network_format.js";

const approx = (got, want, abs = 1e-6) =>
  assert.ok(Math.abs(got - want) <= abs, `${got} !~ ${want}`);

const BOUNDARY_RING = [[42.40, -71.09], [42.45, -71.09], [42.45, -71.02],
                       [42.40, -71.02], [42.40, -71.09]];

function p(name, phase = 1, { status = "proposed", geometry = null, ...kw } = {}) {
  return makePath({
    name, on_street: name, phase, status, type: "quick_build_separated",
    segments: [geometry || [[42.42, -71.07], [42.43, -71.06]]], ...kw,
  });
}

function net(paths) {
  return makeNetwork({
    city: "Malden",
    phases: [makePhase(1, "Core", "2029"), makePhase(2, "More", "2032")],
    paths,
  });
}

test("clip drops outside and trims crossing", () => {
  const inside = p("In");
  const outside = p("Out", 1, { geometry: [[42.50, -71.07], [42.52, -71.06]] });
  const crossing = p("Cross", 1, { geometry: [[42.42, -71.05], [42.48, -71.05]] });
  const warnings = [], notices = [];
  const out = clipPaths([inside, outside, crossing], BOUNDARY_RING, warnings, notices);
  const names = out.map(x => x.name);
  assert.ok(names.includes("In"));
  assert.ok(!names.includes("Out"));
  assert.ok(names.includes("Cross"));
  assert.ok(warnings.some(w => w.includes("Out")));
  const clipped = out.find(x => x.name === "Cross");
  const maxLat = Math.max(...clipped.segments.flat().map(([lat]) => lat));
  assert.ok(maxLat <= 42.45 + 1e-6);
  assert.ok(notices.some(n => n.includes("Cross")));
});

test("clip handles duplicate names independently", () => {
  const a = p("New corridor", 1, { geometry: [[42.41, -71.07], [42.42, -71.06]] });
  const b = p("New corridor", 1, { geometry: [[42.43, -71.05], [42.44, -71.04]] });
  const out = clipPaths([a, b], BOUNDARY_RING, [], []);
  assert.equal(out.length, 2);
  assert.notDeepEqual(out[0].segments, out[1].segments);
});

test("clip does not mutate the source paths", () => {
  const crossing = p("Cross", 1, { geometry: [[42.42, -71.05], [42.48, -71.05]] });
  clipPaths([crossing], BOUNDARY_RING, [], []);
  assert.deepEqual(crossing.segments, [[[42.42, -71.05], [42.48, -71.05]]]);
});

test("summarize buckets statuses and state", () => {
  const paths = [
    p("A", 1), p("B", 2),
    p("State Rd", 1, { jurisdiction: "state" }),
    p("Trail", null, { status: "existing" }),
    p("Greenway", null, { status: "funded" }),
  ];
  for (const x of paths) x.length_miles = 1.0;
  const s = summarize(paths, net(paths));
  approx(s.total_build_miles, 2.0);
  approx(s.total_lane_miles, 4.0);
  approx(s.state_miles, 1.0);
  approx(s.existing_miles, 1.0);
  approx(s.committed_miles, 1.0);
  assert.deepEqual(s.phases.map(ph => ph.phase), [1, 2]);
  assert.equal(s.phases[0].label, "Core");
});

test("summarize counts an upgraded corridor once but keeps both phases", () => {
  // Quick-build in phase 1, full rebuild of the same corridor in phase 2: the
  // corridor counts ONCE at full buildout, but each phase still shows its own
  // work (you pay to build twice).
  const a = p("Main quick-build", 1, { id: "a" });
  const b = p("Main rebuild", 2, { upgrades: "a" });
  a.length_miles = 1.0;
  b.length_miles = 1.0;
  const s = summarize([a, b], net([a, b]));
  approx(s.total_build_miles, 1.0);
  approx(s.total_lane_miles, 2.0);
  assert.equal(s.total_paths, 1);
  assert.deepEqual(s.phases.map((ph) => ph.miles), [1.0, 1.0]);
});

test("pathsAsOfPhase is cumulative and hides superseded paths", () => {
  const a = p("Quick", 1, { id: "a" });
  const b = p("Rebuild", 2, { upgrades: "a" });
  const e = p("Trail", null, { status: "existing" });
  const names = (n) => pathsAsOfPhase([a, b, e], n).map((x) => x.name);
  assert.deepEqual(names(0), ["Trail"]);
  assert.deepEqual(names(1), ["Quick", "Trail"]);
  // Once the rebuild's phase arrives it replaces the quick-build.
  assert.deepEqual(names(2), ["Rebuild", "Trail"]);
});

test("spotsAsOfPhase shows existing always and proposed on schedule", () => {
  const built = makeSpot({ kind: "bike_parking", status: "existing",
                           location: [42.42, -71.06] });
  const later = makeSpot({ kind: "speed_hump", status: "proposed", phase: 2,
                           location: [42.42, -71.06] });
  const anytime = makeSpot({ kind: "raised_crosswalk", status: "proposed",
                             location: [42.42, -71.06] });
  const spots = [built, later, anytime];
  assert.deepEqual(spotsAsOfPhase(spots, 0), [built]);
  assert.deepEqual(spotsAsOfPhase(spots, 1), [built, anytime]);
  assert.deepEqual(spotsAsOfPhase(spots, 2), spots);
});

test("clipSpots drops spots outside the city", () => {
  const inside = makeSpot({ kind: "speed_hump", location: [42.42, -71.06] });
  const outside = makeSpot({ kind: "speed_hump", location: [42.60, -71.06] });
  assert.deepEqual(clipSpots([inside, outside], BOUNDARY_RING), [inside]);
});
