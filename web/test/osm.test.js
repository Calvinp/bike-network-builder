// Importing existing infrastructure from OpenStreetMap.
//
// This is the one thing in the browser allowed to call a public Overpass
// instance, so most of what is pinned here is the RESTRAINT: the throttle, the
// cache, the size cap, and above all that a busy service is never retried.
// Every test stubs fetch; the suite must not touch the network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AREA_SQKM, MIN_INTERVAL_MS, OverpassError, OverpassSession,
  bboxAreaSqKm, bboxOfBoundary, featuresFromOverpass, overpassQuery,
  treatmentFor,
} from "../js/osm.js";
import { pointInBoundary } from "../js/boundary.js";

const MALDEN = [[[[42.40, -71.09], [42.46, -71.09], [42.46, -71.02],
                  [42.40, -71.02], [42.40, -71.09]]]];

function session(handler, { now } = {}) {
  const calls = [];
  const clock = { t: 0 };
  const s = new OverpassSession({
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return handler(calls.length); },
    now: now || (() => clock.t),
    sleep: async (ms) => { clock.t += ms; },
  });
  return { s, calls, clock };
}
const ok = (elements) => ({ ok: true, status: 200, json: async () => ({ elements }) });

test("OSM tags map conservatively onto treatments", () => {
  // Calling paint protection is how a map starts lying about what exists.
  assert.equal(treatmentFor({ highway: "cycleway" }), "shared_use_path");
  assert.equal(treatmentFor({ highway: "path", bicycle: "designated" }),
               "shared_use_path");
  assert.equal(treatmentFor({ cycleway: "track" }), "concrete_separated");
  assert.equal(treatmentFor({ "cycleway:right": "track" }), "concrete_separated");
  assert.equal(treatmentFor({ cycleway: "lane" }), "buffered_painted");
  assert.equal(treatmentFor({ "cycleway:left": "lane" }), "buffered_painted");
  assert.equal(treatmentFor({ highway: "path" }), null,
               "a path that isn't designated for bikes is not a bike facility");
  assert.equal(treatmentFor({ highway: "residential" }), null);
  assert.equal(treatmentFor({}), null);
  assert.equal(treatmentFor(), null);
});

test("a track outranks a lane when a way carries both", () => {
  // Right side separated, left side painted: record the better thing, not the
  // first rule that happens to match.
  assert.equal(treatmentFor({ "cycleway:right": "track", "cycleway:left": "lane" }),
               "concrete_separated");
});

test("the query asks for exactly the five things we map", () => {
  const q = overpassQuery([42.4, -71.09, 42.46, -71.02]);
  assert.match(q, /\[out:json\]\[timeout:90\]/);
  assert.match(q, /way\["highway"="cycleway"\]/);
  assert.match(q, /way\["highway"="path"\]\["bicycle"="designated"\]/);
  assert.match(q, /way\["cycleway"~"lane\|track\|opposite_lane"\]/);
  assert.match(q, /out geom;/);
  assert.equal((q.match(/42\.400000,-71\.090000,42\.460000,-71\.020000/g) || []).length, 5,
               "every clause is bounded by the bbox");
});

test("ways outside the area are dropped, and untagged ways ignored", () => {
  const doc = { elements: [
    { type: "way", id: 1, tags: { highway: "cycleway", name: "Inside Path" },
      geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] },
    { type: "way", id: 2, tags: { highway: "cycleway" },
      geometry: [{ lat: 41.0, lon: -70.0 }, { lat: 41.1, lon: -70.1 }] },
    { type: "way", id: 3, tags: { highway: "residential" },
      geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] },
    { type: "node", id: 4, tags: { highway: "cycleway" } },
    { type: "way", id: 5, tags: { highway: "cycleway" },
      geometry: [{ lat: 42.42, lon: -71.06 }] },
  ] };
  const feats = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(feats.length, 1, "only the tagged, in-area, 2+ point way");
  assert.equal(feats[0].name, "Inside Path");
  assert.equal(feats[0].id, "osm-w1");
  assert.equal(feats[0].treatments[0].status, "existing");
});

test("every imported feature is marked as coming from OSM", () => {
  // ODbL: OSM-derived content has to stay identifiable and separable.
  const doc = { elements: [{ type: "way", id: 7, tags: { highway: "cycleway" },
    geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] }] };
  const [f] = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(f.tags.source, "osm");
  assert.equal(f.treatments[0].tags.source, "osm");
  assert.equal(f.treatments[0].tags.osm_way, "7");
});

test("a way with any point inside is kept whole", () => {
  // The importer clips properly afterwards; dropping a border-crossing way
  // here would lose the half that IS in the area.
  const doc = { elements: [{ type: "way", id: 9, tags: { highway: "cycleway" },
    geometry: [{ lat: 42.30, lon: -71.20 }, { lat: 42.42, lon: -71.06 }] }] };
  assert.equal(featuresFromOverpass(doc, MALDEN, pointInBoundary).length, 1);
});

test("a bbox is measured in real kilometres, not degrees", () => {
  assert.equal(bboxOfBoundary(MALDEN)[0], 42.40);
  assert.deepEqual(bboxOfBoundary([]), null);
  const malden = bboxAreaSqKm(bboxOfBoundary(MALDEN));
  assert.ok(malden > 20 && malden < 80, `a town is tens of km2, got ${malden}`);
  // A degree of longitude is much shorter than one of latitude here; ignoring
  // that would overstate the area by about a third and let big areas through.
  assert.ok(bboxAreaSqKm([42.4, -71.09, 42.46, -71.02])
            < bboxAreaSqKm([42.4, -71.09, 42.46, -70.98]));
});

test("a state-sized area is refused before any request is made", async () => {
  const { s, calls } = session(() => ok([]));
  await assert.rejects(
    () => s.elementsForArea({ id: "tx", name: "Texas",
      boundary: [[[[25.8, -106.6], [36.5, -106.6], [36.5, -93.5], [25.8, -93.5],
                   [25.8, -106.6]]]] }),
    (e) => e instanceof OverpassError && /past the .* limit/.test(e.message));
  assert.equal(calls.length, 0, "nothing that large is ever sent");
  assert.ok(MAX_AREA_SQKM >= 2500, "but a large city must still fit");
});

test("an area with no outline is refused before any request is made", async () => {
  const { s, calls } = session(() => ok([]));
  await assert.rejects(
    () => s.elementsForArea({ id: "x", name: "Nowhere", boundary: [] }),
    /no outline/);
  assert.equal(calls.length, 0);
});

test("requests are spaced out, and the caller cannot skip the wait", async () => {
  const { s, calls, clock } = session(() => ok([]));
  const area = (id) => ({ id, name: id, boundary: MALDEN });
  await s.elementsForArea(area("a"));
  const before = clock.t;
  await s.elementsForArea(area("b"));
  assert.equal(calls.length, 2);
  assert.ok(clock.t - before >= MIN_INTERVAL_MS,
            `expected a pause of at least ${MIN_INTERVAL_MS}ms`);
});

test("the same area is never looked up twice", async () => {
  const { s, calls } = session(() => ok([{ type: "way", id: 1 }]));
  const area = { id: "malden", name: "Malden", boundary: MALDEN };
  await s.elementsForArea(area);
  await s.elementsForArea(area);
  assert.equal(calls.length, 1, "the second call comes from the cache");
});

test("a busy service is reported, NEVER retried", async () => {
  // A client that retries under load is the reason the service is under load.
  for (const status of [429, 504]) {
    const { s, calls } = session(() => ({ ok: false, status, json: async () => ({}) }));
    await assert.rejects(
      () => s.elementsForArea({ id: `a${status}`, name: "A", boundary: MALDEN }),
      (e) => e instanceof OverpassError && e.retryable && /busy/.test(e.message));
    assert.equal(calls.length, 1, `${status} must produce exactly one request`);
  }
});

test("a failed lookup is not cached, so trying again can work", async () => {
  let n = 0;
  const { s } = session(() => (++n === 1
    ? { ok: false, status: 429, json: async () => ({}) }
    : ok([{ type: "way", id: 1, tags: { highway: "cycleway" },
            geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] }])));
  const area = { id: "malden", name: "Malden", boundary: MALDEN };
  await assert.rejects(() => s.elementsForArea(area));
  const elements = await s.elementsForArea(area);
  assert.equal(elements.length, 1);
});

test("the endpoint is overridable, so a busy deployment can self-host", () => {
  const mine = new OverpassSession({ url: "https://overpass.example.org/api" });
  assert.equal(mine.url, "https://overpass.example.org/api");
  assert.match(new OverpassSession({}).url, /^https:\/\//,
               "and there is a working default");
});

test("a query is POSTed, not crammed into a URL", async () => {
  // Overpass QL is long; a GET would hit URL length limits and log the whole
  // query in every proxy on the way.
  const { s, calls } = session(() => ok([]));
  await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN });
  assert.equal(calls[0].opts.method, "POST");
  assert.match(String(calls[0].opts.body), /out%3Ajson|out:json/);
});
