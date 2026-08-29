// The GeoJSON wire format — the editor's internal payload AND the exported
// network.geojson, which makes it a second public artifact.
import test from "node:test";
import assert from "node:assert/strict";
import { featuresFromGeojson, featuresToGeojson, geojsonGeometry,
         partsFromGeojson } from "../js/geojson.js";
import { FORMAT_ID, FORMAT_VERSION, makeFeature, makeTreatment }
  from "../js/network_format.js";

const line = (f = {}) => makeFeature({
  id: "f1", name: "Main Street",
  treatments: [makeTreatment({ id: "t1", type: "quick_build_separated",
                               status: "proposed", phase: "core" })],
  geometry: [[[42.1, -71.1], [42.2, -71.2]]],
  ...f,
});

test("the collection declares what format it is", () => {
  const fc = featuresToGeojson([line()]);
  assert.equal(fc.format, FORMAT_ID);
  assert.equal(fc.format_version, FORMAT_VERSION);
});

test("a single line part becomes a LineString", () => {
  const [gf] = featuresToGeojson([line()]).features;
  assert.equal(gf.geometry.type, "LineString");
  assert.deepEqual(gf.geometry.coordinates[0], [-71.1, 42.1]);   // [lon, lat]
});

test("several line parts become a MultiLineString", () => {
  const f = line({ geometry: [[[42.1, -71.1], [42.2, -71.2]],
                              [[42.3, -71.3], [42.4, -71.4]]] });
  assert.equal(featuresToGeojson([f]).features[0].geometry.type, "MultiLineString");
});

test("a single point part becomes a Point", () => {
  const f = line({ geometry: [[[42.1, -71.1]]] });
  const [gf] = featuresToGeojson([f]).features;
  assert.equal(gf.geometry.type, "Point");
  assert.deepEqual(gf.geometry.coordinates, [-71.1, 42.1]);
});

test("several point parts become a MultiPoint", () => {
  const f = line({ geometry: [[[42.1, -71.1]], [[42.2, -71.2]]] });
  assert.equal(featuresToGeojson([f]).features[0].geometry.type, "MultiPoint");
});

test("a mix of points and lines becomes a GeometryCollection", () => {
  // Scattered trees plus a continuous row is ONE feature; splitting it here
  // would undo the reason features and spots were unified.
  const f = line({ geometry: [[[42.1, -71.1]], [[42.2, -71.2], [42.3, -71.3]]] });
  const [gf] = featuresToGeojson([f]).features;
  assert.equal(gf.geometry.type, "GeometryCollection");
  assert.deepEqual(gf.geometry.geometries.map((g) => g.type),
                   ["LineString", "Point"]);
});

test("treatments ride along as a nested array, not one feature each", () => {
  // Flattening would duplicate the geometry — exactly what unifying features
  // and treatments was meant to stop.
  const f = line({ treatments: [
    makeTreatment({ id: "t1", type: "shared_use_path", status: "existing" }),
    makeTreatment({ id: "t2", type: "streetcar", status: "proposed", phase: "p4" }),
  ] });
  const fc = featuresToGeojson([f]);
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.treatments.length, 2);
});

test("round trip preserves treatments, geometry and identity", () => {
  const f = line({
    on_street: "Main Street", start: "A & B", end: "C & D", notes: "spine",
    tags: { source: "osm" },
    treatments: [
      makeTreatment({ id: "t1", type: "quick_build_separated",
                      status: "proposed", phase: "core", authority: "local",
                      travel: "one_way", sides: 1, side: "right", quantity: 12,
                      upgrades: ["t0"], tags: { width_m: 2.4 } }),
    ],
  });
  const [back] = featuresFromGeojson(featuresToGeojson([f]));
  assert.equal(back.id, "f1");
  assert.equal(back.on_street, "Main Street");
  assert.equal(back.start, "A & B");
  assert.deepEqual(back.tags, { source: "osm" });
  assert.deepEqual(back.geometry, f.geometry);
  const t = back.treatments[0];
  assert.equal(t.type, "quick_build_separated");
  assert.equal(t.phase, "core");
  assert.equal(t.authority, "local");
  assert.equal(t.travel, "one_way");
  assert.equal(t.sides, 1);
  assert.equal(t.side, "right");
  assert.equal(t.quantity, 12);
  assert.deepEqual(t.upgrades, ["t0"]);
  assert.deepEqual(t.tags, { width_m: 2.4 });
});

test("a mixed-geometry round trip keeps both kinds of part", () => {
  const f = line({ geometry: [[[42.1, -71.1]], [[42.2, -71.2], [42.3, -71.3]]] });
  const [back] = featuresFromGeojson(featuresToGeojson([f]));
  assert.equal(back.geometryKind, "mixed");
  assert.equal(back.points().length, 1);
  assert.equal(back.lines().length, 1);
});

test("defaults are restored rather than lost when a property is absent", () => {
  // travel/sides/side are omitted when they are the default, so reading has to
  // put the defaults back — otherwise a round trip would blank them.
  const [back] = featuresFromGeojson(featuresToGeojson([line()]));
  assert.equal(back.treatments[0].travel, "two_way");
  assert.equal(back.treatments[0].sides, 2);
  assert.equal(back.treatments[0].side, "");
  assert.equal(back.treatments[0].quantity, null);
  assert.deepEqual(back.treatments[0].upgrades, []);
});

test("a feature with no usable geometry is skipped", () => {
  const f = line({ geometry: [] });
  assert.equal(featuresToGeojson([f]).features.length, 0);
});

test("geojsonGeometry and partsFromGeojson are inverses", () => {
  const parts = [[[42.1, -71.1], [42.2, -71.2]], [[42.5, -71.5]]];
  assert.deepEqual(partsFromGeojson(geojsonGeometry(parts)).sort(),
                   parts.sort());
});

test("an unrecognised geometry type yields no parts rather than throwing", () => {
  assert.deepEqual(partsFromGeojson({ type: "Polygon", coordinates: [] }), []);
  assert.deepEqual(partsFromGeojson(null), []);
});
