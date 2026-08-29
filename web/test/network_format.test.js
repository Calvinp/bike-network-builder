// The v2 format in JS — the mirror of tests/test_network_format.py.
//
// Parity with the Python reader is pinned separately (tests/test_web_assets.py
// shells out to node); this file pins the behaviour itself.
import test from "node:test";
import assert from "node:assert/strict";
import yaml from "../vendor/js-yaml.mjs";
import "../js/migrate.js";                 // installs the v1 -> v2 upgrader
import {
  FORMAT_ID, FORMAT_VERSION, LEGACY_FORMAT_ID, STATUSES, newId, parseNetwork,
  serializeNetwork, supersededIds, validateNetwork,
} from "../js/network_format.js";

const MINIMAL = `
format: bike-network
format_version: 2
areas:
  - id: test-area
    name: Testville
phases:
  - id: core
    number: 1
    label: Core
    target_date: '2029'
features:
  - id: f1
    name: Main Street
    treatments:
      - id: t1
        type: quick_build_separated
        status: proposed
        phase: core
    geometry:
      - [[10.0, 20.0], [10.01, 20.01]]
`;

const net = () => parseNetwork(MINIMAL);
const parse = (body) => parseNetwork(
  `format: bike-network\nformat_version: 2\n${body}`);

test("v2 is the declared format", () => {
  assert.equal(FORMAT_ID, "bike-network");
  assert.equal(FORMAT_VERSION, 2);
  assert.equal(LEGACY_FORMAT_ID, "malden-bike-network");
});

test("a v2 file round trips through parse and serialize", () => {
  const a = net();
  assert.equal(serializeNetwork(a), serializeNetwork(parseNetwork(serializeNetwork(a))));
});

test("serialize writes the v2 header keys", () => {
  const doc = yaml.load(serializeNetwork(net()));
  assert.equal(doc.format, "bike-network");
  assert.equal(doc.format_version, 2);
  assert.equal(doc.crs, "EPSG:4326");
  assert.equal(doc.units, "metric");
});

// --------------------------------------------------------------------------
// Feature vs treatment
// --------------------------------------------------------------------------
test("a feature describes the place and a treatment the facility", () => {
  const f = net().features[0];
  assert.equal(f.name, "Main Street");
  assert.equal(f.treatments[0].type, "quick_build_separated");
});

test("treatment fields inherit from the feature when omitted", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: core, number: 1}]
features:
  - id: f1
    name: X
    status: existing
    authority: cityhall
    treatments:
      - {id: t1, type: shared_use_path}
      - {id: t2, type: street_trees, status: proposed, phase: core}
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
`);
  const [a, b] = n.features[0].treatments;
  assert.equal(a.status, "existing");
  assert.equal(a.authority, "cityhall");
  assert.equal(b.status, "proposed");
  assert.equal(b.authority, "cityhall");
});

// --------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------
test("a one-coordinate part is a point and two is a line", () => {
  const n = parse(`areas: [{id: a, name: A}]
features:
  - {id: f1, name: Corner, treatments: [{id: t1, type: bike_parking, status: existing}], geometry: [[[10.0, 20.0]]]}
  - {id: f2, name: Street, treatments: [{id: t2, type: shared_use_path, status: existing}], geometry: [[[10.0, 20.0], [10.01, 20.01]]]}
`);
  const [point, line] = n.features;
  assert.equal(point.geometryKind, "point");
  assert.ok(point.isPoint);
  assert.equal(line.geometryKind, "line");
  assert.deepEqual(point.points(), [[10.0, 20.0]]);
});

test("a feature may mix points and lines", () => {
  const n = parse(`areas: [{id: a, name: A}]
features:
  - id: f1
    name: Trees
    treatments: [{id: t1, type: street_trees, status: existing}]
    geometry:
      - [[10.0, 20.0]]
      - [[10.02, 20.0], [10.03, 20.0]]
`);
  assert.equal(n.features[0].geometryKind, "mixed");
});

test("geometry is never polymorphic on the way out", () => {
  const geom = yaml.load(serializeNetwork(net())).features[0].geometry;
  assert.ok(Array.isArray(geom[0]) && Array.isArray(geom[0][0]));
  assert.equal(geom[0][0].length, 2);
});

// --------------------------------------------------------------------------
// Dates: the YAML timestamp trap
// --------------------------------------------------------------------------
for (const [written, expected] of [["'2029'", "2029"], ["'2029-12'", "2029-12"],
                                   ["'2029-12-31'", "2029-12-31"], ["2029", "2029"],
                                   ["2029-12-31", "2029-12-31"]]) {
  test(`target_date is a string however it was written: ${written}`, () => {
    const n = parse(`areas: [{id: a, name: A}]
phases: [{id: core, number: 1, target_date: ${written}}]
features: []
`);
    assert.equal(n.phases[0].target_date, expected);
    assert.equal(typeof n.phases[0].target_date, "string");
  });
}

test("target_date serializes quoted so it never becomes a Date again", () => {
  // An unquoted 2029-12-31 is a Date at UTC midnight in js-yaml, which renders
  // as December 30 anywhere west of UTC.
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: core, number: 1, target_date: '2029-12-31'}]
features: []
`);
  const text = serializeNetwork(n);
  assert.ok(text.includes("target_date: '2029-12-31'"));
  assert.equal(typeof yaml.load(text).phases[0].target_date, "string");
});

// --------------------------------------------------------------------------
// Identity and upgrades
// --------------------------------------------------------------------------
test("ids are assigned to anything missing one", () => {
  const n = parse(`areas: [{name: A}]
phases: [{number: 1}]
features:
  - name: X
    treatments: [{type: shared_use_path, status: existing}]
    geometry: [[[10.0, 20.0], [10.01, 20.01]]]
`);
  assert.ok(n.areas[0].id && n.phases[0].id);
  assert.ok(n.features[0].id && n.features[0].treatments[0].id);
});

test("duplicate ids anywhere are an error", () => {
  const n = parse(`areas: [{id: dup, name: A}]
features:
  - {id: dup, name: X, treatments: [{id: t1, type: shared_use_path, status: existing}], geometry: [[[1.0, 2.0], [1.1, 2.1]]]}
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("duplicate id")));
});

test("newId is collision resistant", () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(newId());
  assert.equal(ids.size, 2000);
});

test("upgrades is a list so a rebuild can consolidate segments", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p2, number: 2}]
features:
  - {id: f1, name: A bit, treatments: [{id: qa, type: quick_build_separated, status: proposed, phase: p1}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
  - {id: f2, name: Another, treatments: [{id: qb, type: quick_build_separated, status: proposed, phase: p1}], geometry: [[[10.01, 20.0], [10.02, 20.0]]]}
  - {id: f3, name: Rebuilt, treatments: [{id: cc, type: concrete_separated, status: proposed, phase: p2, upgrades: [qa, qb]}], geometry: [[[10.0, 20.0], [10.02, 20.0]]]}
`);
  assert.deepEqual(validateNetwork(n), []);
  assert.deepEqual([...supersededIds(n)].sort(), ["qa", "qb"]);
});

test("upgrades accepts a bare string for convenience", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: p1, number: 1}, {id: p2, number: 2}]
features:
  - id: f1
    name: X
    treatments:
      - {id: qa, type: quick_build_separated, status: proposed, phase: p1}
      - {id: cc, type: concrete_separated, status: proposed, phase: p2, upgrades: qa}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
`);
  assert.deepEqual(n.features[0].treatments[1].upgrades, ["qa"]);
});

test("a dangling upgrade reference is an error", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: p2, number: 2}]
features:
  - {id: f1, name: X, treatments: [{id: cc, type: concrete_separated, status: proposed, phase: p2, upgrades: [nope]}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("nope")));
});

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------
test("the status vocabulary is closed and includes under_construction", () => {
  assert.deepEqual(STATUSES,
                   ["existing", "under_construction", "funded", "proposed"]);
});

test("an unknown status is an error because it changes the arithmetic", () => {
  const n = parse(`areas: [{id: a, name: A}]
features:
  - {id: f1, name: X, treatments: [{id: t1, type: shared_use_path, status: someday}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("someday")));
});

test("an unknown treatment type is NOT an error", () => {
  const n = parse(`areas: [{id: a, name: A}]
features:
  - {id: f1, name: X, treatments: [{id: t1, type: 'transit:bus_lane', status: existing}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
`);
  assert.deepEqual(validateNetwork(n), []);
});

test("a proposed treatment needs a declared phase", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: core, number: 1}]
features:
  - {id: f1, name: X, treatments: [{id: t1, type: shared_use_path, status: proposed, phase: nope}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("nope")));
});

test("a line-only field on a point is an error", () => {
  const n = parse(`areas: [{id: a, name: A}]
features:
  - {id: f1, name: X, treatments: [{id: t1, type: bike_parking, status: existing, travel: one_way}], geometry: [[[10.0, 20.0]]]}
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("travel")));
});

test("a feature with no treatments is an error", () => {
  const n = parse(`areas: [{id: a, name: A}]
features: [{id: f1, name: X, treatments: [], geometry: [[[1.0, 2.0]]]}]
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("treatment")));
});

test("a newer format version is rejected", () => {
  const n = parseNetwork("format: bike-network\nformat_version: 99\nareas: []\nfeatures: []\n");
  assert.ok(validateNetwork(n).some((e) => e.includes("newer")));
});

// --------------------------------------------------------------------------
// travel / sides / side and quantity
// --------------------------------------------------------------------------
test("travel and sides are separate so a two-way track on one side fits", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: p, number: 1}]
features:
  - {id: f1, name: Greenway, treatments: [{id: t1, type: shared_use_path, status: proposed, phase: p, travel: two_way, sides: 1, side: right}], geometry: [[[10.0, 20.0], [10.01, 20.0]]]}
`);
  const t = n.features[0].treatments[0];
  assert.equal(t.travel, "two_way");
  assert.equal(t.sides, 1);
  assert.equal(t.side, "right");
});

test("a counted treatment can carry a quantity", () => {
  const n = parse(`areas: [{id: a, name: A}]
phases: [{id: p, number: 1}]
features:
  - id: f1
    name: Main Street
    treatments:
      - {id: t1, type: parking_removal, status: proposed, phase: p, quantity: 12}
      - {id: t2, type: street_trees, status: proposed, phase: p, quantity: 34}
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
`);
  assert.deepEqual(n.features[0].treatments.map((t) => t.quantity), [12, 34]);
});

// --------------------------------------------------------------------------
// Areas, authorities, tags, preservation
// --------------------------------------------------------------------------
test("areas carry a multipolygon boundary with holes", async () => {
  const n = parse(`areas:
  - id: a
    name: A
    boundary:
      - - [[10.0, 20.0], [10.0, 21.0], [11.0, 21.0], [11.0, 20.0], [10.0, 20.0]]
        - [[10.4, 20.4], [10.4, 20.6], [10.6, 20.6], [10.6, 20.4], [10.4, 20.4]]
features: []
`);
  const { pointInBoundary } = await import("../js/boundary.js");
  assert.equal(n.areas[0].boundary[0].length, 2);
  assert.ok(pointInBoundary(10.2, 20.2, n.areas[0].boundary));
  assert.ok(!pointInBoundary(10.5, 20.5, n.areas[0].boundary));   // in the hole
});

test("authorities are declared, not enumerated", () => {
  const n = parse(`areas: [{id: a, name: A}]
authorities:
  - {id: dcr, name: DCR, level: special, note: parkways}
  - {id: nassau, name: Nassau County DPW, level: county}
features: []
`);
  assert.equal(n.authority("dcr").name, "DCR");
  assert.equal(n.authority("nassau").level, "county");
  assert.equal(n.authority("unheard-of").name, "unheard-of");
});

test("an unknown authority level is an error", () => {
  const n = parse(`areas: [{id: a, name: A}]
authorities: [{id: x, name: X, level: galactic}]
features: []
`);
  assert.ok(validateNetwork(n).some((e) => e.includes("level")));
});

test("tags survive a round trip untouched", () => {
  const n = parse(`areas: [{id: a, name: A, tags: {gnis: '12345'}}]
phases: [{id: p, number: 1, tags: {deadline_v1: End of FY35}}]
features:
  - id: f1
    name: X
    tags: {source: osm}
    treatments: [{id: t1, type: shared_use_path, status: existing, tags: {width_m: 2.4}}]
    geometry: [[[10.0, 20.0], [10.01, 20.0]]]
`);
  const out = yaml.load(serializeNetwork(n));
  assert.deepEqual(out.areas[0].tags, { gnis: "12345" });
  assert.deepEqual(out.phases[0].tags, { deadline_v1: "End of FY35" });
  assert.deepEqual(out.features[0].tags, { source: "osm" });
  assert.deepEqual(out.features[0].treatments[0].tags, { width_m: 2.4 });
});

test("empty tags are omitted so plain files stay plain", () => {
  assert.ok(!("tags" in yaml.load(serializeNetwork(net())).features[0]));
});

test("unknown top-level keys are preserved", () => {
  const n = parseNetwork(`${MINIMAL}ordinance_chapter: Ch. 12.XX\n`);
  assert.equal(yaml.load(serializeNetwork(n)).ordinance_chapter, "Ch. 12.XX");
});

test("changing one field changes one line", () => {
  const before = serializeNetwork(net()).split("\n");
  const n = net();
  n.features[0].name = "Renamed Street";
  const after = serializeNetwork(n).split("\n");
  const diff = before.map((line, i) => [line, after[i]]).filter(([a, b]) => a !== b);
  assert.equal(diff.length, 1);
  assert.ok(diff[0][1].includes("Renamed Street"));
});
