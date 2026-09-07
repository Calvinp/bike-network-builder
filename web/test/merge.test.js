// Bringing in someone else's network.
//
// The unit of replacement is a WHOLE AREA. No per-feature merge, no conflict
// resolution, no three-way anything — that is what makes the feature
// explainable in one sentence and maps onto how the work is actually divided
// (one group owns one town).
//
// The rules pinned here, in the order they matter:
//   * areas you don't have default to ADD; areas you do default to KEEP MINE.
//     Import never destroys work silently.
//   * a feature belongs to the area holding the MAJORITY OF ITS LENGTH, so
//     exactly one side owns a corridor that crosses a border.
//   * incoming ids that collide get rewritten, and every reference to them
//     follows.
//   * phase mapping is skipped entirely when it would be trivial.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  licenseConflict,
  applyMerge,
  assignAreas,
  describeMerge,
  mergedMeta,
  phasePlan,
  planMerge,
} from "../js/merge.js";
import { makeArea, makeFeature, makeNetwork, makePhase, makeTreatment }
  from "../js/network_format.js";
import { setRegistry } from "../js/registry.js";

setRegistry(JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8")));

// Two adjacent unit squares: WEST is lon 0..1, EAST is lon 1..2.
const square = (lon0, lon1) => [[[[0, lon0], [0, lon1], [1, lon1], [1, lon0], [0, lon0]]]];
const WEST = makeArea({ id: "west", name: "Westville", boundary: square(0, 1) });
const EAST = makeArea({ id: "east", name: "Eastville", boundary: square(1, 2) });

const feat = (id, name, geometry, over = {}) => makeFeature({
  id, name, geometry,
  treatments: [makeTreatment({ id: `t-${id}`, type: "quick_build_separated",
                               status: "proposed", phase: "p1" })],
  ...over,
});
const inWest = (id, name) => feat(id, name, [[[0.5, 0.2], [0.5, 0.8]]]);
const inEast = (id, name) => feat(id, name, [[[0.5, 1.2], [0.5, 1.8]]]);

const net = (over = {}) => makeNetwork({
  areas: [WEST], authorities: [{ id: "w", name: "Westville DPW", level: "municipal" }],
  phases: [makePhase({ id: "p1", number: 1, label: "Core", target_date: "2029" })],
  features: [inWest("f1", "Main Street")],
  ...over,
});

// --------------------------------------------------------------------------
// Which area does a feature belong to?
// --------------------------------------------------------------------------
test("a feature is assigned to the area that contains it", () => {
  const m = assignAreas([inWest("a", "A"), inEast("b", "B")], [WEST, EAST]);
  assert.equal(m.get("a"), "west");
  assert.equal(m.get("b"), "east");
});

test("a border-crossing feature belongs to the area holding most of it", () => {
  // Mostly in the west: 0.2..1.0 west (0.8) vs 1.0..1.1 east (0.1).
  const straddler = feat("s", "Border Road", [[[0.5, 0.2], [0.5, 1.1]]]);
  const m = assignAreas([straddler], [WEST, EAST]);
  assert.equal(m.get("s"), "west");
  // Flip the majority and ownership flips with it.
  const other = feat("s2", "Border Road", [[[0.5, 0.9], [0.5, 1.9]]]);
  assert.equal(assignAreas([other], [WEST, EAST]).get("s2"), "east");
});

test("a point feature is assigned by containment", () => {
  const p = feat("p", "Racks", [[[0.5, 1.5]]]);
  assert.equal(assignAreas([p], [WEST, EAST]).get("p"), "east");
});

test("a feature in no declared area is unassigned, not misfiled", () => {
  const far = feat("x", "Somewhere else", [[[9, 9], [9, 9.5]]]);
  assert.equal(assignAreas([far], [WEST, EAST]).get("x"), null);
});

test("with no areas declared at all, nothing is assigned", () => {
  assert.equal(assignAreas([inWest("a", "A")], []).get("a"), null);
});

// --------------------------------------------------------------------------
// The plan: what the sheet shows
// --------------------------------------------------------------------------
test("an area I don't have defaults to ADD", () => {
  const theirs = net({ areas: [EAST], features: [inEast("g1", "Their Street")] });
  const plan = planMerge(net(), theirs);
  const east = plan.areas.find((a) => a.id === "east");
  assert.equal(east.isNew, true);
  assert.equal(east.choice, "theirs");
  assert.equal(east.mineCount, 0);
  assert.equal(east.theirsCount, 1);
});

test("an area I already have defaults to KEEP MINE", () => {
  // Import must never destroy work silently.
  const theirs = net({ features: [inWest("g1", "Their Main Street")] });
  const plan = planMerge(net(), theirs);
  const west = plan.areas.find((a) => a.id === "west");
  assert.equal(west.isNew, false);
  assert.equal(west.choice, "mine");
  assert.equal(west.mineCount, 1);
  assert.equal(west.theirsCount, 1);
});

test("an area only I have is reported as untouched", () => {
  const theirs = net({ areas: [EAST], features: [inEast("g1", "Theirs")] });
  const plan = planMerge(net(), theirs);
  const west = plan.areas.find((a) => a.id === "west");
  assert.equal(west.theirsCount, 0);
  assert.equal(west.untouched, true);
});

test("features of theirs in no area get their own bucket, defaulting to add", () => {
  const theirs = net({ features: [feat("x", "Nowhere", [[[9, 9], [9, 9.5]]])] });
  const plan = planMerge(net(), theirs);
  const other = plan.areas.find((a) => a.id === null);
  assert.equal(other.theirsCount, 1);
  assert.equal(other.choice, "theirs");
});

test("the plan names features that cross into an area I'm keeping", () => {
  // The summary has to say so out loud: they stay as I have them.
  const straddler = feat("s", "Border Road", [[[0.5, 0.9], [0.5, 1.9]]]);
  const theirs = net({ areas: [WEST, EAST], features: [straddler] });
  const plan = planMerge(net(), theirs);   // west defaults to "mine"
  assert.deepEqual(plan.seamCrossing, ["Border Road"]);
});

// --------------------------------------------------------------------------
// Applying it
// --------------------------------------------------------------------------
test("keeping mine drops their features for that area", () => {
  const theirs = net({ features: [inWest("g1", "Their Main Street")] });
  const out = applyMerge(net(), theirs, { areaChoices: { west: "mine" } });
  assert.deepEqual(out.features.map((f) => f.name), ["Main Street"]);
});

test("using theirs replaces MY features for that area, and only that area", () => {
  const mine = net({ areas: [WEST, EAST],
                     features: [inWest("f1", "My West"), inEast("f2", "My East")] });
  const theirs = net({ areas: [WEST], features: [inWest("g1", "Their West")] });
  const out = applyMerge(mine, theirs, { areaChoices: { west: "theirs" } });
  const names = out.features.map((f) => f.name).sort();
  assert.deepEqual(names, ["My East", "Their West"]);
});

test("adding a new area brings its features and its definition", () => {
  const theirs = net({ areas: [EAST], features: [inEast("g1", "Their Street")] });
  const out = applyMerge(net(), theirs, { areaChoices: { east: "theirs" } });
  assert.deepEqual(out.areas.map((a) => a.id).sort(), ["east", "west"]);
  assert.ok(out.features.some((f) => f.name === "Their Street"));
  assert.ok(out.features.some((f) => f.name === "Main Street"));   // mine kept
});

test("authorities they declare come along, without clobbering mine", () => {
  const theirs = net({
    areas: [EAST],
    authorities: [{ id: "w", name: "THEIR NAME FOR MINE", level: "municipal" },
                  { id: "e", name: "Eastville DPW", level: "municipal" }],
    features: [inEast("g1", "Theirs")] });
  const out = applyMerge(net(), theirs, { areaChoices: { east: "theirs" } });
  assert.equal(out.authority("w").name, "Westville DPW");   // mine wins
  assert.equal(out.authority("e").name, "Eastville DPW");   // theirs added
});

test("declining every area leaves my network untouched", () => {
  const theirs = net({ areas: [WEST, EAST],
                       features: [inWest("g1", "Theirs W"), inEast("g2", "Theirs E")] });
  const out = applyMerge(net(), theirs,
                         { areaChoices: { west: "mine", east: "mine" } });
  assert.deepEqual(out.features.map((f) => f.name), ["Main Street"]);
});

// --------------------------------------------------------------------------
// Id collisions
// --------------------------------------------------------------------------
test("an incoming id that collides is rewritten", () => {
  const theirs = net({ areas: [EAST], features: [inEast("f1", "Their Street")] });
  const out = applyMerge(net(), theirs, { areaChoices: { east: "theirs" } });
  const ids = out.features.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(out.features.some((f) => f.name === "Main Street" && f.id === "f1"));
});

test("references follow a rewritten id", () => {
  // Their upgrade must still point at their own treatment after the rewrite,
  // not at mine and not at nothing.
  const theirFeature = makeFeature({
    id: "f1", name: "Their Street", geometry: [[[0.5, 1.2], [0.5, 1.8]]],
    treatments: [
      makeTreatment({ id: "t-f1", type: "quick_build_separated",
                      status: "proposed", phase: "p1" }),
      makeTreatment({ id: "t-up", type: "concrete_separated", status: "proposed",
                      phase: "p1", upgrades: ["t-f1"] }),
    ],
  });
  const theirs = net({ areas: [EAST], features: [theirFeature] });
  const out = applyMerge(net(), theirs, { areaChoices: { east: "theirs" } });
  const brought = out.features.find((f) => f.name === "Their Street");
  const up = brought.treatments.find((t) => t.type === "concrete_separated");
  const base = brought.treatments.find((t) => t.type === "quick_build_separated");
  assert.deepEqual(up.upgrades, [base.id]);
  assert.notEqual(base.id, "t-f1");            // mine already had that id
});

test("a merged network validates", async () => {
  const { validateNetwork } = await import("../js/network_format.js");
  const theirs = net({ areas: [EAST], features: [inEast("f1", "Their Street")] });
  const out = applyMerge(net(), theirs, { areaChoices: { east: "theirs" } });
  assert.deepEqual(validateNetwork(out), []);
});

// --------------------------------------------------------------------------
// Phases (D6)
// --------------------------------------------------------------------------
test("phase mapping is skipped when either side has one phase", () => {
  // The fantasy-map user who put everything in Phase 1 should never learn this
  // screen exists.
  const theirs = net({ phases: [makePhase({ id: "x", number: 1, label: "All" })] });
  assert.equal(phasePlan(net(), theirs).trivial, true);
});

test("phase mapping is skipped when the plans already line up", () => {
  const same = [makePhase({ id: "p1", number: 1, label: "Core" }),
                makePhase({ id: "p2", number: 2, label: "Later" })];
  const mine = net({ phases: same });
  const theirs = net({ phases: same.map((p) => ({ ...p })) });
  assert.equal(phasePlan(mine, theirs).trivial, true);
});

test("otherwise the default mapping is identity by number", () => {
  const mine = net({ phases: [makePhase({ id: "a", number: 1, label: "Mine 1" }),
                              makePhase({ id: "b", number: 2, label: "Mine 2" }),
                              makePhase({ id: "c", number: 3, label: "Mine 3" })] });
  const theirs = net({ phases: [makePhase({ id: "x", number: 1, label: "Theirs 1" }),
                                makePhase({ id: "y", number: 2, label: "Theirs 2" })] });
  const plan = phasePlan(mine, theirs);
  assert.equal(plan.trivial, false);
  assert.deepEqual(plan.rows.map((r) => [r.fromId, r.toId]), [["x", "a"], ["y", "b"]]);
});

test("the rows carry labels and dates, because a number is not a choice", () => {
  const mine = net({ phases: [makePhase({ id: "a", number: 1, label: "Core",
                                          target_date: "2029" }),
                              makePhase({ id: "b", number: 2, label: "Next" })] });
  const theirs = net({ phases: [makePhase({ id: "x", number: 1, label: "Quick-build",
                                            target_date: "2030" }),
                                makePhase({ id: "y", number: 2, label: "Connectors" })] });
  const plan = phasePlan(mine, theirs);
  assert.equal(plan.rows[0].fromLabel, "Quick-build");
  assert.equal(plan.rows[0].fromDate, "2030");
  assert.equal(plan.options[0].label, "Core");
  assert.equal(plan.options[0].date, "2029");
});

test("order inversion is warned about, but allowed", () => {
  const mine = net({ phases: [makePhase({ id: "a", number: 1 }),
                              makePhase({ id: "b", number: 2 })] });
  const theirs = net({ phases: [makePhase({ id: "x", number: 1 }),
                                makePhase({ id: "y", number: 2 })] });
  assert.equal(isInverted(mine, theirs, { x: "b", y: "a" }), true);
  assert.equal(isInverted(mine, theirs, { x: "a", y: "b" }), false);
  // Many-to-one is a normal thing to want and never warns.
  assert.equal(isInverted(mine, theirs, { x: "a", y: "a" }), false);
});

function isInverted(mine, theirs, mapping) {
  const plan = phasePlan(mine, theirs);
  for (const r of plan.rows) r.toId = mapping[r.fromId];
  return plan.isInverted(plan.rows);
}

test("incoming treatments land in the mapped phase", () => {
  const mine = net({ phases: [makePhase({ id: "a", number: 1, label: "Mine 1" }),
                              makePhase({ id: "b", number: 2, label: "Mine 2" })] });
  const theirs = net({
    areas: [EAST],
    phases: [makePhase({ id: "x", number: 1 }), makePhase({ id: "y", number: 2 })],
    features: [feat("g1", "Theirs", [[[0.5, 1.2], [0.5, 1.8]]], {
      treatments: [makeTreatment({ id: "tg", type: "quick_build_separated",
                                   status: "proposed", phase: "y" })] })],
  });
  const out = applyMerge(mine, theirs, { areaChoices: { east: "theirs" },
                                         phaseMapping: { x: "a", y: "b" } });
  const brought = out.features.find((f) => f.name === "Theirs");
  assert.equal(brought.treatments[0].phase, "b");
  assert.deepEqual(out.phases.map((p) => p.id), ["a", "b"]);   // mine kept
});

test("an unmapped incoming phase is appended rather than dropped", () => {
  const mine = net({ phases: [makePhase({ id: "a", number: 1 })] });
  const theirs = net({
    areas: [EAST],
    phases: [makePhase({ id: "z", number: 5, label: "Way later" })],
    features: [feat("g1", "Theirs", [[[0.5, 1.2], [0.5, 1.8]]], {
      treatments: [makeTreatment({ id: "tg", type: "quick_build_separated",
                                   status: "proposed", phase: "z" })] })],
  });
  const out = applyMerge(mine, theirs, { areaChoices: { east: "theirs" },
                                         phaseMapping: { z: "__new__" } });
  const brought = out.features.find((f) => f.name === "Theirs");
  const added = out.phases.find((p) => p.label === "Way later");
  assert.ok(added, "the phase should have been appended");
  assert.equal(brought.treatments[0].phase, added.id);
  assert.equal(added.number, 2);              // renumbered onto the end of mine
});

// --------------------------------------------------------------------------
// Advanced: per-feature selection (NOT per-feature merging)
// --------------------------------------------------------------------------
test("advanced mode can take individual features", () => {
  const theirs = net({ areas: [EAST],
                       features: [inEast("g1", "Wanted"), inEast("g2", "Unwanted")] });
  const out = applyMerge(net(), theirs, {
    areaChoices: { east: "theirs" },
    featureChoices: { g1: true, g2: false },
  });
  const names = out.features.map((f) => f.name).sort();
  assert.deepEqual(names, ["Main Street", "Wanted"]);
});

// --------------------------------------------------------------------------
// Additive files: a record of what exists, not a rival plan
// --------------------------------------------------------------------------
const existingOnly = (id, name, geometry) => makeFeature({
  id, name, geometry,
  treatments: [makeTreatment({ id: `t-${id}`, type: "shared_use_path",
                               status: "existing" })],
});

test("a file that proposes nothing is additive", () => {
  // An existing-conditions pack (or OSM candidates) is not a competing plan
  // for the same town, so replacing an area with it would be absurd.
  const theirs = net({ features: [existingOnly("g1", "Trail",
                                               [[[0.5, 0.2], [0.5, 0.8]]])] });
  assert.equal(planMerge(net(), theirs).additive, true);
});

test("a file with any proposal is NOT additive", () => {
  assert.equal(planMerge(net(), net()).additive, false);
});

test("an additive import adds without replacing anything", () => {
  const theirs = net({ features: [existingOnly("g1", "Trail",
                                               [[[0.5, 0.2], [0.5, 0.8]]])] });
  const out = applyMerge(net(), theirs, { additive: true });
  const names = out.features.map((f) => f.name).sort();
  assert.deepEqual(names, ["Main Street", "Trail"]);   // mine survived
});

test("an additive import still honours the per-feature review", () => {
  // The review list is the whole point for an OSM pull: you see the
  // candidates and untick the ones you would not call infrastructure.
  const theirs = net({ features: [
    existingOnly("g1", "Real trail", [[[0.5, 0.2], [0.5, 0.4]]]),
    existingOnly("g2", "Paint between a bus lane and traffic",
                 [[[0.5, 0.5], [0.5, 0.7]]]),
  ] });
  const out = applyMerge(net(), theirs, {
    additive: true, featureChoices: { g1: true, g2: false } });
  const names = out.features.map((f) => f.name).sort();
  assert.deepEqual(names, ["Main Street", "Real trail"]);
});

test("the additive summary says nothing was replaced", async () => {
  const { describeMerge } = await import("../js/merge.js");
  const theirs = net({ features: [existingOnly("g1", "Trail",
                                               [[[0.5, 0.2], [0.5, 0.8]]])] });
  const lines = describeMerge(planMerge(net(), theirs), {}, { additive: true });
  assert.ok(lines.some((l) => /nothing of yours was replaced/.test(l)));
});

test("the additive summary counts what was actually taken, not what was offered", () => {
  // Saying "added 3" when one was unticked is a small lie about the thing the
  // user just did.
  const theirs = net({ features: [
    existingOnly("g1", "Kept", [[[0.5, 0.2], [0.5, 0.4]]]),
    existingOnly("g2", "Unticked", [[[0.5, 0.5], [0.5, 0.7]]]),
  ] });
  const plan = planMerge(net(), theirs);
  const lines = describeMerge(plan, {}, { additive: true, added: 1 });
  assert.ok(lines[0].startsWith("Added 1 "), lines[0]);
});

test("ODbL travels with the data it came from", () => {
  // Share-alike is contagious: once OSM content is in the file, the file is a
  // derivative database. applyMerge used to keep only MY meta, which silently
  // dropped the licence off every OSM import that landed in a network that
  // already had features — the case where it matters most.
  const osmFeature = { tags: { source: "osm" }, treatments: [] };
  const meta = mergedMeta({ title: "Malden" }, { license: "ODbL-1.0" },
                          [osmFeature]);
  assert.equal(meta.license, "ODbL-1.0");
  assert.equal(meta.title, "Malden", "the rest of my meta is untouched");
  // Attribution belongs in meta.contributors, which the format already
  // reserves — this must not invent a parallel field for it.
  assert.equal(meta.attribution, undefined);
});

test("an OSM-tagged treatment is enough to make the file ODbL", () => {
  const f = { tags: {}, treatments: [{ tags: { source: "osm" } }] };
  assert.equal(mergedMeta({}, {}, [f]).license, "ODbL-1.0");
});

test("a file with no OSM content keeps whatever licence it had", () => {
  const plain = { tags: {}, treatments: [{ tags: {} }] };
  assert.equal(mergedMeta({ license: "CC0-1.0" }, {}, [plain]).license, "CC0-1.0");
  assert.equal(mergedMeta({}, {}, [plain]).license, undefined,
               "and no licence is invented out of nothing");
});

test("ODbL from THEIRS wins even over my own more permissive claim", () => {
  // You cannot merge ODbL data and keep claiming CC0 on the result.
  const meta = mergedMeta({ license: "CC0-1.0" }, { license: "ODbL-1.0" }, []);
  assert.equal(meta.license, "ODbL-1.0");
});

test("a licence clash is reported, not adjudicated", () => {
  // Whether two share-alike licences may be combined depends on where the data
  // came from, which only the person importing it knows. Never block, never
  // silently launder, always say so.
  const msg = licenseConflict({ license: "ODbL-1.0" },
                              { license: "CC-BY-SA-4.0" });
  assert.match(msg, /CC-BY-SA-4\.0/);
  assert.match(msg, /ODbL-1\.0/);
  assert.match(msg, /worth checking/);
});

test("the ordinary cases raise no licence noise", () => {
  assert.equal(licenseConflict({ license: "ODbL-1.0" }, { license: "ODbL-1.0" }),
               null, "same licence");
  assert.equal(licenseConflict({}, { license: "ODbL-1.0" }), null,
               "an unlicensed file of mine absorbing one that says so");
  assert.equal(licenseConflict({ license: "ODbL-1.0" }, {}), null,
               "and a file that says nothing");
  assert.equal(licenseConflict({ license: "ODbL-1.0" }, { license: "CC0-1.0" }),
               null, "public-domain data going into ODbL is normal");
});

// A real boundary, so features actually land in the area rather than in the
// "somewhere else" bucket — without one, an areaChoices test tests nothing.
const BOX = [[[[42.40, -71.10], [42.50, -71.10], [42.50, -71.00],
               [42.40, -71.00], [42.40, -71.10]]]];
const inBox = (id, name, lat) => makeFeature({
  id, name,
  geometry: [[[lat, -71.06], [lat + 0.005, -71.05]]],
  treatments: [makeTreatment({ id: `t-${id}`, type: "shared_use_path",
                               status: "existing" })],
});
const netOf = (features) => makeNetwork({
  areas: [makeArea({ id: "a1", name: "Malden", boundary: BOX })], features,
});

test("one feature can be taken from an area you are otherwise keeping", () => {
  // The gap that made "merge just this street" impossible: the area choice was
  // a GATE above featureChoices, so ticking a feature inside a keep-mine area
  // did nothing. The per-feature choice wins now, and the radio is a shortcut
  // for setting it.
  const merged = applyMerge(
    netOf([inBox("m1", "Mine", 42.42)]),
    netOf([inBox("t1", "Wanted", 42.44), inBox("t2", "Not wanted", 42.46)]),
    { areaChoices: { a1: "mine" }, featureChoices: { t1: true } });
  assert.deepEqual(merged.features.map((f) => f.name).sort(),
                   ["Mine", "Wanted"],
                   "mine survives AND the one street I ticked comes in");
});

test("unticking one feature in a use-theirs area leaves the rest", () => {
  const merged = applyMerge(
    netOf([]),
    netOf([inBox("t1", "Keep", 42.42), inBox("t2", "Drop", 42.44)]),
    { areaChoices: { a1: "theirs" }, featureChoices: { t2: false } });
  assert.deepEqual(merged.features.map((f) => f.name), ["Keep"]);
});

test("an absent feature choice still follows the area", () => {
  // The UI does not enumerate every feature up front, so silence has to mean
  // "whatever the area says".
  const theirs = netOf([inBox("t1", "Theirs", 42.42)]);
  assert.equal(applyMerge(netOf([]), theirs,
    { areaChoices: { a1: "theirs" }, featureChoices: {} }).features.length, 1);
  assert.equal(applyMerge(netOf([]), theirs,
    { areaChoices: { a1: "mine" }, featureChoices: {} }).features.length, 0);
});
