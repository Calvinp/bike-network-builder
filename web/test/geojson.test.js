// Tests for path <-> GeoJSON conversion — mirrors tests/test_geojson.py.
import test from "node:test";
import assert from "node:assert/strict";
import {
  pathsFromGeojson, pathsToGeojson, spotsFromGeojson, spotsToGeojson,
} from "../js/geojson.js";
import { makePath, makeSpot } from "../js/network_format.js";

function p(name, { phase = 1, status = "proposed", ...kw } = {}) {
  return makePath({
    name, on_street: name, from: `${name} & A`, to: `${name} & B`,
    phase, status, type: "quick_build_separated", notes: "hi",
    segments: [[[42.42, -71.07], [42.43, -71.06]]], ...kw,
  });
}

test("roundtrip preserves properties and geometry", () => {
  const paths = [
    p("Main"),
    p("Broadway", { phase: 3, jurisdiction: "state", directions: 1 }),
    p("Trail", { phase: null, status: "existing" }),
  ];
  const out = pathsFromGeojson(pathsToGeojson(paths));
  assert.deepEqual(out.map(x => x.name), ["Main", "Broadway", "Trail"]);
  assert.equal(out[1].jurisdiction, "state");
  assert.equal(out[1].directions, 1);
  assert.equal(out[0].type, "quick_build_separated");
  assert.equal(out[0].notes, "hi");
  assert.equal(out[2].status, "existing");
  assert.equal(out[2].phase, null);
  assert.deepEqual(out[0].segments[0][0], [42.42, -71.07]);
  assert.ok(out[0].length_miles > 0);
});

test("duplicate names survive roundtrip", () => {
  const paths = Array.from({ length: 6 }, () => p("New corridor"));
  paths.forEach((x, i) => {
    x.segments = [[[42.40 + i / 100, -71.07], [42.41 + i / 100, -71.06]]];
  });
  const out = pathsFromGeojson(pathsToGeojson(paths));
  assert.equal(out.length, 6);
  assert.equal(new Set(out.map(x => String(x.segments[0][0]))).size, 6);
});

test("combined path roundtrips as MultiLineString", () => {
  const one = p("Northern Strand");
  one.segments = [[[42.41, -71.05], [42.42, -71.04]],
                  [[42.43, -71.03], [42.44, -71.02]]];
  const fc = pathsToGeojson([one]);
  assert.equal(fc.features[0].geometry.type, "MultiLineString");
  const out = pathsFromGeojson(fc);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].segments, one.segments);
});

test("geojson features carry full property set", () => {
  const fc = pathsToGeojson([p("Main")]);
  const props = fc.features[0].properties;
  assert.equal(props.name, "Main");
  assert.equal(props.type, "quick_build_separated");
  assert.equal(props.from, "Main & A");
  assert.ok(props.miles > 0);
  assert.deepEqual(fc.features[0].geometry.coordinates[0], [-71.07, 42.42]);
});

test("from geojson skips degenerate features", () => {
  const fc = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { name: "Stub" },
      geometry: { type: "LineString", coordinates: [[-71.0, 42.4]] } },
  ] };
  assert.deepEqual(pathsFromGeojson(fc), []);
});

test("from geojson accepts legacy treatment property", () => {
  const fc = { type: "FeatureCollection", features: [
    { type: "Feature",
      properties: { name: "Old", treatment: "concrete_separated" },
      geometry: { type: "LineString",
                  coordinates: [[-71.0, 42.4], [-71.1, 42.5]] } },
  ] };
  assert.equal(pathsFromGeojson(fc)[0].type, "concrete_separated");
});

test("upgrade fields survive the wire round-trip", () => {
  // The editor round-trips every path through this module on save, so a
  // missing property would silently wipe upgrade links.
  const a = p("Main", { id: "main-1" });
  const b = p("Main rebuild", { phase: 2, upgrades: "main-1" });
  const out = pathsFromGeojson(pathsToGeojson([a, b]));
  assert.equal(out[0].id, "main-1");
  assert.equal(out[0].upgrades, "");
  assert.equal(out[1].upgrades, "main-1");
});

test("spots round-trip as Point features", () => {
  const spots = [
    makeSpot({ name: "Square racks", kind: "bike_parking", status: "existing",
               location: [42.43, -71.06], notes: "12 spaces" }),
    makeSpot({ kind: "speed_hump", phase: 2, location: [42.42, -71.07] }),
  ];
  const fc = spotsToGeojson(spots);
  // GeoJSON coordinate order is [lon, lat].
  assert.deepEqual(fc.features[0].geometry,
                   { type: "Point", coordinates: [-71.06, 42.43] });
  const out = spotsFromGeojson(fc);
  assert.deepEqual(out.map((s) => s.kind), ["bike_parking", "speed_hump"]);
  assert.equal(out[0].status, "existing");
  assert.equal(out[1].phase, 2);
  assert.deepEqual(out[1].location, [42.42, -71.07]);
});

test("spotsFromGeojson skips non-point and degenerate features", () => {
  const fc = { type: "FeatureCollection", features: [
    { type: "Feature", properties: { kind: "speed_hump" },
      geometry: { type: "LineString", coordinates: [[-71, 42.4], [-71.1, 42.5]] } },
    { type: "Feature", properties: { kind: "speed_hump" },
      geometry: { type: "Point", coordinates: [] } },
  ] };
  assert.deepEqual(spotsFromGeojson(fc), []);
});
