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
//  * An in-session cache, so re-importing the same town costs nothing.
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

// Spacing between requests, enforced in the session rather than in the UI so
// no caller can skip it by wiring a button up differently.
export const MIN_INTERVAL_MS = 4000;

// Mirrors tools/fetch_existing_infra.py QUERY. A parity test pins them
// together, because two copies of a query that drift are two different tools.
export function overpassQuery(bbox) {
  const [s, w, n, e] = bbox.map((v) => Number(v).toFixed(6));
  const box = `${s},${w},${n},${e}`;
  return `[out:json][timeout:90];
(
  way["highway"="cycleway"](${box});
  way["highway"="path"]["bicycle"="designated"](${box});
  way["cycleway"~"lane|track|opposite_lane"](${box});
  way["cycleway:left"~"lane|track"](${box});
  way["cycleway:right"~"lane|track"](${box});
);
out geom;`;
}

// What OSM tagging maps onto which treatment. Deliberately CONSERVATIVE, and
// identical to the Python tool's TAG_RULES: an unprotected painted lane is
// recorded as `buffered_painted`, never as anything "separated", because
// calling paint protection is how a map starts lying about what exists.
export function treatmentFor(tags = {}) {
  const t = tags || {};
  if (t.highway === "cycleway") return "shared_use_path";
  if (t.highway === "path" && t.bicycle === "designated") return "shared_use_path";
  if (t.cycleway === "track" || t["cycleway:left"] === "track"
      || t["cycleway:right"] === "track") return "concrete_separated";
  if (t.cycleway === "lane" || t.cycleway === "opposite_lane"
      || t["cycleway:left"] === "lane" || t["cycleway:right"] === "lane") {
    return "buffered_painted";
  }
  return null;
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

// Overpass ways -> plain feature objects, ready for makeFeature(). Keeps a way
// with ANY point inside the area; the importer clips properly afterwards.
export function featuresFromOverpass(result, boundary, pointInBoundary) {
  const out = [];
  for (const el of (result && result.elements) || []) {
    if (el.type !== "way") continue;
    const pts = (el.geometry || [])
      .filter((g) => g && typeof g.lat === "number" && typeof g.lon === "number")
      .map((g) => [g.lat, g.lon]);
    if (pts.length < 2) continue;
    if (boundary && boundary.length && pointInBoundary
        && !pts.some(([lat, lon]) => pointInBoundary(lat, lon, boundary))) {
      continue;
    }
    const tags = el.tags || {};
    const type = treatmentFor(tags);
    if (!type) continue;
    const wid = String(el.id ?? out.length + 1);
    out.push({
      id: `osm-w${wid}`,
      name: tags.name || tags.ref || `Unnamed path ${wid}`,
      on_street: tags.name || "",
      notes: tags.description || "",
      treatments: [{
        id: `osm-t${wid}`,
        type,
        status: "existing",
        tags: { source: "osm", osm_way: wid },
      }],
      geometry: [pts],
      tags: { source: "osm" },
    });
  }
  return out;
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
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.url = url || DEFAULT_ENDPOINT;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.now = now;
    this.sleep = sleep;
    // null, not 0: `if (this.lastAt)` would treat a first request at t=0 as
    // "never sent" forever. Real clocks never return 0, which is exactly the
    // kind of bug that survives until someone injects a fake one.
    this.lastAt = null;
    this.cache = new Map();       // area id -> elements
  }

  // Raw query, throttled. Callers never get to skip the wait.
  async run(query, { signal } = {}) {
    if (this.lastAt !== null) {
      const since = this.now() - this.lastAt;
      if (since < MIN_INTERVAL_MS) await this.sleep(MIN_INTERVAL_MS - since);
    }
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
      // under load; a client that retries is the reason it is under load.
      throw new OverpassError(
        "OpenStreetMap's query service is busy right now. Wait a minute and "
        + "try again — this tool won't retry on its own.", { retryable: true });
    }
    if (!res.ok) throw new OverpassError(`Query service returned ${res.status}.`);
    return res.json();
  }

  // Everything OSM knows about bikes inside one area. Cached per area id.
  async elementsForArea(area, { signal } = {}) {
    const key = String(area.id || area.name || "");
    if (this.cache.has(key)) return this.cache.get(key);
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
    const doc = await this.run(overpassQuery(bbox), { signal });
    const elements = (doc && doc.elements) || [];
    this.cache.set(key, elements);
    return elements;
  }
}
