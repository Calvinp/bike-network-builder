// The export pipeline: clip, then produce every artifact in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildArtifacts, buildPhaseArtifacts, phaseStops } from "../js/export.js";
import { makeFeature, makeNetwork, makePhase, makeTreatment }
  from "../js/network_format.js";
import { setRegistry } from "../js/registry.js";

setRegistry(JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8")));

// A square area: lat 0..1, lon 0..1, as raw ways and as a clip boundary.
const WAYS = [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]];
const BOUNDARY = [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]];

const feat = (f = {}) => makeFeature({
  id: "f1", name: "Main Street",
  treatments: [makeTreatment({ id: "t1", type: "quick_build_separated",
                               status: "proposed", phase: "p1",
                               authority: "local" })],
  geometry: [[[0.5, 0.2], [0.5, 0.4]]],
  ...f,
});

const net = (f = {}) => makeNetwork({
  areas: [{ id: "a1", name: "Malden", context: "Massachusetts",
            displayName: "Malden, Massachusetts" }],
  authorities: [{ id: "local", name: "City of Malden", level: "municipal" }],
  phases: [makePhase({ id: "p1", number: 1, label: "Core", target_date: "2029" }),
           makePhase({ id: "p2", number: 2, label: "Later", target_date: "2032" })],
  features: [feat()],
  ...f,
});

test("buildArtifacts produces geojson, html and a summary", async () => {
  const art = await buildArtifacts(net(), WAYS, BOUNDARY, {});
  assert.equal(art.geojson.type, "FeatureCollection");
  assert.equal(art.geojson.features.length, 1);
  assert.ok(art.html.includes("Main Street"));
  assert.ok(art.summary.total_build_km > 0);
  assert.equal(art.pngBlob, null);            // no canvas in node
});

test("the exported geojson declares its format", async () => {
  const art = await buildArtifacts(net(), WAYS, BOUNDARY, {});
  assert.equal(art.geojson.format, "bike-network");
  assert.equal(art.geojson.format_version, 2);
});

test("duplicate names are kept — geometry travels with its feature", async () => {
  const a = feat({ id: "f1", name: "New path" });
  const b = feat({ id: "f2", name: "New path",
                   geometry: [[[0.6, 0.2], [0.6, 0.4]]],
                   treatments: [makeTreatment({ id: "t2",
                     type: "quick_build_separated", status: "proposed",
                     phase: "p1" })] });
  const art = await buildArtifacts(net({ features: [a, b] }), WAYS, BOUNDARY, {});
  assert.equal(art.geojson.features.length, 2);
});

test("buildArtifacts warns about features dropped outside the area", async () => {
  const outside = feat({ geometry: [[[9, 9], [9.1, 9.1]]] });
  const art = await buildArtifacts(net({ features: [outside] }), WAYS, BOUNDARY, {});
  assert.ok(art.summary.warnings.some((w) => /entirely outside/.test(w)));
});

test("buildArtifacts rejects an unknown colour mode", async () => {
  await assert.rejects(
    () => buildArtifacts(net(), WAYS, BOUNDARY, { colorMode: "rainbow" }),
    /color_mode must be one of/);
});

test("point treatments ride along in the exported geojson", async () => {
  const point = feat({ id: "f2", name: "Racks",
    treatments: [makeTreatment({ id: "t2", type: "bike_parking",
                                 status: "existing" })],
    geometry: [[[0.5, 0.5]]] });
  const art = await buildArtifacts(net({ features: [feat(), point] }),
                                   WAYS, BOUNDARY, {});
  const kinds = art.geojson.features.map((f) => f.geometry.type);
  assert.ok(kinds.includes("Point"));
  assert.ok(kinds.includes("LineString"));
});

test("a point outside the area is clipped away", async () => {
  const point = feat({ id: "f2", name: "Racks",
    treatments: [makeTreatment({ id: "t2", type: "bike_parking",
                                 status: "existing" })],
    geometry: [[[9, 9]]] });
  const art = await buildArtifacts(net({ features: [point] }), WAYS, BOUNDARY, {});
  assert.equal(art.geojson.features.length, 0);
});

test("a file with adjusted costs says so in the export", async () => {
  // These numbers end up in front of a city council.
  const plain = await buildArtifacts(net(), WAYS, BOUNDARY, {});
  assert.ok(!plain.summary.notices.some((n) => /adjusted by the author/.test(n)));
  const adjusted = await buildArtifacts(
    net({ costs: { by_area: { a1: { multiplier: 1.4 } } } }), WAYS, BOUNDARY, {});
  assert.ok(adjusted.summary.notices.some((n) => /adjusted by the author/.test(n)));
});

test("a phased network gets a slider; an unphased one does not", async () => {
  const phased = await buildArtifacts(net(), WAYS, BOUNDARY, {});
  assert.ok(/"stops":\s*\[\s*\{/.test(phased.html));
  const flat = feat({ treatments: [makeTreatment({
    id: "t1", type: "shared_use_path", status: "existing" })] });
  const unphased = await buildArtifacts(
    net({ features: [flat], phases: [] }), WAYS, BOUNDARY, {});
  assert.ok(/"stops":\s*\[\s*\]/.test(unphased.html));
});

test("phaseStops walks Today then each phase with proposed work", () => {
  const stops = phaseStops(net(), [feat()]);
  assert.deepEqual(stops.map((s) => s.n), [0, 1]);
  assert.equal(stops[0].caption, "Today");
  assert.ok(stops[1].caption.includes("Core"));
  assert.ok(stops[1].caption.includes("2029"));
});

test("phase artifacts need a canvas renderer, so they are empty without one", async () => {
  assert.deepEqual(await buildPhaseArtifacts(net(), WAYS, BOUNDARY, {}), []);
});

test("context layers embed when small and are skipped with a notice when huge", async () => {
  const small = { entry: { id: "trees", label: "Trees" },
                  geojson: { type: "FeatureCollection", features: [] } };
  const huge = { entry: { id: "big", label: "Big" },
                 geojson: { type: "FeatureCollection",
                            features: [{ note: "x".repeat(600 * 1024) }] } };
  const art = await buildArtifacts(net(), WAYS, BOUNDARY, {
    contextLayers: [small, huge] });
  assert.ok(art.html.includes("Trees"));
  assert.ok(art.summary.notices.some((n) => /Big/.test(n)));
});

test("a superseded treatment stays in map.html so the slider can fall back", async () => {
  // Unticking the upgrade's phase must reveal the treatment it replaced,
  // rather than blanking the corridor.
  const f = feat({ treatments: [
    makeTreatment({ id: "qb", type: "quick_build_separated", status: "proposed",
                    phase: "p1" }),
    makeTreatment({ id: "cc", type: "concrete_separated", status: "proposed",
                    phase: "p2", upgrades: ["qb"] }),
  ] });
  const art = await buildArtifacts(net({ features: [f] }), WAYS, BOUNDARY, {});
  assert.ok(art.html.includes('"qb"'));
  assert.ok(art.html.includes('"cc"'));
});

// --------------------------------------------------------------------------
// Exporting a large network
// --------------------------------------------------------------------------
test("a network over a few areas stays one file", async () => {
  const { shouldSplitByArea } = await import("../js/export.js");
  assert.equal(shouldSplitByArea(net()), false);
});

test("a network over many areas splits into one file per area plus an index", async () => {
  // A single YAML holding a whole metro is not something anyone emails.
  const { shouldSplitByArea, splitByArea } = await import("../js/export.js");
  const { serializeNetwork, makeArea, makeNetwork, makePhase } =
    await import("../js/network_format.js");

  const areas = [];
  const features = [];
  for (let i = 0; i < 6; i++) {
    const lon0 = i, lon1 = i + 1;
    areas.push(makeArea({ id: `a${i}`, name: `Town ${i}`,
      boundary: [[[[0, lon0], [0, lon1], [1, lon1], [1, lon0], [0, lon0]]]] }));
    features.push(makeFeature({
      id: `f${i}`, name: `Street ${i}`,
      treatments: [makeTreatment({ id: `t${i}`, type: "quick_build_separated",
                                   status: "proposed", phase: "p1" })],
      geometry: [[[0.5, lon0 + 0.2], [0.5, lon0 + 0.8]]] }));
  }
  const big = makeNetwork({ areas, features,
    phases: [makePhase({ id: "p1", number: 1, label: "Core" })] });

  assert.equal(shouldSplitByArea(big), true);
  const files = splitByArea(big, { serialize: serializeNetwork });
  assert.equal(files.length, 7);          // six areas + the index
  assert.ok(files.some((f) => f.name === "networks/index.json"));
  assert.ok(files.some((f) => f.name === "networks/town-0.yaml"));

  // Each piece is a COMPLETE network file: it opens on its own rather than
  // being a fragment that only means something beside its siblings.
  const { parseNetwork, validateNetwork } = await import("../js/network_format.js");
  const piece = parseNetwork(files.find((f) => f.name === "networks/town-3.yaml").data);
  assert.deepEqual(validateNetwork(piece), []);
  assert.equal(piece.features.length, 1);
  assert.equal(piece.features[0].name, "Street 3");
  assert.equal(piece.areas.length, 1);

  const index = JSON.parse(files.find((f) => f.name === "networks/index.json").data);
  assert.equal(index.areas.length, 6);
  assert.ok(index.areas.every((a) => a.file && a.features === 1));
});
