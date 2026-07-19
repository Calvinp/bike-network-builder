// Tests for the shared network.yaml format — mirrors tests/test_network_format.py.
import test from "node:test";
import assert from "node:assert/strict";
import {
  makeNetwork, makePath, makePhase, parseNetwork, serializeNetwork,
  validateNetwork,
} from "../js/network_format.js";

function net() {
  return makeNetwork({
    city: "Malden", state: "Massachusetts", ordinance_chapter: "Ch. 12.XX",
    phases: [makePhase(1, "Core", "December 31, 2029"),
             makePhase(2, "Connectors", "December 31, 2032")],
    paths: [
      makePath({ name: "Main Street", type: "quick_build_separated",
                 status: "proposed", phase: 1, on_street: "Main Street",
                 from: "Main Street & A", to: "Main Street & B",
                 segments: [[[42.42, -71.07], [42.43, -71.06]]] }),
      makePath({ name: "Northern Strand", type: "shared_use_path",
                 status: "existing", phase: null,
                 segments: [[[42.41, -71.05], [42.42, -71.04]]] }),
      makePath({ name: "Broadway", type: "concrete_separated",
                 status: "proposed", phase: 2, jurisdiction: "state",
                 directions: 1, segments: [[[42.40, -71.05], [42.41, -71.06]]] }),
    ],
  });
}

test("roundtrip preserves everything", () => {
  const out = parseNetwork(serializeNetwork(net()));
  assert.equal(out.city, "Malden");
  assert.equal(out.ordinance_chapter, "Ch. 12.XX");
  assert.deepEqual(out.phases.map(p => [p.number, p.label, p.deadline]),
    [[1, "Core", "December 31, 2029"], [2, "Connectors", "December 31, 2032"]]);
  assert.equal(out.paths.length, 3);
  const [a, b, c] = out.paths;
  assert.equal(a.type, "quick_build_separated");
  assert.equal(a.phase, 1);
  assert.deepEqual(a.segments, [[[42.42, -71.07], [42.43, -71.06]]]);
  assert.equal(b.status, "existing");
  assert.equal(b.phase, null);
  assert.equal(c.jurisdiction, "state");
  assert.equal(c.directions, 1);
  assert.deepEqual(validateNetwork(out), []);
});

test("duplicate path names are allowed", () => {
  const n = net();
  for (const p of n.paths) p.name = "New path";
  const out = parseNetwork(serializeNetwork(n));
  assert.equal(out.paths.length, 3);
  assert.deepEqual(validateNetwork(out), []);
});

test("parse accepts treatment alias", () => {
  const out = parseNetwork(`
paths:
  - name: Old file
    treatment: buffered_painted
    phase: 1
    geometry: [[42.4, -71.1], [42.5, -71.0]]
phases:
  - {phase: 1, label: Core, deadline: '2029'}
`);
  assert.equal(out.paths[0].type, "buffered_painted");
});

test("non-mapping yaml is rejected", () => {
  assert.throws(() => parseNetwork("- just\n- a\n- list\n"));
});

const badFieldCases = [
  [n => { n.paths[0].type = "gold_plated"; }, "type"],
  [n => { n.paths[0].status = "dreamed"; }, "status"],
  [n => { n.paths[0].jurisdiction = "county"; }, "jurisdiction"],
  [n => { n.paths[0].directions = 3; }, "directions"],
  [n => { n.paths[0].phase = null; }, "phase"],
  [n => { n.paths[0].phase = 9; }, "not declared"],
  [n => { n.paths[0].segments = [[[42.4, -71.1]]]; }, "geometry"],
  [n => { n.paths[0].segments = [[[442.4, -71.1], [42.5, -71.0]]]; }, "out of range"],
  [n => { n.paths[0].segments = [[[42.4, -71.1], [42.5, -71.0]], [[42.6, -71.2]]]; },
   "segment #2"],
  [n => { n.paths[0].name = ""; }, "name"],
  [n => { n.format_id = "spreadsheet"; }, "format"],
  [n => { n.format_version = 99; }, "newer"],
];
for (const [mutate, needle] of badFieldCases) {
  test(`validation catches bad fields (${needle})`, () => {
    const n = net();
    mutate(n);
    const errors = validateNetwork(n);
    assert.ok(errors.some(e => e.includes(needle)), JSON.stringify(errors));
  });
}

test("existing paths need no phase", () => {
  const n = net();
  assert.equal(n.paths[1].phase, null);
  assert.deepEqual(validateNetwork(n), []);
});

test("geometry rounds to six decimals", () => {
  const n = net();
  n.paths[0].segments = [[[42.123456789, -71.987654321], [42.5, -71.0]]];
  const out = parseNetwork(serializeNetwork(n));
  assert.deepEqual(out.paths[0].segments[0][0], [42.123457, -71.987654]);
});

test("multi-segment roundtrip", () => {
  const n = net();
  n.paths[1].segments = [[[42.41, -71.05], [42.42, -71.04]],
                         [[42.43, -71.03], [42.44, -71.02]]];
  const out = parseNetwork(serializeNetwork(n));
  assert.deepEqual(out.paths[1].segments, n.paths[1].segments);
  assert.deepEqual(validateNetwork(out), []);
  assert.deepEqual(out.paths[0].segments, [[[42.42, -71.07], [42.43, -71.06]]]);
});

test("neighborway is a valid type", () => {
  const n = net();
  n.paths[0].type = "neighborway";
  assert.deepEqual(validateNetwork(n), []);
});

test("serialized yaml keeps single-segment geometry flow-style and compact", () => {
  // The Python tool reads what we write; geometry must stay a flat list of
  // [lat, lon] pairs for one segment (the pre-multi-segment form).
  const text = serializeNetwork(net());
  assert.match(text, /geometry: \[\[42\.42, -71\.07\], \[42\.43, -71\.06\]\]/);
});
