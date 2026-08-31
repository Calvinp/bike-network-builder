// Importing existing infrastructure from OpenStreetMap.
//
// This is the one thing in the browser allowed to call a public Overpass
// instance, so most of what is pinned here is the RESTRAINT: the throttle, the
// cache, the size cap, and above all that a busy service is never retried.
// Every test stubs fetch; the suite must not touch the network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_MAX_AGE_MS, MAX_AREA_SQKM, MIN_INTERVAL_MS, OverpassError,
  OverpassSession, bboxAreaSqKm, bboxOfBoundary, featuresFromOverpass,
  PATH_CLAUSES, SPOT_CLAUSES, isHeavy, overpassQuery, slotWaitSeconds,
  treatmentFor,
} from "../js/osm.js";
import { pointInBoundary } from "../js/boundary.js";

const MALDEN = [[[[42.40, -71.09], [42.46, -71.09], [42.46, -71.02],
                  [42.40, -71.02], [42.40, -71.09]]]];

function session(handler, { now, status = "2 slots available now." } = {}) {
  const calls = [];       // query POSTs only; status checks are separate
  const statusCalls = [];
  const clock = { t: 0 };
  const s = new OverpassSession({
    fetchImpl: async (url, opts) => {
      if (url.endsWith("/status")) {
        statusCalls.push(url);
        if (status === null) throw new Error("no status endpoint");
        return { ok: true, status: 200, text: async () => status };
      }
      calls.push({ url, opts });
      return handler(calls.length);
    },
    now: now || (() => clock.t),
    sleep: async (ms) => { clock.t += ms; },
  });
  return { s, calls, statusCalls, clock };
}
const ok = (elements) => ({ ok: true, status: 200, json: async () => ({ elements }) });

test("OSM tags map conservatively onto treatments", () => {
  // Calling paint protection is how a map starts lying about what exists.
  assert.equal(treatmentFor({ highway: "cycleway" }), "shared_use_path");
  assert.equal(treatmentFor({ highway: "path", bicycle: "designated" }),
               "shared_use_path");
  // A track is separated; OSM does not say by WHAT, so neither do we.
  assert.equal(treatmentFor({ cycleway: "track" }), "quick_build_separated");
  assert.equal(treatmentFor({ "cycleway:right": "track" }), "quick_build_separated");
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
               "quick_build_separated");
});

test("a track is separated WITHOUT claiming what separates it", () => {
  // It used to arrive as concrete_separated, inventing a curb that may be a
  // line of flex posts — the same over-claiming the painted-lane rule exists
  // to prevent, pointed the other way. Someone importing their own city spotted
  // it on a street they knew had no curb.
  assert.notEqual(treatmentFor({ cycleway: "track" }), "concrete_separated");
});

test("spot improvements are recognised, and a plain crossing is not one", () => {
  assert.equal(treatmentFor({ amenity: "bicycle_parking" }), "bike_parking");
  assert.equal(treatmentFor({ traffic_calming: "hump" }), "speed_hump");
  assert.equal(treatmentFor({ traffic_calming: "table" }), "raised_crosswalk");
  assert.equal(treatmentFor({ barrier: "bollard" }), "bollards");
  assert.equal(treatmentFor({ natural: "tree_row" }), "street_trees");
  assert.equal(treatmentFor({ highway: "crossing", "crossing:island": "yes" }),
               "pedestrian_island");
  assert.equal(treatmentFor({ highway: "crossing" }), null);
});

test("the query asks for the five path kinds we map", () => {
  const q = overpassQuery([42.4, -71.09, 42.46, -71.02]);
  assert.match(q, /\[out:json\]\[timeout:90\]/);
  assert.match(q, /way\["highway"="cycleway"\]/);
  assert.match(q, /way\["highway"="path"\]\["bicycle"="designated"\]/);
  assert.match(q, /way\["cycleway"~"lane\|track\|opposite_lane"\]/);
  assert.match(q, /out geom;/);
  assert.equal((q.match(/42\.400000,-71\.090000,42\.460000,-71\.020000/g) || []).length, 5,
               "every clause is bounded by the bbox");
  assert.doesNotMatch(q, /bicycle_parking/,
                      "spot improvements are opt-in, not the default");
});

test("asking for spots adds them, still bounded by the bbox", () => {
  const q = overpassQuery([42.4, -71.09, 42.46, -71.02], { spots: true });
  for (const tag of ["bicycle_parking", "traffic_calming", "bollard",
                     "crossing:island", "tree_row"]) {
    assert.ok(q.includes(tag), `expected ${tag} in the query`);
  }
  const bounded = (q.match(/42\.400000,-71\.090000,42\.460000,-71\.020000/g) || []);
  assert.equal(bounded.length, PATH_CLAUSES.length + SPOT_CLAUSES.length,
               "every clause, path and spot alike");
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

test("the pieces of one named path come back as ONE feature", () => {
  // OSM splits a way at every tag change and many junctions, so the Dr. Paul
  // Dudley White Path arrived as fourteen separate "lanes". Adjacent ways
  // share an OSM node, so their endpoints are identical numbers — no tolerance
  // needed, and a tolerance would start joining paths that genuinely stop.
  const seg = (id, pts) => ({ type: "way", id,
    tags: { highway: "cycleway", name: "Dudley White Path" },
    geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  const doc = { elements: [
    seg(1, [[42.42, -71.08], [42.43, -71.07]]),
    seg(3, [[42.45, -71.05], [42.44, -71.06]]),   // out of order AND reversed
    seg(2, [[42.43, -71.07], [42.44, -71.06]]),
  ] };
  const feats = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(feats.length, 1, "one path, not three");
  assert.equal(feats[0].geometry.length, 1, "and one continuous part");
  assert.equal(feats[0].geometry[0].length, 4, "with every vertex, once");
  assert.equal(feats[0].treatments[0].tags.osm_way, "1 3 2",
               "every source way is still recorded");
});

test("pieces that do not touch stay separate parts of one feature", () => {
  // A path interrupted by a road crossing is still one path, but drawing a
  // line through the gap would invent geometry that is not there.
  const seg = (id, pts) => ({ type: "way", id,
    tags: { highway: "cycleway", name: "Broken Path" },
    geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  const doc = { elements: [
    seg(1, [[42.42, -71.08], [42.43, -71.07]]),
    seg(2, [[42.44, -71.06], [42.45, -71.05]]),
  ] };
  const [f] = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(f.geometry.length, 2, "two parts, one feature");
});

test("unnamed ways are never lumped together", () => {
  // "Unnamed path" is not a name. Grouping every anonymous cycleway in a city
  // into one feature would be worse than the fragmentation it fixes.
  const seg = (id) => ({ type: "way", id, tags: { highway: "cycleway" },
    geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] });
  const feats = featuresFromOverpass({ elements: [seg(1), seg(2)] },
                                     MALDEN, pointInBoundary);
  assert.equal(feats.length, 2);
});

test("two DIFFERENT treatments on one street stay separate features", () => {
  // Half of Main Street is separated and half is painted. Merging them by name
  // would erase the difference the map exists to show.
  const way = (id, tags) => ({ type: "way", id, tags: { name: "Main Street", ...tags },
    geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] });
  const feats = featuresFromOverpass(
    { elements: [way(1, { cycleway: "track" }), way(2, { cycleway: "lane" })] },
    MALDEN, pointInBoundary);
  assert.equal(feats.length, 2);
  assert.deepEqual(feats.map((f) => f.treatments[0].type).sort(),
                   ["buffered_painted", "quick_build_separated"]);
});

test("a node becomes a spot, with its count when OSM knows it", () => {
  const doc = { elements: [
    { type: "node", id: 11, lat: 42.42, lon: -71.06,
      tags: { amenity: "bicycle_parking", capacity: "12" } },
    { type: "node", id: 12, lat: 42.43, lon: -71.05,
      tags: { amenity: "bicycle_parking", capacity: "lots" } },
  ] };
  const feats = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(feats.length, 2);
  assert.equal(feats[0].geometry[0].length, 1, "a spot is a one-point part");
  assert.equal(feats[0].treatments[0].quantity, 12);
  assert.equal(feats[1].treatments[0].quantity, undefined,
               "an unparseable capacity is left unset, never guessed");
});

test("the notes record the tags that drove the decision", () => {
  // A reviewer looking at "separated lane" on a street they know has paint
  // needs to see that OSM said cycleway=track, not to take our word for it.
  const doc = { elements: [{ type: "way", id: 5, tags: { cycleway: "track" },
    geometry: [{ lat: 42.42, lon: -71.06 }, { lat: 42.43, lon: -71.05 }] }] };
  const [f] = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.match(f.notes, /cycleway=track/);
});

test("the status text is read for how long until a slot frees up", () => {
  assert.equal(slotWaitSeconds("Rate limit: 2\n2 slots available now."), 0);
  assert.equal(slotWaitSeconds("1 slot available now."), 0);
  assert.equal(
    slotWaitSeconds("Slot available after: 2026-08-30T15:00:30Z, in 30 seconds."),
    30);
  // Several queued: the soonest is the one we can actually have.
  assert.equal(slotWaitSeconds(
    "Slot available after: X, in 45 seconds.\nSlot available after: Y, in 12 seconds."),
    12);
  assert.equal(slotWaitSeconds("Slot available after: X, in -3 seconds."), 0,
               "a time already past is a free slot");
  assert.equal(slotWaitSeconds("some format we have never seen"), null);
  assert.equal(slotWaitSeconds(""), null);
});

test("it asks whether a slot is free BEFORE firing a query", async () => {
  // Guessing an interval and hoping is what earns a 429. Asking is what a
  // well-behaved Overpass client does.
  const { s, calls, statusCalls } = session(() => ok([]));
  await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN });
  assert.equal(statusCalls.length, 1, "the status endpoint was consulted");
  assert.match(statusCalls[0], /\/status$/);
  assert.equal(calls.length, 1);
});

test("a queued slot is waited for, and the caller is told", async () => {
  const waits = [];
  const { s, clock } = session(() => ok([]), {
    status: "Slot available after: X, in 20 seconds.",
  });
  const before = clock.t;
  await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN },
                          { onWait: (secs) => waits.push(secs) });
  assert.deepEqual(waits, [20], "the UI can say why it is pausing");
  assert.ok(clock.t - before >= 20000, "and it actually waited");
});

test("a long queue is waited for rather than handed back as an error", async () => {
  // Capping the wait looks like the impatient choice; it is the opposite.
  // Waiting costs the service one status read and a timer. An error costs it a
  // button press from someone who will press it again.
  const { s, clock, calls } = session(() => ok([]), {
    status: "Slot available after: X, in 240 seconds.",
  });
  const before = clock.t;
  await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN });
  assert.ok(clock.t - before >= 240000, "it waited the full four minutes");
  assert.equal(calls.length, 1, "and then asked exactly once");
});

test("a missing or unparseable status never blocks an import", async () => {
  // Status is advisory. A mirror without the endpoint, or with a format we
  // have not seen, must still be usable.
  for (const status of [null, "who knows what this says"]) {
    const { s, calls } = session(() => ok([]), { status });
    await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN });
    assert.equal(calls.length, 1, `status ${status} should not block`);
  }
});

test("a 429 that says when to come back passes that on", async () => {
  const { s } = session(() => ({
    ok: false, status: 429,
    headers: { get: (k) => (k === "Retry-After" ? "42" : null) },
    json: async () => ({}),
  }));
  await assert.rejects(
    () => s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN }),
    /about 42 seconds/);
});

test("bike share docks import, with their capacity", () => {
  const doc = { elements: [{ type: "node", id: 21, lat: 42.42, lon: -71.06,
    tags: { amenity: "bicycle_rental", name: "Malden Center", capacity: "15" } }] };
  const [f] = featuresFromOverpass(doc, MALDEN, pointInBoundary);
  assert.equal(f.treatments[0].type, "bikeshare_dock");
  assert.equal(f.treatments[0].quantity, 15);
  assert.equal(f.name, "Malden Center");
});

test("a big area is flagged as heavy before anything is sent", () => {
  // Boston is ~230 km2, and importing it twice in a few minutes was enough to
  // get a 429 out of the public instance. Saying so up front beats failing
  // after a forty-second wait.
  const boston = [42.23, -71.19, 42.40, -70.99];
  const malden = [42.40, -71.09, 42.46, -71.02];
  assert.equal(isHeavy(boston), true);
  assert.equal(isHeavy(malden), false);
  // Spot improvements multiply the result set, so the bar for "heavy" drops.
  assert.equal(isHeavy([42.40, -71.15, 42.50, -71.02], { spots: true }), true);
});

test("bike share and bike parking are one clause, not two", () => {
  // Every clause is a separate bbox scan. Two keys that differ only in their
  // value belong in one regex.
  const q = overpassQuery([1, 2, 3, 4], { spots: true });
  assert.match(q, /bicycle_parking\|bicycle_rental/);
  assert.equal((q.match(/node\["amenity"/g) || []).length, 1);
});

test("a town already fetched is never asked for twice, even after a reload", async () => {
  // The politest thing in the file. The requests that actually burn a rate
  // limit are the REPEATS: import Boston, reload, import again. A cache that
  // dies with the page turns one query into two.
  const disk = new Map();
  const cache = {
    getItem: async (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: async (k, v) => { disk.set(k, String(v)); },
  };
  const area = { id: "boston", name: "Boston", boundary: MALDEN };
  const first = session(() => ok([{ type: "way", id: 1 }]));
  first.s.store = cache;
  await first.s.elementsForArea(area);
  assert.equal(first.calls.length, 1);

  // A completely fresh session — the page reloaded.
  const second = session(() => ok([{ type: "way", id: 999 }]));
  second.s.store = cache;
  const els = await second.s.elementsForArea(area);
  assert.equal(second.calls.length, 0, "nothing was asked of the service");
  assert.deepEqual(els, [{ type: "way", id: 1 }]);
});

test("paths and paths-plus-spots are cached separately", async () => {
  // Asking for spots after asking for paths is a different question, and must
  // not be answered from the narrower cache entry.
  const disk = new Map();
  const cache = { getItem: async (k) => disk.get(k) ?? null,
                  setItem: async (k, v) => { disk.set(k, String(v)); } };
  const area = { id: "m", name: "Malden", boundary: MALDEN };
  const { s, calls } = session(() => ok([]));
  s.store = cache;
  await s.elementsForArea(area, { spots: false });
  await s.elementsForArea(area, { spots: true });
  assert.equal(calls.length, 2);
  assert.equal(disk.size, 2);
});

test("a stale cache entry is refetched rather than served", async () => {
  // An import claiming to reflect what is on the ground should not be quoting
  // last month.
  const disk = new Map();
  const cache = { getItem: async (k) => disk.get(k) ?? null,
                  setItem: async (k, v) => { disk.set(k, String(v)); } };
  const area = { id: "m", name: "Malden", boundary: MALDEN };
  const clock = { t: 1_000_000 };
  const { s, calls } = session(() => ok([{ type: "way", id: 1 }]),
                               { now: () => clock.t });
  s.store = cache;
  s.sleep = async () => {};
  await s.elementsForArea(area);
  assert.equal(calls.length, 1);

  clock.t += CACHE_MAX_AGE_MS + 1;
  s.cache.clear();                       // the memory half is gone anyway
  await s.elementsForArea(area);
  assert.equal(calls.length, 2, "expired, so asked again");
});

test("a broken or unwritable cache never breaks an import", async () => {
  const hostile = {
    getItem: async () => "{ not json",
    setItem: async () => { throw new Error("quota exceeded"); },
  };
  const { s, calls } = session(() => ok([{ type: "way", id: 1 }]));
  s.store = hostile;
  const els = await s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN });
  assert.equal(els.length, 1);
  assert.equal(calls.length, 1);
});

test("a wait can be cancelled, and cancelling is not a failure to report", async () => {
  // Four minutes is a long time to be unable to change your mind.
  const ctl = new AbortController();
  const s = new OverpassSession({
    fetchImpl: async (url) => {
      if (url.endsWith("/status")) {
        return { ok: true, text: async () => "Slot available after: X, in 300 seconds." };
      }
      throw new Error("the query should never be sent");
    },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      // Cancel arrives while we are waiting.
      ctl.abort();
      const e = new Error("aborted"); e.name = "AbortError";
      if (signal && signal.aborted) reject(e); else reject(e);
    }),
  });
  await assert.rejects(
    () => s.elementsForArea({ id: "m", name: "Malden", boundary: MALDEN },
                            { signal: ctl.signal }),
    (e) => e.name === "AbortError");
});
