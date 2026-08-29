// The street graph: a spatial index over it, and the tile arithmetic for
// loading it a window at a time.
//
// ## Why an index
//
// `nearestNode` used to linear-scan every node and `nearRoad` every edge, once
// per waypoint. Malden alone is 30,516 nodes — already borderline, and hopeless
// the moment the graph covers more than one town. A uniform grid keyed on
// rounded lat/lon turns both into a look at a handful of cells (V2_PLAN.md
// §8.8: needed regardless of where the graph comes from).
//
// ## Why tiles
//
// Malden's graph is 3.9 MB for 5.1 sq mi — about 0.77 MB per square mile, so
// Boston metro would be ~3.6 GB and the US ~3 TB. There is no version of
// "ship the graph" that survives (V2_PLAN.md §8.1). But snapping only ever
// needs the streets around the click: a local window, not a country.
//
// So the graph arrives as TILES, fetched for the current view and merged into
// whatever is already loaded. Tiles are STATIC FILES on storage we control —
// which cannot be DDoSed by our own users the way a query API can, because
// there is no query, just cacheable bytes with a flat cost curve.
//
// **The browser never calls a public Overpass instance** (V2_PLAN.md §8.5).
// Overpass is a batch tool: build.py and fetch_layers.py, where volume is
// bounded and a human is present.

const DEG = Math.PI / 180;

// Grid cell size in degrees. ~0.005 deg is roughly 500 m of latitude, so a
// 30 m snap radius never needs more than the 3x3 block around a point, and a
// city-sized graph lands in a few thousand cells rather than one.
export const CELL = 0.005;

const cellKey = (lat, lon) =>
  `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

/**
 * A spatial index over a {adj, coord} graph.
 *
 * Nodes and edges are bucketed by grid cell; an edge goes in every cell its
 * bounding box touches, so a long straight street is findable from anywhere
 * along it. That matters because OSM ways carry only shape vertices: a
 * mid-block click on a straight street can be far from every NODE while
 * sitting exactly ON the road.
 */
export class GraphIndex {
  constructor(graph) {
    this.graph = graph;
    this.nodeCells = new Map();   // cell -> [nodeId, ...]
    this.edgeCells = new Map();   // cell -> [[a, b], ...]
    this._indexNodes();
    this._indexEdges();
  }

  _push(map, key, value) {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
  }

  _indexNodes() {
    for (const [id, [lat, lon]] of this.graph.coord) {
      this._push(this.nodeCells, cellKey(lat, lon), id);
    }
  }

  _indexEdges() {
    const seen = new Set();
    for (const [a, nbrs] of this.graph.adj) {
      for (const [b] of nbrs) {
        if (a >= b) continue;                    // each edge once
        const key = `${a},${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = this.graph.coord.get(a);
        const pb = this.graph.coord.get(b);
        if (!pa || !pb) continue;
        const lat0 = Math.min(pa[0], pb[0]), lat1 = Math.max(pa[0], pb[0]);
        const lon0 = Math.min(pa[1], pb[1]), lon1 = Math.max(pa[1], pb[1]);
        for (let y = Math.floor(lat0 / CELL); y <= Math.floor(lat1 / CELL); y++) {
          for (let x = Math.floor(lon0 / CELL); x <= Math.floor(lon1 / CELL); x++) {
            this._push(this.edgeCells, `${y}:${x}`, [a, b]);
          }
        }
      }
    }
  }

  // Cell keys within `pad` degrees of a point.
  _around(lat, lon, pad) {
    const keys = [];
    const y0 = Math.floor((lat - pad) / CELL), y1 = Math.floor((lat + pad) / CELL);
    const x0 = Math.floor((lon - pad) / CELL), x1 = Math.floor((lon + pad) / CELL);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(`${y}:${x}`);
    return keys;
  }

  // Candidate node ids near a point, widening the search until something turns
  // up (a sparse rural graph may have nothing in the first ring).
  nodesNear(lat, lon, pad = CELL) {
    for (let p = pad; p <= CELL * 64; p *= 2) {
      const out = [];
      for (const key of this._around(lat, lon, p)) {
        const bucket = this.nodeCells.get(key);
        if (bucket) out.push(...bucket);
      }
      if (out.length) return out;
    }
    return [];
  }

  edgesNear(lat, lon, pad = CELL) {
    const out = [];
    const seen = new Set();
    for (const key of this._around(lat, lon, pad)) {
      for (const e of this.edgeCells.get(key) || []) {
        const k = `${e[0]},${e[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
      }
    }
    return out;
  }

  get size() { return this.graph.coord.size; }
}

// --------------------------------------------------------------------------
// Merging
// --------------------------------------------------------------------------
// Tiles overlap at their edges and share node ids (they come from the same OSM
// ids), so merging is a union: later tiles fill in neighbours the earlier ones
// only saw half of. That is what stitches a route across a tile boundary.
export function mergeGraphs(into, from) {
  for (const [id, pt] of from.coord) if (!into.coord.has(id)) into.coord.set(id, pt);
  for (const [id, nbrs] of from.adj) {
    const existing = into.adj.get(id);
    if (!existing) { into.adj.set(id, [...nbrs]); continue; }
    const known = new Set(existing.map(([n]) => n));
    for (const pair of nbrs) if (!known.has(pair[0])) existing.push(pair);
  }
  return into;
}

export const emptyGraph = () => ({ adj: new Map(), coord: new Map() });

// --------------------------------------------------------------------------
// Tile arithmetic (slippy-map XYZ, the scheme every tiler already speaks)
// --------------------------------------------------------------------------
export function tileForPoint(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = lat * DEG;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

// Every tile covering a [south, west, north, east] box.
export function tilesForBbox(bbox, z, max = 64) {
  const [south, west, north, east] = bbox;
  const a = tileForPoint(north, west, z);
  const b = tileForPoint(south, east, z);
  const out = [];
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
      out.push({ z, x, y });
      // A cap, so zooming out to the whole country asks for a handful of
      // tiles and gives up rather than trying to fetch a continent.
      if (out.length >= max) return out;
    }
  }
  return out;
}

export const tileKey = (t) => `${t.z}/${t.x}/${t.y}`;

export function tileUrl(template, t) {
  return String(template)
    .replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y);
}
