// The deployment's default area, read from data/place.json.
//
// Mirrors tests/test_place.py: nothing in the app names a city, a boundary
// file, or a map centre. Point place.json somewhere else and the app follows.
import test from "node:test";
import assert from "node:assert/strict";
import { makePlace, parsePlace } from "../js/place.js";

const TESTVILLE = {
  id: "test:testville",
  name: "Testville",
  context: "Nowhere",
  kind: "municipality",
  authorities: [
    { id: "testville", name: "Town of Testville", level: "municipal" },
    { id: "statedot", name: "State DOT", level: "state" },
  ],
  default_authority: "testville",
  assets: { boundary: "data/testville_boundary.geojson" },
  map: { center: [10.5, 20.5], zoom: 13 },
};

test("parsePlace reads identity, authorities and the map view", () => {
  const place = parsePlace(TESTVILLE);
  assert.equal(place.name, "Testville");
  assert.equal(place.displayName, "Testville, Nowhere");
  assert.equal(place.defaultAuthority, "testville");
  assert.equal(place.authorityName("statedot"), "State DOT");
  assert.deepEqual(place.mapCenter, [10.5, 20.5]);
  assert.equal(place.mapZoom, 13);
});

test("displayName drops the comma when there is no context", () => {
  assert.equal(parsePlace({ name: "Bare" }).displayName, "Bare");
});

test("an unknown authority id renders as itself, never as nothing", () => {
  // A file may reference an authority this deployment hasn't declared; the
  // UI still has to put a word on the screen.
  assert.equal(parsePlace(TESTVILLE).authorityName("county-dpw"), "county-dpw");
});

test("asset() returns the relative path, or null when not shipped", () => {
  const place = parsePlace(TESTVILLE);
  assert.equal(place.asset("boundary"), "data/testville_boundary.geojson");
  assert.equal(place.asset("street_graph"), null);
  assert.equal(place.asset("seed_network"), null);
});

test("a place with no map centre reports null rather than guessing", () => {
  // Guessing a centre would silently drop a user somewhere plausible-looking
  // and wrong; the app falls back to the boundary's own bounds instead.
  assert.equal(parsePlace({ name: "Bare" }).mapCenter, null);
});

test("parsePlace tolerates an empty or malformed document", () => {
  for (const raw of [null, undefined, {}, [], "nope"]) {
    const place = parsePlace(raw);
    assert.equal(place.name, "");
    assert.deepEqual(place.authorities, []);
    assert.equal(place.asset("boundary"), null);
  }
});

test("makePlace fills every field with a usable default", () => {
  const place = makePlace({});
  assert.equal(place.kind, "municipality");
  assert.equal(place.mapZoom, 13);
  assert.deepEqual(place.authorities, []);
});

test("the shipped place.json is Malden, and names its assets", async () => {
  const fs = await import("node:fs");
  const url = new URL("../data/place.json", import.meta.url);
  const place = parsePlace(JSON.parse(fs.readFileSync(url, "utf8")));
  assert.equal(place.name, "Malden");
  assert.equal(place.context, "Massachusetts");
  assert.equal(place.authorityName("massdot"), "MassDOT");
  assert.ok(place.asset("boundary").endsWith(".geojson"));
  assert.ok(place.asset("street_graph").endsWith(".json"));
});

// --------------------------------------------------------------------------
// The acceptance test: a town that doesn't exist, with no code change
// --------------------------------------------------------------------------
test("a synthetic place drives the app with no code change", async () => {
  const { Store } = await import("../js/store.js");
  const boundaryFc = JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", geometry: { type: "LineString", coordinates: [
      [20.0, 10.0], [21.0, 10.0], [21.0, 11.0]] } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [
      [21.0, 11.0], [20.0, 11.0], [20.0, 10.0]] } },
  ] });

  const m = new Map();
  const store = new Store({
    storage: { getItem: (k) => (m.has(k) ? m.get(k) : null),
               setItem: (k, v) => m.set(k, String(v)) },
    fetchText: async (url) => {
      if (url.endsWith("place.json")) return JSON.stringify(TESTVILLE);
      if (url.endsWith("testville_boundary.geojson")) return boundaryFc;
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  const place = await store.place();
  assert.equal(place.name, "Testville");

  // The boundary the app clips against is Testville's, assembled from its own
  // file — named nowhere in the code.
  const { pointInBoundary } = await import("../js/boundary.js");
  const boundary = await store.boundary();
  assert.ok(pointInBoundary(10.5, 20.5, boundary));
  assert.ok(!pointInBoundary(42.4251, -71.0662, boundary));   // not Malden

  // And a deployment that ships no seed network starts EMPTY rather than
  // failing — the v2 convention (V2_PLAN.md §7): the repo carries no network
  // data, and the user never has to import anything to get started.
  const net = await store.loadNetwork();
  assert.deepEqual(net.features, []);
  assert.deepEqual(net.areas, []);
});

// --------------------------------------------------------------------------
// The basemap is configuration, not a constant
// --------------------------------------------------------------------------
test("a place with no basemap gets a keyless default", async () => {
  // It was a hardcoded CARTO URL until CARTO began requiring an API key and
  // every tile came back stamped "API KEY REQUIRED". A static app has nowhere
  // to put a private key, so the provider has to be a deployment's choice.
  const { DEFAULT_BASEMAP } = await import("../js/place.js");
  const place = parsePlace({ name: "Bare" });
  assert.equal(place.basemap.url, DEFAULT_BASEMAP.url);
  assert.ok(!/\{key\}|apikey|api_key/i.test(place.basemap.url),
            "the default must not need an account");
  assert.ok(place.basemap.attribution);
});

test("a deployment can point the basemap wherever it likes", () => {
  const place = parsePlace({ name: "T", basemap: {
    url: "https://tiles.example.org/{z}/{x}/{y}.png",
    attribution: "© Example", max_zoom: 17,
    retina_url: "https://tiles.example.org/{z}/{x}/{y}@2x.png" } });
  assert.equal(place.basemap.url, "https://tiles.example.org/{z}/{x}/{y}.png");
  assert.equal(place.basemap.attribution, "© Example");
  assert.equal(place.basemap.maxZoom, 17);
  assert.ok(place.basemap.retinaUrl.endsWith("@2x.png"));
});

test("the shipped place.json ships a keyless basemap with attribution", async () => {
  const fs = await import("node:fs");
  const place = parsePlace(JSON.parse(fs.readFileSync(
    new URL("../data/place.json", import.meta.url), "utf8")));
  assert.ok(place.basemap.url.includes("{z}"));
  assert.ok(place.basemap.attribution.length > 0);
});
