// Importing what OpenStreetMap already knows is on the ground.
//
// ## Why this is allowed to call Overpass, when nothing else here is
//
// V2_PLAN.md §8.5 rule 1 says the browser never calls a public Overpass
// instance. That rule was written against a specific pattern: queries fired at
// draw time, on pan, or as a routing fallback — where load scales with USAGE
// and a browser tool cannot bound its own user count.
//
// This is not that. One query per AREA, ever, started by a person choosing a
// menu item. Load scales with towns added, not with time spent editing, which
// is ordinary Overpass use — the same thing a human does with JOSM. The rule
// is amended rather than broken, and §8.5 records the amendment.
//
// ## What stops it becoming the thing the rule feared
//
//  * Never automatic. Only from the OSM import sheet, only on a click.
//  * Areas are fetched ONE AT A TIME, never in parallel.
//  * A minimum interval between requests, enforced here rather than by the UI.
//  * A PERSISTENT cache. Re-importing a town you already fetched — after a
//    reload, after a failure, after changing your mind — costs the service
//    nothing. This matters more than any throttle: the requests that actually
//    burn a rate limit are the repeats.
//  * It ASKS BEFORE IT FIRES. Overpass publishes a /status endpoint saying how
//    many slots are free and, if none are, when the next one frees up. Waiting
//    for a slot is what a well-behaved client does; guessing an interval and
//    hoping is what earns a 429.
//  * NO automatic retry. A 429 or a 504 stops and says so. Retrying under load
//    is precisely how a polite client becomes a hammer.
//  * A hard size cap. A query over a whole state is expensive and is refused
//    with a pointer to the batch tool.
//  * `place.fetch.overpass_url` overrides the endpoint, so a deployment that
//    expects real volume self-hosts. That is §8.5's own argument for static
//    tiles applied here: growth becomes a line item you control rather than
//    someone else's problem.
//
// ## Licence
//
// OSM is ODbL. Geometry extracted here lands in a file the user may share, so
// the import writes `license: ODbL-1.0` and credits OpenStreetMap in `meta`,
// and every feature carries `tags: {source: osm}` so OSM-derived content stays
// identifiable and separable (V2_PLAN.md §8.6).

export const DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";

// A big city is ~1,000 km2 and the largest US one is ~2,300. A state starts at
// ~4,000. Past this the query stops being "a town" and becomes the kind of
// extract that belongs in tools/fetch_existing_infra.py.
export const MAX_AREA_SQKM = 5000;

// Well under the hard cap, and already enough to get a 429 out of the public
// instance: Boston is ~230 km2 and importing it twice in a few minutes was
// enough. Past this the UI says so before you press the button, because "it
// failed" after a 40-second wait is a worse answer than "this one is big".
export const HEAVY_AREA_SQKM = 120;

// Spacing between requests, enforced in the session rather than in the UI so
// no caller can skip it by wiring a button up differently. A floor, not the
// whole story: the slot check below is what actually keeps us inside the
// service's limits.
export const MIN_INTERVAL_MS = 4000;

// Cached elements go stale — OSM changes, and an import claiming to reflect
// "what is on the ground" should not be quoting last month.
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Overpass /status is plain text. Two shapes matter:
//
//   "2 slots available now."
//   "Slot available after: 2026-08-30T15:00:30Z, in 30 seconds."
//
// Returns seconds to wait: 0 when a slot is free, null when the text says
// nothing we understand (in which case the caller just proceeds — status is
// advisory, and an unparsed format must never block the import).
export function slotWaitSeconds(text) {
  const s = String(text || "");
  if (/\bslots? available now/i.test(s)) return 0;
  const waits = [...s.matchAll(/in\s+(-?\d+)\s+seconds?/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  if (!waits.length) return null;
  // Several slots may be queued; the soonest is the one we can have.
  const soonest = Math.min(...waits);
  return soonest > 0 ? soonest : 0;
}

// Paths and lanes: what everyone wants, and what the import has always done.
export const PATH_CLAUSES = [
  'way["highway"="cycleway"]',
  'way["highway"="path"]["bicycle"="designated"]',
  'way["cycleway"~"lane|track|opposite_lane"]',
  'way["cycleway:left"~"lane|track"]',
  'way["cycleway:right"~"lane|track"]',
];

// Spot improvements: OPT-IN, because a city has thousands of these and a
// review list with thousands of rows is a review list nobody reads. Someone
// who specifically wants the bike parking can ask for it.
export const SPOT_CLAUSES = [
  'node["amenity"~"^(bicycle_parking|bicycle_rental)$"]',
  'node["traffic_calming"~"hump|bump|table|cushion"]',
  'node["barrier"="bollard"]',
  'node["highway"="crossing"]["crossing:island"="yes"]',
  'way["natural"="tree_row"]',
];

// Mirrors tools/fetch_existing_infra.py. A parity test pins them together,
// because two copies of a query that drift are two different tools.
export function overpassQuery(bbox, { spots = false } = {}) {
  const [s, w, n, e] = bbox.map((v) => Number(v).toFixed(6));
  const box = `${s},${w},${n},${e}`;
  const clauses = [...PATH_CLAUSES, ...(spots ? SPOT_CLAUSES : [])]
    .map((c) => `  ${c}(${box});`).join("\n");
  return `[out:json][timeout:90];
(
${clauses}
);
out geom;`;
}

// What OSM tagging maps onto which treatment. Deliberately CONSERVATIVE, and
// identical to the Python tool's TAG_RULES: an unprotected painted lane is
// recorded as `buffered_painted`, never as anything "separated", because
// calling paint protection is how a map starts lying about what exists.
//
// ⚠️ `cycleway=track` means "physically separated" in OSM and says NOTHING
// about what separates it. It used to arrive here as `concrete_separated`,
// which invented a curb that may be a line of flex posts — the same
// over-claiming this table exists to avoid, just pointed the other way. It now
// arrives as `quick_build_separated`: still separated, no construction
// claimed. The raw tag travels in `notes` so a reviewer can correct it.
export function treatmentFor(tags = {}) {
  const t = tags || {};
  if (t.highway === "cycleway") return "shared_use_path";
  if (t.highway === "path" && t.bicycle === "designated") return "shared_use_path";
  if (t.cycleway === "track" || t["cycleway:left"] === "track"
      || t["cycleway:right"] === "track") return "quick_build_separated";
  if (t.cycleway === "lane" || t.cycleway === "opposite_lane"
      || t["cycleway:left"] === "lane" || t["cycleway:right"] === "lane") {
    return "buffered_painted";
  }
  // Spot improvements, only present when the caller asked for them.
  if (t.amenity === "bicycle_parking") return "bike_parking";
  if (t.amenity === "bicycle_rental") return "bikeshare_dock";
  if (t.traffic_calming === "table") return "raised_crosswalk";
  if (["hump", "bump", "cushion"].includes(t.traffic_calming)) return "speed_hump";
  if (t.barrier === "bollard") return "bollards";
  if (t.natural === "tree_row") return "street_trees";
  if (t.highway === "crossing" && t["crossing:island"] === "yes") {
    return "pedestrian_island";
  }
  return null;
}

// Which tags actually drove the decision, for the notes field. A reviewer
// looking at "separated lane" on a street they know has paint needs to see
// that OSM said `cycleway=track`, not to take our word for it.
const EXPLAIN_KEYS = ["highway", "bicycle", "cycleway", "cycleway:left",
                      "cycleway:right", "amenity", "traffic_calming", "barrier",
                      "natural", "crossing:island", "surface", "capacity"];
export function explainTags(tags = {}) {
  const parts = EXPLAIN_KEYS
    .filter((k) => tags[k] !== undefined && tags[k] !== "")
    .map((k) => `${k}=${tags[k]}`);
  return parts.length ? `OSM: ${parts.join(", ")}` : "";
}

// [south, west, north, east] around a [lat, lon] multipolygon.
export function bboxOfBoundary(boundary) {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  const walk = (v) => {
    if (!Array.isArray(v)) return;
    if (typeof v[0] === "number" && typeof v[1] === "number") {
      any = true;
      if (v[0] < s) s = v[0];
      if (v[0] > n) n = v[0];
      if (v[1] < w) w = v[1];
      if (v[1] > e) e = v[1];
      return;
    }
    v.forEach(walk);
  };
  walk(boundary);
  return any ? [s, w, n, e] : null;
}

const KM_PER_DEG_LAT = 110.574;
export function bboxAreaSqKm(bbox) {
  if (!bbox) return 0;
  const [s, w, n, e] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const height = (n - s) * KM_PER_DEG_LAT;
  const width = (e - w) * 111.320 * Math.cos(midLat);
  return Math.abs(height * width);
}

// OSM splits a way at every tag change and many junctions, so one path
// arrives as a dozen pieces. Chaining them back together is what makes the
// Dr. Paul Dudley White Path one feature instead of fourteen.
//
// Endpoints that meet are IDENTICAL, not merely close: adjacent ways share the
// same OSM node, so its coordinates are the same number in both. No tolerance
// is needed, and adding one would start joining paths that genuinely stop.
const endKey = (pt) => `${pt[0]},${pt[1]}`;

export function chainParts(parts) {
  const pool = (parts || []).filter((p) => p && p.length >= 2).map((p) => [...p]);
  const runs = [];
  while (pool.length) {
    const run = pool.shift();
    let joined = true;
    while (joined) {
      joined = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const runHead = endKey(run[0]);
        const runTail = endKey(run[run.length - 1]);
        const pHead = endKey(p[0]);
        const pTail = endKey(p[p.length - 1]);
        if (runTail === pHead) run.push(...p.slice(1));
        else if (runTail === pTail) run.push(...[...p].reverse().slice(1));
        else if (runHead === pTail) run.unshift(...p.slice(0, -1));
        else if (runHead === pHead) run.unshift(...[...p].reverse().slice(0, -1));
        else continue;
        pool.splice(i, 1);
        joined = true;
        break;
      }
    }
    runs.push(run);
  }
  return runs;
}

// Overpass elements -> plain feature objects, ready for makeFeature().
//
// Ways with the SAME NAME and the same treatment become one feature whose
// geometry has several parts, with touching pieces chained first. Unnamed ways
// stay separate: "Unnamed path" is not a name, and lumping every anonymous
// cycleway in a city into one feature would be worse than the fragmentation.
export function featuresFromOverpass(result, boundary, pointInBoundary) {
  const inArea = (pts) => !boundary || !boundary.length || !pointInBoundary
    || pts.some(([lat, lon]) => pointInBoundary(lat, lon, boundary));

  const lines = new Map();     // group key -> {name, type, tags, ids, parts}
  const points = [];
  for (const el of (result && result.elements) || []) {
    const tags = el.tags || {};
    const type = treatmentFor(tags);
    if (!type) continue;
    const id = String(el.id ?? "");

    if (el.type === "node") {
      if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      if (!inArea([[el.lat, el.lon]])) continue;
      points.push(makeOsmFeature({
        id, type, tags,
        name: tags.name || defaultNameFor(type),
        geometry: [[[el.lat, el.lon]]],
        quantity: countFor(type, tags),
      }));
      continue;
    }
    if (el.type !== "way") continue;
    const pts = (el.geometry || [])
      .filter((g) => g && typeof g.lat === "number" && typeof g.lon === "number")
      .map((g) => [g.lat, g.lon]);
    if (pts.length < 2 || !inArea(pts)) continue;

    const name = tags.name || tags.ref || "";
    // Only NAMED ways are grouped; the id keeps anonymous ones apart.
    const key = name ? `${name}\u0000${type}` : `\u0000${id}`;
    const group = lines.get(key) || { name, type, tags, ids: [], parts: [] };
    group.ids.push(id);
    group.parts.push(pts);
    lines.set(key, group);
  }

  const out = [];
  for (const g of lines.values()) {
    const parts = chainParts(g.parts);
    out.push(makeOsmFeature({
      id: g.ids[0], type: g.type, tags: g.tags,
      name: g.name || `Unnamed path ${g.ids[0]}`,
      onStreet: g.tags.name || "",
      geometry: parts,
      ways: g.ids,
    }));
  }
  return [...out, ...points];
}

const DEFAULT_NAMES = {
  bike_parking: "Bike parking",
  bikeshare_dock: "Bike share dock",
  speed_hump: "Speed hump",
  raised_crosswalk: "Raised crossing",
  bollards: "Bollards",
  street_trees: "Street trees",
  pedestrian_island: "Pedestrian island",
};
const defaultNameFor = (type) => DEFAULT_NAMES[type] || "Existing spot";

// `capacity` is how many bikes a rack holds, which is exactly the quantity a
// counted treatment wants. Anything unparseable is left unset rather than
// guessed at.
function countFor(type, tags) {
  if (type !== "bike_parking" && type !== "bikeshare_dock") return undefined;
  const n = parseInt(tags.capacity, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function makeOsmFeature({ id, type, tags, name, onStreet = "", geometry,
                          quantity, ways }) {
  const treatment = {
    id: `osm-t${id}`,
    type,
    status: "existing",
    tags: { source: "osm", osm_way: (ways || [id]).join(" ") },
  };
  if (quantity !== undefined) treatment.quantity = quantity;
  const why = explainTags(tags);
  return {
    id: `osm-w${id}`,
    name,
    on_street: onStreet,
    notes: [tags.description || "", why].filter(Boolean).join(" \u00b7 "),
    treatments: [treatment],
    geometry,
    tags: { source: "osm" },
  };
}

// Is this query going to be hard work for a shared service? Used by the UI to
// warn BEFORE the button, not to refuse — plenty of people have a legitimate
// reason to import a city, and the honest thing is to say what it costs.
export function isHeavy(bbox, { spots = false } = {}) {
  const sqkm = bboxAreaSqKm(bbox);
  return sqkm > HEAVY_AREA_SQKM || (spots && sqkm > HEAVY_AREA_SQKM / 3);
}

// A sleep that a cancel button can interrupt. Checking every second rather
// than one long timer is what makes "waiting 4 minutes for a slot" abortable.
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (signal && signal.aborted) {
        const e = new Error("aborted");
        e.name = "AbortError";
        return reject(e);
      }
      if (Date.now() - started >= ms) return resolve();
      setTimeout(tick, Math.min(1000, ms - (Date.now() - started)));
    };
    tick();
  });
}

export class OverpassError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "OverpassError";
    this.retryable = retryable;
  }
}

// One session's worth of Overpass access. The throttle and the cache live on
// the instance so the app holds exactly one and every path shares its limits.
export class OverpassSession {
  constructor({ url = DEFAULT_ENDPOINT, fetchImpl, now = () => Date.now(),
                sleep = defaultSleep, cache = null } = {}) {
    this.url = url || DEFAULT_ENDPOINT;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.now = now;
    this.sleep = sleep;
    // Something with async getItem/setItem. Optional: without it the memory
    // cache still works for the life of the page.
    this.store = cache;
    // null, not 0: `if (this.lastAt)` would treat a first request at t=0 as
    // "never sent" forever. Real clocks never return 0, which is exactly the
    // kind of bug that survives until someone injects a fake one.
    this.lastAt = null;
    this.cache = new Map();       // area id -> elements
  }

  async readCache(key) {
    if (!this.store) return null;
    try {
      const raw = await this.store.getItem(key);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      if (!doc || !Array.isArray(doc.elements)) return null;
      if (this.now() - Number(doc.at || 0) > CACHE_MAX_AGE_MS) return null;
      return doc.elements;
    } catch { return null; }      // a bad cache entry is not an error
  }

  async writeCache(key, elements) {
    if (!this.store) return;
    try {
      await this.store.setItem(key,
        JSON.stringify({ at: this.now(), elements }));
    } catch { /* out of quota: the import still worked */ }
  }

  // Where the service publishes its slot availability.
  statusUrl() {
    return this.url.replace(/\/interpreter\/?$/, "/status");
  }

  // Ask how busy the service is, and wait for a slot rather than firing into a
  // queue that is already full. Entirely advisory: a status endpoint that is
  // missing, unreachable or in an unfamiliar format must never block an import.
  //
  // It waits for however long the service says, however long that is. That
  // looks like the impatient choice to cap it and hand back an error, but the
  // opposite is true: waiting costs the service NOTHING (one status read, then
  // a timer), while an error puts a button in front of a person who will press
  // it again. The wait is cancellable, which is the affordance that actually
  // belongs here.
  async waitForSlot({ signal, onWait } = {}) {
    let text;
    try {
      const res = await this.fetchImpl(this.statusUrl(), { signal });
      if (!res.ok) return null;
      text = await res.text();
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return null;
    }
    const secs = slotWaitSeconds(text);
    if (secs === null || secs <= 0) return secs;
    if (onWait) onWait(secs);
    await this.sleep(secs * 1000 + 500, signal);
    return secs;
  }

  // Raw query, throttled. Callers never get to skip the wait.
  async run(query, { signal, onWait } = {}) {
    if (this.lastAt !== null) {
      const since = this.now() - this.lastAt;
      if (since < MIN_INTERVAL_MS) await this.sleep(MIN_INTERVAL_MS - since);
    }
    await this.waitForSlot({ signal, onWait });
    this.lastAt = this.now();
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new OverpassError(`Couldn't reach ${this.url}.`);
    }
    if (res.status === 429 || res.status === 504) {
      // Deliberately NOT retried. Overpass returns these when it is already
      // under load; a client that retries is the reason it is under load. Say
      // HOW LONG when the service tells us, so "try again" is actionable.
      const after = Number(res.headers && res.headers.get
        ? res.headers.get("Retry-After") : null);
      const when = Number.isFinite(after) && after > 0
        ? `Try again in about ${after} seconds.`
        : "Wait a minute and try again.";
      throw new OverpassError(
        `OpenStreetMap's query service is busy right now. ${when} This tool `
        + "won't retry on its own. Large areas hit this sooner, and importing "
        + "a whole city may need tools/fetch_existing_infra.py or your own "
        + "Overpass endpoint.", { retryable: true });
    }
    if (!res.ok) throw new OverpassError(`Query service returned ${res.status}.`);
    return res.json();
  }

  // Everything OSM knows about bikes inside one area, cached per area.
  //
  // The cache is the politest thing in this file. A user who imports Boston,
  // reloads, and imports again should cost the service one query, not two —
  // and after a failed multi-area run, the areas that DID come back must not
  // be fetched a second time.
  async elementsForArea(area, { signal, spots = false, onWait } = {}) {
    const key = `osm:${area.id || area.name || ""}:${spots ? "spots" : "paths"}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const stored = await this.readCache(key);
    if (stored) { this.cache.set(key, stored); return stored; }
    const bbox = bboxOfBoundary(area.boundary);
    if (!bbox) {
      throw new OverpassError(
        `${area.name || "That area"} has no outline, so there is nothing to `
        + "look inside. Add its boundary first.");
    }
    const sqkm = bboxAreaSqKm(bbox);
    if (sqkm > MAX_AREA_SQKM) {
      throw new OverpassError(
        `${area.name || "That area"} covers about ${Math.round(sqkm)} km², `
        + `which is past the ${MAX_AREA_SQKM} km² limit for a live query. `
        + "Import its towns separately, or use tools/fetch_existing_infra.py.");
    }
    const doc = await this.run(overpassQuery(bbox, { spots }),
                               { signal, onWait });
    const elements = (doc && doc.elements) || [];
    this.cache.set(key, elements);
    await this.writeCache(key, elements);
    return elements;
  }
}
