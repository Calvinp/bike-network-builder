// Clipping and rollups over v2 features and treatments.
//
// The arithmetic here is the tool's most public output, so the rules get
// pinned explicitly: only bike treatments count toward lane distance, an
// upgraded corridor counts once but costs twice, and an unknown treatment
// contributes nothing rather than being quietly counted as something else.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clipFeatures, featuresAsOfPhase, partsKm, summarize,
         treatmentsAsOfPhase } from "../js/pipeline.js";
import { makeFeature, makeNetwork, makePhase, makeTreatment }
  from "../js/network_format.js";
import { Registry, setRegistry } from "../js/registry.js";

setRegistry(JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8")));

// A big square area: lat 0..1, lon 0..1.
const SQUARE = [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]];

const feat = (f = {}) => makeFeature({
  id: "f1", name: "Main Street",
  treatments: [makeTreatment({ id: "t1", type: "quick_build_separated",
                               status: "proposed", phase: "p1",
                               authority: "local" })],
  geometry: [[[0.5, 0.2], [0.5, 0.4]]],
  ...f,
});

const net = (f = {}) => makeNetwork({
  areas: [{ id: "a1", name: "Testville", displayName: "Testville" }],
  authorities: [{ id: "local", name: "Town of Testville", level: "municipal" },
                { id: "statedot", name: "State DOT", level: "state" }],
  phases: [makePhase({ id: "p1", number: 1, label: "Core" }),
           makePhase({ id: "p2", number: 2, label: "Later" })],
  features: [feat()],
  ...f,
});

// --------------------------------------------------------------------------
// Clipping
// --------------------------------------------------------------------------
test("a feature fully inside keeps its geometry and gains a length", () => {
  const [out] = clipFeatures([feat()], SQUARE);
  assert.equal(out.lines().length, 1);
  assert.ok(out.length_km > 0);
});

test("a proposed feature entirely outside is dropped with a warning", () => {
  const warnings = [];
  const out = clipFeatures([feat({ geometry: [[[5, 5], [6, 6]]] })], SQUARE,
                           warnings);
  assert.equal(out.length, 0);
  assert.match(warnings[0], /entirely outside/);
});

test("a feature trimmed at the line gets a notice naming the kept length", () => {
  const notices = [];
  clipFeatures([feat({ geometry: [[[0.5, -0.5], [0.5, 0.5]]] })], SQUARE,
               [], notices);
  assert.match(notices[0], /clipped to the area line/);
  assert.match(notices[0], /km/);
});

test("point parts survive clipping only when they are inside", () => {
  const f = feat({ geometry: [[[0.5, 0.5]], [[9, 9]]] });
  const [out] = clipFeatures([f], SQUARE);
  assert.deepEqual(out.points(), [[0.5, 0.5]]);
});

test("a point feature outside the area is dropped, not kept at zero length", () => {
  const out = clipFeatures([feat({ geometry: [[[9, 9]]] })], SQUARE, []);
  assert.equal(out.length, 0);
});

// --------------------------------------------------------------------------
// Lane distance: category gating
// --------------------------------------------------------------------------
test("only bike treatments count toward lane distance", () => {
  // A bus lane and a row of trees on the same corridor must not inflate the
  // headline number.
  const f = feat({ treatments: [
    makeTreatment({ id: "t1", type: "quick_build_separated", status: "proposed",
                    phase: "p1", authority: "local" }),
    makeTreatment({ id: "t2", type: "street_trees", status: "proposed",
                    phase: "p1", authority: "local", quantity: 30 }),
  ] });
  const n = net({ features: [f] });
  const s = summarize(clipFeatures([f], SQUARE), n);
  assert.equal(s.total_features, 1);              // the bike treatment only
  assert.ok(s.total_build_km > 0);
});

test("an unknown treatment contributes nothing and is reported", () => {
  const f = feat({ treatments: [makeTreatment({
    id: "t1", type: "transit:bus_lane", status: "proposed", phase: "p1" })] });
  const n = net({ features: [f] });
  const s = summarize(clipFeatures([f], SQUARE), n);
  assert.equal(s.total_build_km, 0);
  assert.equal(s.total_lane_km, 0);
  assert.deepEqual(s.unknown_types, ["transit:bus_lane"]);
});

test("lane distance multiplies by sides, not by travel", () => {
  // A two-way track on ONE side is one facility: sides drives the total, and
  // travel only drives the map arrow. v1 could not express this at all.
  const oneSide = feat({ treatments: [makeTreatment({
    id: "t1", type: "shared_use_path", status: "proposed", phase: "p1",
    travel: "two_way", sides: 1 })] });
  const bothSides = feat({ treatments: [makeTreatment({
    id: "t1", type: "shared_use_path", status: "proposed", phase: "p1",
    travel: "two_way", sides: 2 })] });
  const a = summarize(clipFeatures([oneSide], SQUARE), net({ features: [oneSide] }));
  const b = summarize(clipFeatures([bothSides], SQUARE), net({ features: [bothSides] }));
  assert.ok(Math.abs(a.total_build_km - b.total_build_km) < 1e-9);
  assert.ok(Math.abs(b.total_lane_km - 2 * a.total_lane_km) < 1e-9);
});

// --------------------------------------------------------------------------
// Upgrades: counted once, costed twice
// --------------------------------------------------------------------------
test("an upgraded corridor counts once but costs every phase's work", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "qb", type: "quick_build_separated", status: "proposed",
                    phase: "p1", authority: "local" }),
    makeTreatment({ id: "cc", type: "concrete_separated", status: "proposed",
                    phase: "p2", authority: "local", upgrades: ["qb"] }),
  ] });
  const n = net({ features: [f] });
  const clipped = clipFeatures([f], SQUARE);
  const s = summarize(clipped, n);

  const single = feat({ treatments: [makeTreatment({
    id: "cc", type: "concrete_separated", status: "proposed", phase: "p2",
    authority: "local" })] });
  const s1 = summarize(clipFeatures([single], SQUARE), net({ features: [single] }));

  // Same corridor distance...
  assert.ok(Math.abs(s.total_build_km - s1.total_build_km) < 1e-9);
  // ...but more money, because it is built and then rebuilt.
  assert.ok(s.cost_low > s1.cost_low);
});

// --------------------------------------------------------------------------
// Phase views
// --------------------------------------------------------------------------
test("phase 0 shows context treatments only", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "e", type: "shared_use_path", status: "existing" }),
    makeTreatment({ id: "p", type: "quick_build_separated", status: "proposed",
                    phase: "p1" }),
  ] });
  const n = net({ features: [f] });
  assert.deepEqual(treatmentsAsOfPhase(n, 0).map(([, t]) => t.id), ["e"]);
  assert.deepEqual(treatmentsAsOfPhase(n, 1).map(([, t]) => t.id).sort(),
                   ["e", "p"]);
});

test("under_construction and funded read as context, not as the ask", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "u", type: "shared_use_path", status: "under_construction" }),
    makeTreatment({ id: "fu", type: "shared_use_path", status: "funded" }),
  ] });
  const n = net({ features: [f] });
  assert.equal(treatmentsAsOfPhase(n, 0).length, 2);
  const s = summarize(clipFeatures([f], SQUARE), n);
  assert.equal(s.total_build_km, 0);            // neither is an ask
  assert.ok(s.under_construction_km > 0 && s.funded_km > 0);
});

test("a superseded treatment hides once its replacement is in view", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "qb", type: "quick_build_separated", status: "proposed",
                    phase: "p1" }),
    makeTreatment({ id: "cc", type: "concrete_separated", status: "proposed",
                    phase: "p2", upgrades: ["qb"] }),
  ] });
  const n = net({ features: [f] });
  assert.deepEqual(treatmentsAsOfPhase(n, 1).map(([, t]) => t.id), ["qb"]);
  assert.deepEqual(treatmentsAsOfPhase(n, 2).map(([, t]) => t.id), ["cc"]);
});

test("a feature whose treatments are all hidden disappears with them", () => {
  const f = feat({ treatments: [makeTreatment({
    id: "p", type: "quick_build_separated", status: "proposed", phase: "p2" })] });
  const n = net({ features: [f] });
  assert.equal(featuresAsOfPhase(n, 1).length, 0);
  assert.equal(featuresAsOfPhase(n, 2).length, 1);
});

// --------------------------------------------------------------------------
// Rollups
// --------------------------------------------------------------------------
test("totals group by authority so 'who has to say yes' is answerable", () => {
  const a = feat({ id: "f1", treatments: [makeTreatment({
    id: "t1", type: "quick_build_separated", status: "proposed", phase: "p1",
    authority: "local" })] });
  const b = feat({ id: "f2", geometry: [[[0.6, 0.2], [0.6, 0.5]]],
    treatments: [makeTreatment({ id: "t2", type: "quick_build_separated",
      status: "proposed", phase: "p1", authority: "statedot" })] });
  const n = net({ features: [a, b] });
  const s = summarize(clipFeatures([a, b], SQUARE), n);
  const names = s.by_authority.map((x) => x.name);
  assert.ok(names.includes("Town of Testville"));
  assert.ok(names.includes("State DOT"));
});

test("counted treatments roll up into the sentence a council hears", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "t1", type: "street_trees", status: "proposed",
                    phase: "p1", quantity: 34 }),
    makeTreatment({ id: "t2", type: "parking_removal", status: "proposed",
                    phase: "p1", quantity: 12 }),
  ] });
  const s = summarize(clipFeatures([f], SQUARE), net({ features: [f] }));
  const byLabel = Object.fromEntries(s.quantities.map((q) => [q.label, q]));
  assert.equal(byLabel["Street trees"].n, 34);
  assert.equal(byLabel["Street trees"].unit, "trees");
  assert.equal(byLabel["Parking removal"].n, 12);
});

test("per-phase rows carry the phase label and date, not just a number", () => {
  const s = summarize(clipFeatures([feat()], SQUARE), net());
  assert.equal(s.phases.length, 1);
  assert.equal(s.phases[0].label, "Core");
  assert.ok(s.phases[0].km > 0);
});

test("a per-area cost multiplier scales the estimate", () => {
  const base = summarize(clipFeatures([feat()], SQUARE), net());
  const scaled = summarize(clipFeatures([feat()], SQUARE),
                           net({ costs: { by_area: { a1: { multiplier: 2 } } } }));
  assert.ok(Math.abs(scaled.cost_low - 2 * base.cost_low) < 1e-6);
});

test("partsKm ignores point parts", () => {
  assert.equal(partsKm([[[0.5, 0.5]]]), 0);
  assert.ok(partsKm([[[0.5, 0.2], [0.5, 0.4]]]) > 0);
});
