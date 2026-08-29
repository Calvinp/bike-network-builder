// The static app's replacement for editor.py's Flask API: the same state
// shapes, but persistence is localStorage and the seed/boundary/graph files
// are fetched as static assets. Injectable seams (storage, fetchText,
// fetchJson) keep it unit-testable offline in Node.
import "./migrate.js";                 // installs the v1 -> v2 upgrader
import { featuresFromGeojson, featuresToGeojson } from "./geojson.js";
import {
  AUTHORITY_LEVELS, SIDE_VALUES, STATUSES, TRAVEL, makeNetwork, makePhase,
  parseNetwork, serializeNetwork, validateNetwork,
} from "./network_format.js";
import { boundaryFromWays } from "./boundary.js";
import { parsePlace } from "./place.js";
import { Registry, setRegistry } from "./registry.js";
import { COLOR_MODES } from "./render_common.js";
import { graphFromJson } from "./routing.js";
import { GraphIndex, emptyGraph, mergeGraphs, tileKey, tileUrl,
         tilesForBbox } from "./graph.js";
import { zipRead } from "./zip.js";

export { COLOR_MODES };
const LS_KEY = "bike-network-builder/network.yaml";

// Do two [south, west, north, east] boxes touch at all?
export function boxesOverlap(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// What the UI needs about the network besides its features: the areas it
// covers, who builds things, and the phase plan.
export function configForBrowser(net) {
  return {
    areas: net.areas.map((a) => ({ id: a.id, name: a.name, kind: a.kind,
                                   context: a.context,
                                   default_authority: a.default_authority })),
    authorities: net.authorities.map((a) => ({ id: a.id, name: a.name,
                                               level: a.level, note: a.note })),
    phases: [...net.phases].sort((a, b) => a.number - b.number)
      .map((p) => ({ id: p.id, number: p.number, label: p.label,
                     target_date: p.target_date })),
    units: net.units,
    costs: net.costs,
    meta: net.meta,
  };
}

// Merge the browser's payload into a network object, keeping anything the UI
// doesn't edit (meta, unknown top-level keys such as ordinance_chapter) from
// the stored one.
export function networkFromBrowser(data, existing) {
  const cfg = data.config || {};
  const phases = (cfg.phases || []).map((p, i) => makePhase({
    id: p.id || `p-${i + 1}`,
    number: Number.isFinite(Number(p.number)) ? Number(p.number) : i + 1,
    label: p.label ?? "",
    target_date: p.target_date ?? "",
    tags: p.tags || {},
  }));
  return makeNetwork({
    areas: cfg.areas ? cfg.areas.map((a) => {
      // Boundaries aren't EDITED in the UI, but they do arrive there — adopted
      // from the deployment on first load, or carried in by an import — so a
      // supplied one wins and the stored one is only a fallback. Taking the
      // stored one unconditionally silently discarded both.
      const stored = existing.area(a.id);
      const boundary = (a.boundary && a.boundary.length)
        ? a.boundary : ((stored && stored.boundary) || []);
      return { ...(stored || {}), ...a, boundary };
    }) : existing.areas,
    authorities: cfg.authorities || existing.authorities,
    phases: phases.length ? phases : existing.phases,
    features: featuresFromGeojson(data.network || {}),
    meta: cfg.meta || existing.meta,
    costs: cfg.costs || existing.costs,
    units: cfg.units || existing.units,
    crs: existing.crs,
    extra: existing.extra,
  });
}

const defaultFetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};

export class Store {
  constructor({ storage, fetchText, assetBase = "", tileCache } = {}) {
    this.storage = storage ?? globalThis.localStorage;
    this.fetchText = fetchText ?? defaultFetchText;
    this.assetBase = assetBase;
    this._place = null;           // the deployment's default area
    this._registry = null;        // the treatment registry
    this._boundaryRings = null;   // raw ways, for drawing
    this._boundary = null;        // assembled multipolygon, for clipping
    this._graph = null;           // {adj, coord} street graph, for snapping
    this._index = null;           // spatial index over it
    this._tiles = new Set();      // tile keys already merged in
    this.tileCache = tileCache ?? new Map();
  }

  asset(name) { return this.assetBase + name; }

  // The deployment's place — read once, and the source of every asset path
  // below. A deployment with no place.json still works; it simply ships
  // nothing, which the callers all treat as a normal state.
  async place() {
    if (!this._place) {
      try {
        this._place = parsePlace(JSON.parse(
          await this.fetchText(this.asset("data/place.json"))));
      } catch {
        this._place = parsePlace({});
      }
    }
    return this._place;
  }

  // Fetch an asset named by the place, or null when it ships none.
  async placeAsset(key) {
    const rel = (await this.place()).asset(key);
    return rel ? this.fetchText(this.asset(rel)) : null;
  }

  // Load the editable network, seeding a fresh browser from whatever seed the
  // deployment configures. A deployment that ships no seed starts EMPTY —
  // that's the v2 convention (V2_PLAN.md §7): the repo carries no network
  // data, a deployment may configure some, and the user never has to import
  // anything to get started.
  async loadNetwork() {
    let text = this.storage.getItem(LS_KEY);
    if (!text) {
      text = await this.placeAsset("seed_network") ?? "";
      if (text) this.storage.setItem(LS_KEY, text);
    }
    return parseNetwork(text);
  }

  // The raw boundary ways, for drawing the outline. [] when the deployment
  // ships no boundary — the app then draws and clips nothing, which is a
  // legitimate state for a place that hasn't picked an area yet.
  async boundaryRings() {
    if (!this._boundaryRings) {
      const text = await this.placeAsset("boundary");
      const fc = text ? JSON.parse(text) : { features: [] };
      const rings = [];
      for (const feat of fc.features || []) {
        const coords = feat.geometry?.coordinates || [];
        const ring = coords.map(([lon, lat]) => [lat, lon]);
        if (ring.length >= 2) rings.push(ring);
      }
      this._boundaryRings = rings;
    }
    return this._boundaryRings;
  }

  // The clip boundary as a multipolygon, assembled from the raw ways at
  // runtime. v1 fetched a ring precomputed by shapely; boundary.js does the
  // polygonizing now, so there is no second file to keep in step and OSM
  // boundary relations (which also arrive as ways) work by the same path.
  async boundary() {
    if (!this._boundary) {
      this._boundary = boundaryFromWays(await this.boundaryRings());
    }
    return this._boundary;
  }

  // ---- snap-to-road data ------------------------------------------------
  //
  // Three ways a deployment can supply streets, in the order they are tried:
  //
  //   1. TILES (`street_tiles`) — a URL template for static roads tiles on
  //      storage we control. Fetched for the current view and merged into
  //      whatever is already loaded, so the graph grows to fit where you draw
  //      instead of being shipped whole. Static files cannot be DDoSed by our
  //      own users the way a query API can (V2_PLAN.md §8.2).
  //   2. A BUNDLED GRAPH (`street_graph`) — today's Malden asset. Instant,
  //      fully offline, and the reason the test suite needs no network.
  //   3. NOTHING — snapping is simply unavailable, and a click behaves exactly
  //      like today's off-street click. That is a legitimate state, not an
  //      error (V2_PLAN.md §8.4).
  //
  // The browser NEVER calls a public Overpass instance for any of this.
  // Overpass is a batch tool: build.py and fetch_layers.py, where volume is
  // bounded and a human is present (V2_PLAN.md §8.5).

  async streetGraph() {
    if (!this._graph) {
      const text = await this.placeAsset("street_graph");
      if (!text) return null;
      this._graph = graphFromJson(JSON.parse(text));
      this._index = new GraphIndex(this._graph);
    }
    return this._graph;
  }

  // The graph covering `bbox` ([south, west, north, east]), loading any tiles
  // it needs. Returns {graph, index} or null when this deployment ships no
  // street data at all.
  async streetGraphFor(bbox) {
    const place = await this.place();
    const template = place.asset("street_tiles");
    if (!template) {
      const graph = await this.streetGraph();
      return graph ? { graph, index: this._index } : null;
    }
    const zoom = Number(place.tileZoom) || 14;
    if (!this._graph) this._graph = emptyGraph();

    let added = false;
    for (const tile of tilesForBbox(bbox, zoom)) {
      const key = tileKey(tile);
      if (this._tiles.has(key)) continue;
      this._tiles.add(key);            // marked before the await: a failed
                                       // tile is not retried on every pan
      const raw = await this.loadTile(template, tile);
      if (!raw) continue;
      mergeGraphs(this._graph, graphFromJson(raw));
      added = true;
    }
    // The index is rebuilt only when something actually arrived; panning over
    // ground already loaded costs nothing.
    if (added || !this._index) this._index = new GraphIndex(this._graph);
    return this._graph.coord.size ? { graph: this._graph, index: this._index } : null;
  }

  // One tile, from the cache if it is there. The cache is injectable so tests
  // stay offline; in a browser it is backed by IndexedDB, which is what makes
  // an area keep working after the network goes away.
  async loadTile(template, tile) {
    const key = tileKey(tile);
    const cached = await this.tileCache.get(key);
    if (cached) return cached;
    try {
      const raw = JSON.parse(await this.fetchText(this.asset(tileUrl(template, tile))));
      await this.tileCache.set(key, raw);
      return raw;
    } catch {
      return null;      // a missing tile is ordinary: not every tile exists
    }
  }

  // The treatment registry, installed globally so every renderer can read it
  // synchronously. A deployment that ships none gets an empty registry, which
  // means every treatment reads as unknown — degraded, but not broken.
  async registry() {
    if (!this._registry) {
      let doc = {};
      try {
        doc = JSON.parse(await this.placeAsset("treatments"));
      } catch { doc = {}; }
      this._registry = setRegistry(Registry.fromDoc(doc));
    }
    return this._registry;
  }

  // Everything the UI needs to paint itself once.
  async state() {
    const net = await this.loadNetwork();
    const reg = await this.registry();
    return {
      network: featuresToGeojson(net.features),
      config: configForBrowser(net),
      place: await this.place(),
      boundary: await this.boundaryRings(),
      options: {
        treatments: reg.all().map((t) => ({
          id: t.id, label: t.label, category: t.category, measure: t.measure,
          unit: t.unit, geometry: t.geometry, color: t.color, glyph: t.glyph,
        })),
        statuses: [...STATUSES],
        authority_levels: [...AUTHORITY_LEVELS],
        travel: [...TRAVEL],
        sides: [1, 2],
        side_values: [...SIDE_VALUES],
        color_modes: [...COLOR_MODES],
        unknown_types: net.unknownTreatmentTypes(reg),
      },
    };
  }

  // POST /api/state equivalent. Synchronous once the current network is in
  // hand — autosave can't be interrupted by a closing tab.
  async save(data) {
    if (data.network === null || data.network === undefined) return { ok: true };
    const net = networkFromBrowser(data, await this.loadNetwork());
    this.storage.setItem(LS_KEY, serializeNetwork(net));
    return { ok: true };
  }

  // Last-ditch synchronous save for pagehide/visibilitychange: no awaits, so
  // it completes even while the tab is being torn down. `existing` is the
  // caller's cached parse of the stored network (for the fields the UI
  // doesn't edit); required because reading it here could need a fetch.
  saveSync(data, existing) {
    if (data.network === null || data.network === undefined) return;
    this.storage.setItem(LS_KEY, serializeNetwork(networkFromBrowser(data, existing)));
  }

  // Serialized current network (for the YAML export / the bundle).
  async exportYamlText() {
    return serializeNetwork(await this.loadNetwork());
  }

  // POST /api/import equivalent: validate an uploaded network.yaml — or a
  // .zip bundle containing one — and return it as browser state. Nothing is
  // stored — the user reviews the import and then autosave persists it.
  async importBytes(bytes) {
    let net;
    try {
      let text;
      if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B
          && bytes[2] === 0x03 && bytes[3] === 0x04) {
        const entries = await zipRead(bytes);
        const yamls = entries.filter((e) => /\.ya?ml$/i.test(e.name));
        if (!yamls.length) {
          return { ok: false,
                   errors: ["The zip file doesn't contain a .yaml network file."] };
        }
        const named = yamls.find((e) => e.name.split("/").pop() === "network.yaml");
        text = (named || yamls[0]).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      net = parseNetwork(text);
    } catch (e) {
      return { ok: false, errors: [`Not parseable as YAML: ${e.message}`] };
    }
    const errors = validateNetwork(net);
    if (errors.length) return { ok: false, errors };
    return { ok: true,
             // The parsed network itself, so an import can be MERGED rather
             // than only replacing (see merge.js).
             parsed: net,
             network: featuresToGeojson(net.features),
             config: configForBrowser(net),
             // A v1 file whose phase deadlines didn't parse: the ONE place the
             // upgrade has to ask a human (V2_PLAN.md §4.10).
             needsDates: net.phases.filter((p) => p.tags && p.tags.deadline_v1)
               .map((p) => ({ id: p.id, number: p.number, label: p.label,
                              text: p.tags.deadline_v1 })),
             unknownTypes: net.unknownTreatmentTypes() };
  }

  // The context ("map layers") manifest, or [] when the deployment ships
  // none. Layer data itself is fetched lazily, only once a layer is toggled.
  async layersManifest() {
    if (this._layers === undefined) {
      try {
        const doc = JSON.parse(await this.placeAsset("layers"));
        this._layers = (doc.layers || []).filter((l) => l.id);
      } catch {
        this._layers = [];      // no layers installed — the card stays hidden
      }
    }
    return this._layers;
  }

  // The layers that have something to say about this deployment's area.
  //
  // A layer declares an `extent`; one that misses the area is hidden rather
  // than shown empty. MassDOT crash data is meaningless outside Massachusetts,
  // and a layer list full of empty entries is worse than a short one. A layer
  // with no declared extent is always offered — we can't prove it's irrelevant.
  async layersForArea() {
    const entries = await this.layersManifest();
    const ways = await this.boundaryRings();
    if (!ways.length) return entries;
    const lats = ways.flat().map((p) => p[0]);
    const lons = ways.flat().map((p) => p[1]);
    const area = [Math.min(...lats), Math.min(...lons),
                  Math.max(...lats), Math.max(...lons)];
    return entries.filter((e) => !e.extent || boxesOverlap(area, e.extent));
  }

  // Layer data sits beside its manifest, wherever the place put it.
  async layerGeojson(id) {
    const manifest = (await this.place()).asset("layers") || "data/layers/layers.json";
    const dir = manifest.slice(0, manifest.lastIndexOf("/") + 1);
    return JSON.parse(await this.fetchText(this.asset(`${dir}${id}.geojson`)));
  }
}
