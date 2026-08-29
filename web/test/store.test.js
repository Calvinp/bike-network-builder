// The store: localStorage persistence plus static-asset loading — the app's
// replacement for a server. Every asset it reaches for is named in place.json,
// never in the code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store, configForBrowser, networkFromBrowser } from "../js/store.js";
import { pointInBoundary } from "../js/boundary.js";
import { makeArea, makeFeature, makeNetwork, makePhase, makeTreatment,
         parseNetwork, serializeNetwork } from "../js/network_format.js";
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

test("a boundary supplied by the UI is saved, not silently discarded", async () => {
  // Boundaries aren't edited in the UI, but they do arrive there — adopted
  // from the deployment on first load, or carried in by an import. Taking the
  // stored one unconditionally threw both away on every save.
  const existing = makeNetwork({
    areas: [makeArea({ id: "a1", name: "Malden", boundary: [] })], features: [] });
  const ring = [[[[0, 0], [0, 1], [1, 1], [0, 0]]]];
  const merged = networkFromBrowser(
    { network: { features: [] },
      config: { areas: [{ id: "a1", name: "Malden", boundary: ring }] } }, existing);
  assert.equal(merged.areas[0].boundary.length, 1);
});

// --------------------------------------------------------------------------
// Snap-to-road data: tiles, a bundled graph, or nothing
// --------------------------------------------------------------------------
const TILE = JSON.stringify({
  coord: { 1: [42.42, -71.06], 2: [42.42, -71.05] },
  adj: { 1: [[2, 1]], 2: [[1, 1]] },
});

function tileStore(extraAssets, tiles) {
  const fetched = [];
  return {
    fetched,
    store: new Store({
      storage: (() => { const m = new Map(); return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)) }; })(),
      fetchText: async (url) => {
        fetched.push(url);
        if (url.endsWith("place.json")) {
          return JSON.stringify({ name: "Tileville",
            assets: { treatments: "data/treatments.json", ...extraAssets },
            tile_zoom: 14 });
        }
        if (url.endsWith("treatments.json")) return TREATMENTS;
        if (tiles && /roads\/\d+\/\d+\/\d+\.json$/.test(url)) return TILE;
        throw new Error(`unexpected fetch: ${url}`);
      },
    }),
  };
}

test("a deployment with no street data at all reports none, and that is fine", async () => {
  // Snapping is then simply unavailable and a click behaves like today's
  // off-street click — a legitimate state, not an error.
  const { store } = tileStore({}, false);
  assert.equal(await store.streetGraph(), null);
  assert.equal(await store.streetGraphFor([42.4, -71.1, 42.45, -71.0]), null);
});

test("tiles are fetched for the view and merged into one graph", async () => {
  const { store, fetched } = tileStore(
    { street_tiles: "roads/{z}/{x}/{y}.json" }, true);
  const res = await store.streetGraphFor([42.41, -71.07, 42.43, -71.05]);
  assert.ok(res.graph.coord.size >= 2);
  assert.ok(res.index, "an index comes back with the graph");
  assert.ok(fetched.some((u) => /roads\/14\/\d+\/\d+\.json/.test(u)));
});

test("panning over ground already loaded fetches nothing again", async () => {
  const { store, fetched } = tileStore(
    { street_tiles: "roads/{z}/{x}/{y}.json" }, true);
  const bbox = [42.41, -71.07, 42.43, -71.05];
  await store.streetGraphFor(bbox);
  const after = fetched.filter((u) => u.includes("roads/")).length;
  await store.streetGraphFor(bbox);
  assert.equal(fetched.filter((u) => u.includes("roads/")).length, after);
});

test("a missing tile is ordinary and is not retried on every pan", async () => {
  // Not every tile exists — coastline, a gap in coverage. Retrying forever
  // would turn a pan into a burst of failing requests.
  const { store, fetched } = tileStore(
    { street_tiles: "roads/{z}/{x}/{y}.json" }, false);
  const bbox = [42.41, -71.07, 42.43, -71.05];
  await store.streetGraphFor(bbox);
  const after = fetched.length;
  await store.streetGraphFor(bbox);
  assert.equal(fetched.length, after);
});

test("the tile cache is consulted before the network", async () => {
  const cache = new Map();
  const fetched = [];
  const store = new Store({
    storage: { getItem: () => null, setItem: () => {} },
    tileCache: cache,
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith("place.json")) {
        return JSON.stringify({ name: "T",
          assets: { street_tiles: "roads/{z}/{x}/{y}.json" }, tile_zoom: 14 });
      }
      return TILE;
    },
  });
  await store.streetGraphFor([42.41, -71.07, 42.43, -71.05]);
  assert.ok(cache.size > 0, "tiles should be cached");
  const tileRequests = fetched.filter((u) => u.includes("roads/")).length;
  // A second store sharing the cache does no network work for those tiles.
  const store2 = new Store({
    storage: { getItem: () => null, setItem: () => {} },
    tileCache: cache,
    fetchText: async (url) => {
      fetched.push(url);
      if (url.endsWith("place.json")) {
        return JSON.stringify({ name: "T",
          assets: { street_tiles: "roads/{z}/{x}/{y}.json" }, tile_zoom: 14 });
      }
      throw new Error("should have come from the cache");
    },
  });
  await store2.streetGraphFor([42.41, -71.07, 42.43, -71.05]);
  assert.equal(fetched.filter((u) => u.includes("roads/")).length, tileRequests);
});

test("a bundled graph still works, and comes with an index", async () => {
  const { store } = tileStore({ street_graph: "data/street_graph.json" }, false);
  const s2 = new Store({
    storage: { getItem: () => null, setItem: () => {} },
    fetchText: async (url) => {
      if (url.endsWith("place.json")) {
        return JSON.stringify({ name: "T",
          assets: { street_graph: "data/street_graph.json" } });
      }
      return readFileSync(new URL("../data/street_graph.json", import.meta.url), "utf8");
    },
  });
  const res = await s2.streetGraphFor([42.41, -71.07, 42.43, -71.05]);
  assert.ok(res.graph.coord.size > 1000);
  assert.ok(res.index);
});

// --------------------------------------------------------------------------
// Context layers: hidden when they have nothing to say about the area
// --------------------------------------------------------------------------
test("boxesOverlap is true only when two boxes actually touch", async () => {
  const { boxesOverlap } = await import("../js/store.js");
  assert.ok(boxesOverlap([0, 0, 1, 1], [0.5, 0.5, 2, 2]));
  assert.ok(boxesOverlap([0, 0, 1, 1], [1, 1, 2, 2]));      // touching counts
  assert.ok(!boxesOverlap([0, 0, 1, 1], [2, 2, 3, 3]));
});

test("a layer whose extent misses the area is hidden, not shown empty", () => {
  // MassDOT crash data is meaningless outside Massachusetts. Showing it empty
  // is a small lie; a layer list full of them is a useless one.
  const layersFor = async (extents) => {
    const store = new Store({
      storage: { getItem: () => null, setItem: () => {} },
      fetchText: async (url) => {
        if (url.endsWith("place.json")) {
          return JSON.stringify({ name: "T", assets: {
            boundary: "data/b.geojson", layers: "data/layers/layers.json" } });
        }
        if (url.endsWith("b.geojson")) return BOUNDARY_FC;    // ~42.40..42.45
        return JSON.stringify({ layers: extents });
      },
    });
    return (await store.layersForArea()).map((l) => l.id);
  };
  return Promise.all([
    layersFor([{ id: "near", extent: [42.41, -71.08, 42.44, -71.03] },
               { id: "far", extent: [30.0, -100.0, 31.0, -99.0] }])
      .then((ids) => assert.deepEqual(ids, ["near"])),
    // No declared extent: always offered, because we can't prove it's irrelevant.
    layersFor([{ id: "unknown" }]).then((ids) => assert.deepEqual(ids, ["unknown"])),
  ]);
});

// --------------------------------------------------------------------------
// Storage: IndexedDB primary, a synchronous journal for teardown
// --------------------------------------------------------------------------
test("saveSync writes a journal rather than the main store", async () => {
  // IndexedDB transactions do not complete once a tab is being torn down, so
  // pagehide has to reach for something synchronous.
  const { IdbStorage } = await import("../js/storage.js");
  const local = (() => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), map: m }; })();
  const idb = new IdbStorage({ local });
  assert.equal(idb.writeJournal("k", "hello"), true);
  assert.equal(local.getItem("k::journal"), "hello");
});

test("a network too big for the journal is skipped, not thrown", async () => {
  const { IdbStorage } = await import("../js/storage.js");
  const local = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const idb = new IdbStorage({ local, journalMaxBytes: 10 });
  assert.equal(idb.writeJournal("k", "x".repeat(100)), false);
});

test("a journal write that the browser refuses is survivable", async () => {
  const { IdbStorage } = await import("../js/storage.js");
  const local = { getItem: () => null, removeItem: () => {},
                  setItem: () => { throw new Error("QuotaExceededError"); } };
  const idb = new IdbStorage({ local });
  assert.equal(idb.writeJournal("k", "hello"), false);
});

test("the localStorage fallback keeps the same shape", async () => {
  const { LocalStorageAdapter } = await import("../js/storage.js");
  const m = new Map();
  const a = new LocalStorageAdapter({
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)) });
  a.setItem("k", "v");
  assert.equal(a.getItem("k"), "v");
  assert.equal(a.writeJournal("k", "w"), true);
});

test("the store awaits its storage, so an async adapter works", async () => {
  // Awaiting a plain value is harmless, which is what lets a synchronous
  // localStorage and an async IndexedDB share one code path.
  const m = new Map();
  const store = new Store({
    storage: {
      getItem: async (k) => (m.has(k) ? m.get(k) : null),
      setItem: async (k, v) => { m.set(k, String(v)); },
    },
    fetchText: async (url) => {
      if (url.endsWith("place.json")) return PLACE_JSON;
      if (url.endsWith("treatments.json")) return TREATMENTS;
      if (url.endsWith("base_network.yaml")) return BASE_YAML;
      if (url.endsWith("malden_boundary.geojson")) return BOUNDARY_FC;
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const net = await store.loadNetwork();
  assert.equal(net.features[0].name, "Trail");
});
