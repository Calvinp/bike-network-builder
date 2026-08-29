// The store: localStorage persistence plus static-asset loading — the app's
// replacement for a server. Every asset it reaches for is named in place.json,
// never in the code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, configForBrowser, networkFromBrowser } from "../js/store.js";
import { pointInBoundary } from "../js/boundary.js";
import { makeFeature, makeNetwork, makePhase, makeTreatment, parseNetwork,
         serializeNetwork } from "../js/network_format.js";
import { featuresToGeojson } from "../js/geojson.js";
import { zipCreate } from "../js/zip.js";

const TREATMENTS = readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8");

const BASE_YAML = serializeNetwork(makeNetwork({
  areas: [{ id: "a1", name: "Malden", kind: "municipality",
            context: "Massachusetts", boundary: [], contributors: [], tags: {} }],
  authorities: [{ id: "local", name: "City of Malden", level: "municipal" }],
  phases: [makePhase({ id: "p1", number: 1, label: "Core", target_date: "2029" })],
  features: [makeFeature({
    id: "f1", name: "Trail",
    treatments: [makeTreatment({ id: "t1", type: "shared_use_path",
                                 status: "existing" })],
    geometry: [[[42.41, -71.05], [42.42, -71.04]]] })],
  extra: { ordinance_chapter: "Ch. 12.XX" },
}));

// Two ways that between them trace a closed box — boundary() has to chain and
// close them, which is what the raw Malden data looks like.
const BOUNDARY_FC = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "LineString",
    coordinates: [[-71.09, 42.40], [-71.02, 42.40], [-71.02, 42.45]] } },
  { type: "Feature", geometry: { type: "LineString",
    coordinates: [[-71.02, 42.45], [-71.09, 42.45], [-71.09, 42.40]] } },
] });

const PLACE_JSON = JSON.stringify({
  name: "Malden",
  context: "Massachusetts",
  authorities: [{ id: "local", name: "City of Malden", level: "municipal" }],
  default_authority: "local",
  assets: {
    boundary: "data/malden_boundary.geojson",
    treatments: "data/treatments.json",
    seed_network: "data/base_network.yaml",
  },
  map: { center: [42.4251, -71.0662], zoom: 14 },
});

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    map: m,
  };
}

function makeStore() {
  const storage = fakeStorage();
  const fetched = [];
  const store = new Store({
    storage,
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith("place.json")) return PLACE_JSON;
      if (url.endsWith("treatments.json")) return TREATMENTS;
      if (url.endsWith("base_network.yaml")) return BASE_YAML;
      if (url.endsWith("malden_boundary.geojson")) return BOUNDARY_FC;
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  return { store, storage, fetched };
}

test("loadNetwork seeds a fresh browser from the configured seed, once", async () => {
  const { store, fetched } = makeStore();
  const net = await store.loadNetwork();
  assert.equal(net.features[0].name, "Trail");
  await store.loadNetwork();
  assert.equal(fetched.filter((u) => u.endsWith("base_network.yaml")).length, 1);
});

test("state returns everything the UI needs to paint itself", async () => {
  const { store } = makeStore();
  const state = await store.state();
  assert.equal(state.network.type, "FeatureCollection");
  assert.equal(state.config.areas[0].name, "Malden");
  assert.equal(state.config.phases[0].id, "p1");
  assert.equal(state.config.phases[0].target_date, "2029");
  assert.ok(state.options.treatments.some((t) => t.id === "quick_build_separated"));
  assert.ok(state.options.statuses.includes("under_construction"));
  assert.equal(state.boundary.length, 2);      // raw ways, for drawing
  assert.equal(state.place.name, "Malden");
});

test("the registry is loaded from the asset place.json names", async () => {
  const { store } = makeStore();
  const reg = await store.registry();
  assert.ok(reg.isKnown("concrete_separated"));
  assert.equal(reg.get("concrete_separated").color, "#D55E00");
});

test("boundary() assembles a closed multipolygon from the raw ways", async () => {
  const { store } = makeStore();
  const boundary = await store.boundary();
  assert.equal(boundary.length, 1);          // one polygon
  assert.equal(boundary[0].length, 1);       // no holes
  const ring = boundary[0][0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(pointInBoundary(42.42, -71.05, boundary));
  assert.ok(!pointInBoundary(42.60, -71.05, boundary));
});

test("boundary() is assembled once and cached", async () => {
  const { store, fetched } = makeStore();
  await store.boundary();
  await store.boundary();
  assert.equal(fetched.filter((u) => u.endsWith("malden_boundary.geojson")).length, 1);
});

test("save keeps fields the UI does not edit", async () => {
  const { store, storage } = makeStore();
  const before = await store.loadNetwork();
  await store.save({
    network: featuresToGeojson(before.features),
    config: configForBrowser(before),
  });
  const saved = parseNetwork(
    storage.getItem("bike-network-builder/network.yaml"));
  // ordinance_chapter is carried through untouched and never shown in the UI.
  assert.equal(saved.extra.ordinance_chapter, "Ch. 12.XX");
  assert.equal(saved.features[0].name, "Trail");
});

test("a save with no network payload is a no-op, not a wipe", async () => {
  const { store, storage } = makeStore();
  await store.loadNetwork();
  const before = storage.getItem("bike-network-builder/network.yaml");
  await store.save({ config: {} });
  assert.equal(storage.getItem("bike-network-builder/network.yaml"), before);
});

test("an area's boundary is restored from storage, not from the UI", async () => {
  // The boundary isn't editable in the UI and isn't round-tripped through it;
  // dropping it on every save would quietly delete the clip polygon.
  const existing = makeNetwork({
    areas: [{ id: "a1", name: "Malden", kind: "municipality", context: "",
              default_authority: "", updated: "", contributors: [], tags: {},
              boundary: [[[[0, 0], [0, 1], [1, 1], [0, 0]]]] }],
    features: [],
  });
  const merged = networkFromBrowser(
    { network: { features: [] },
      config: { areas: [{ id: "a1", name: "Malden" }] } }, existing);
  assert.equal(merged.areas[0].boundary.length, 1);
});

test("importBytes validates and reports errors verbatim", async () => {
  const { store } = makeStore();
  const bad = new TextEncoder().encode(
    "format: bike-network\nformat_version: 2\nareas: []\n"
    + "features: [{name: X, treatments: [], geometry: []}]\n");
  const res = await store.importBytes(bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("treatments")));
});

test("importBytes accepts a v1 file and upgrades it", async () => {
  const { store } = makeStore();
  const v1 = new TextEncoder().encode(
    "format: malden-bike-network\nformat_version: 1\ncity: Malden\n"
    + "phases: [{phase: 1, label: Core, deadline: 'End of FY32'}]\n"
    + "paths: [{name: Main, type: shared_use_path, status: existing, "
    + "geometry: [[42.4, -71.0], [42.5, -71.1]]}]\n");
  const res = await store.importBytes(v1);
  assert.equal(res.ok, true);
  assert.equal(res.network.features.length, 1);
  // The one place the upgrade has to ask a human.
  assert.equal(res.needsDates.length, 1);
  assert.equal(res.needsDates[0].text, "End of FY32");
});

test("importBytes reads a network file out of a zip bundle", async () => {
  const { store } = makeStore();
  const zip = await zipCreate([{ name: "network.yaml", data: BASE_YAML },
                         { name: "map.html", data: "<html></html>" }]);
  const res = await store.importBytes(zip);
  assert.equal(res.ok, true);
  assert.equal(res.network.features[0].properties.name, "Trail");
});

test("importBytes rejects a zip with no network file", async () => {
  const { store } = makeStore();
  const zip = await zipCreate([{ name: "map.html", data: "<html></html>" }]);
  const res = await store.importBytes(zip);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("yaml"));
});

test("exportYamlText round trips the stored network", async () => {
  const { store } = makeStore();
  await store.loadNetwork();
  const text = await store.exportYamlText();
  assert.equal(parseNetwork(text).features[0].name, "Trail");
});
