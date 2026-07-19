// The static app's replacement for editor.py's Flask API: the same state
// shapes, but persistence is localStorage and the seed/boundary/graph files
// are fetched as static assets. Injectable seams (storage, fetchText,
// fetchJson) keep it unit-testable offline in Node.
import { COST_PER_MILE } from "./costs.js";
import { pathsFromGeojson, pathsToGeojson } from "./geojson.js";
import {
  JURISDICTIONS, PATH_TYPES, STATUSES, makeNetwork, makePhase,
  parseNetwork, serializeNetwork, validateNetwork,
} from "./network_format.js";
import { COLOR_MODES } from "./render_common.js";
import { graphFromJson } from "./routing.js";
import { zipRead } from "./zip.js";

export { COLOR_MODES };
const LS_KEY = "bike-network-builder/network.yaml";

export function configForBrowser(net) {
  return {
    city: net.city,
    phases: [...net.phases].sort((a, b) => a.number - b.number)
      .map((p) => ({ phase: p.number, label: p.label, deadline: p.deadline })),
  };
}

// Merge the browser's network + config payload into a network object, keeping
// fields the UI doesn't edit (state, ordinance_chapter) from the stored one.
export function networkFromBrowser(data, existing) {
  const cfg = data.config || {};
  const phases = [];
  for (const p of cfg.phases || []) {
    const num = parseInt(p.phase, 10);
    if (Number.isNaN(num)) continue;
    phases.push(makePhase(num, p.label ?? `Phase ${num}`, p.deadline ?? ""));
  }
  return makeNetwork({
    city: cfg.city ?? existing.city,
    state: existing.state,
    ordinance_chapter: existing.ordinance_chapter,
    phases: phases.length ? phases : existing.phases,
    paths: pathsFromGeojson(data.network || {}),
  });
}

const defaultFetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
};

export class Store {
  constructor({ storage, fetchText, assetBase = "" } = {}) {
    this.storage = storage ?? globalThis.localStorage;
    this.fetchText = fetchText ?? defaultFetchText;
    this.assetBase = assetBase;
    this._boundaryRings = null;   // raw ways, for drawing
    this._boundaryRing = null;    // precomputed polygon ring, for clipping
    this._graph = null;           // {adj, coord} street graph, for snapping
  }

  asset(name) { return this.assetBase + name; }

  // Load the editable network, seeding a fresh browser from the checked-in
  // existing+funded base network (mirrors editor.py load_network()).
  async loadNetwork() {
    let text = this.storage.getItem(LS_KEY);
    if (!text) {
      text = await this.fetchText(this.asset("data/base_network.yaml"));
      this.storage.setItem(LS_KEY, text);
    }
    return parseNetwork(text);
  }

  async boundaryRings() {
    if (!this._boundaryRings) {
      const fc = JSON.parse(await this.fetchText(this.asset("data/malden_boundary.geojson")));
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

  async boundaryRing() {
    if (!this._boundaryRing) {
      this._boundaryRing = JSON.parse(
        await this.fetchText(this.asset("data/malden_boundary_polygon.json")));
    }
    return this._boundaryRing;
  }

  // The street graph is ~4 MB, fetched only when snapping is first used.
  async streetGraph() {
    if (!this._graph) {
      const raw = JSON.parse(await this.fetchText(this.asset("data/street_graph.json")));
      this._graph = graphFromJson(raw);
    }
    return this._graph;
  }

  // GET /api/state equivalent.
  async state() {
    const net = await this.loadNetwork();
    return {
      network: pathsToGeojson(net.paths),
      config: configForBrowser(net),
      boundary: await this.boundaryRings(),
      options: {
        types: [...PATH_TYPES],
        statuses: [...STATUSES],
        jurisdictions: [...JURISDICTIONS],
        color_modes: [...COLOR_MODES],
        cost_per_mile: Object.fromEntries(
          Object.entries(COST_PER_MILE).map(([k, v]) => [k, [...v]])),
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
    return { ok: true, network: pathsToGeojson(net.paths),
             config: configForBrowser(net) };
  }
}
