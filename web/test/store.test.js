// Tests for the localStorage-backed store — the static app's stand-in for
// editor.py's API. Mirrors the relevant parts of tests/test_editor_api.py,
// with storage/fetch injected so everything runs offline in Node.
import test from "node:test";
import assert from "node:assert/strict";
import { Store, configForBrowser, networkFromBrowser } from "../js/store.js";
import { parseNetwork, serializeNetwork, makeNetwork, makePath, makePhase }
  from "../js/network_format.js";
import { pathsToGeojson } from "../js/geojson.js";
import { zipCreate } from "../js/zip.js";

const BASE_YAML = serializeNetwork(makeNetwork({
  city: "Malden", ordinance_chapter: "Ch. 12.XX",
  phases: [makePhase(1, "Core", "2029")],
  paths: [makePath({ name: "Trail", type: "shared_use_path", status: "existing",
                     segments: [[[42.41, -71.05], [42.42, -71.04]]] })],
}));

const BOUNDARY_FC = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", geometry: { type: "LineString",
    coordinates: [[-71.09, 42.40], [-71.02, 42.40], [-71.02, 42.45]] } },
] });

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
      if (url.endsWith("base_network.yaml")) return BASE_YAML;
      if (url.endsWith("malden_boundary.geojson")) return BOUNDARY_FC;
      if (url.endsWith("malden_boundary_polygon.json")) {
        return JSON.stringify([[42.40, -71.09], [42.45, -71.09],
                               [42.45, -71.02], [42.40, -71.02], [42.40, -71.09]]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  return { store, storage, fetched };
}

test("loadNetwork seeds a fresh browser from the base network, once", async () => {
  const { store, fetched } = makeStore();
  const net = await store.loadNetwork();
  assert.equal(net.paths[0].name, "Trail");
  await store.loadNetwork();
  assert.equal(fetched.filter((u) => u.endsWith("base_network.yaml")).length, 1);
});

test("state returns the api_state shape", async () => {
  const { store } = makeStore();
  const state = await store.state();
  assert.equal(state.network.type, "FeatureCollection");
  assert.equal(state.config.city, "Malden");
  assert.deepEqual(state.config.phases, [{ phase: 1, label: "Core", deadline: "2029" }]);
  assert.ok(state.options.types.includes("neighborway"));
  assert.ok(state.options.cost_per_mile.quick_build_separated[1] > 0);
  assert.equal(state.boundary.length, 1);
  assert.deepEqual(state.boundary[0][0], [42.40, -71.09]);
});

test("save keeps fields the UI does not edit", async () => {
  const { store } = makeStore();
  const net = await store.loadNetwork();
  const payload = {
    network: pathsToGeojson([makePath({ name: "Main", phase: 1,
      segments: [[[42.42, -71.07], [42.43, -71.06]]] })]),
    config: { city: "Malden", phases: [{ phase: 1, label: "Core", deadline: "2029" }] },
  };
  await store.save(payload);
  const saved = await store.loadNetwork();
  assert.equal(saved.paths.length, 1);
  assert.equal(saved.paths[0].name, "Main");
  assert.equal(saved.ordinance_chapter, "Ch. 12.XX");  // preserved from the file
  assert.equal(saved.state, "Massachusetts");
  // saveSync writes the same thing without awaiting anything.
  store.saveSync(payload, net);
  assert.equal(parseNetwork(await store.exportYamlText()).paths[0].name, "Main");
});

test("importBytes accepts valid yaml and reports state", async () => {
  const { store } = makeStore();
  const res = await store.importBytes(new TextEncoder().encode(BASE_YAML));
  assert.equal(res.ok, true);
  assert.equal(res.network.features.length, 1);
  assert.equal(res.config.city, "Malden");
});

test("importBytes surfaces validation errors", async () => {
  const { store } = makeStore();
  const bad = BASE_YAML.replace("shared_use_path", "gold_plated");
  const res = await store.importBytes(new TextEncoder().encode(bad));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("gold_plated")));
});

test("importBytes rejects unparseable input", async () => {
  const { store } = makeStore();
  const res = await store.importBytes(new TextEncoder().encode("{ [ unclosed"));
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("Not parseable as YAML"));
});

test("importBytes finds network.yaml inside a zip bundle", async () => {
  const { store } = makeStore();
  const zip = await zipCreate([
    { name: "map.html", data: "<html></html>" },
    { name: "network.yaml", data: BASE_YAML },
  ]);
  const res = await store.importBytes(zip);
  assert.equal(res.ok, true);
  assert.equal(res.network.features.length, 1);
});

test("importBytes reports a zip with no yaml inside", async () => {
  const { store } = makeStore();
  const zip = await zipCreate([{ name: "readme.txt", data: "hi" }]);
  const res = await store.importBytes(zip);
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("doesn't contain"));
});

test("networkFromBrowser parses phases and falls back to existing ones", () => {
  const existing = makeNetwork({ phases: [makePhase(7, "Old", "")] });
  const out = networkFromBrowser({ network: { features: [] }, config: {
    city: "Malden", phases: [{ phase: "2", label: "Two" }] } }, existing);
  assert.deepEqual(out.phases.map((p) => [p.number, p.label]), [[2, "Two"]]);
  const fallback = networkFromBrowser({ network: { features: [] }, config: {} }, existing);
  assert.equal(fallback.phases[0].number, 7);
});

test("configForBrowser sorts phases", () => {
  const cfg = configForBrowser(makeNetwork({
    phases: [makePhase(2, "B", ""), makePhase(1, "A", "")] }));
  assert.deepEqual(cfg.phases.map((p) => p.phase), [1, 2]);
});
