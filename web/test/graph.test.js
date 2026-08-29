// The spatial index and the tile arithmetic behind snapping at scale.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CELL, GraphIndex, emptyGraph, mergeGraphs, tileForPoint, tileKey,
         tileUrl, tilesForBbox } from "../js/graph.js";
import { graphFromJson, nearestNode, snapRoute } from "../js/routing.js";

// A tiny grid of streets around (42.42, -71.06): nodes every 0.002 deg.
function toyGraph() {
  const coord = new Map();
  const adj = new Map();
  let id = 1;
  const at = new Map();
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const lat = 42.42 + i * 0.002, lon = -71.06 + j * 0.002;
      coord.set(id, [lat, lon]);
      at.set(`${i},${j}`, id);
      id += 1;
    }
  }
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push([b, 0.1]);
    adj.get(b).push([a, 0.1]);
  };
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (j < 4) link(at.get(`${i},${j}`), at.get(`${i},${j + 1}`));
      if (i < 4) link(at.get(`${i},${j}`), at.get(`${i + 1},${j}`));
    }
  }
  return { adj, coord };
}

// --------------------------------------------------------------------------
// The index
// --------------------------------------------------------------------------
test("nodesNear finds the nodes around a point", () => {
  const idx = new GraphIndex(toyGraph());
  const near = idx.nodesNear(42.42, -71.06);
  assert.ok(near.length > 0);
  assert.ok(near.length < idx.size, "should not just return everything");
});

test("nodesNear widens until it finds something, rather than giving up", () => {
  // A sparse graph may have nothing in the first ring; returning [] there
  // would make snapping fail in exactly the rural places it is most useful.
  const idx = new GraphIndex(toyGraph());
  assert.ok(idx.nodesNear(42.44, -71.04).length > 0);
});

test("an edge is findable from anywhere along it, not just near its ends", () => {
  // OSM ways carry only shape vertices, so a mid-block click on a long
  // straight street can be far from every NODE while sitting ON the road.
  const coord = new Map([[1, [42.42, -71.06]], [2, [42.42, -71.00]]]);
  const adj = new Map([[1, [[2, 3]]], [2, [[1, 3]]]]);
  const idx = new GraphIndex({ adj, coord });
  const mid = idx.edgesNear(42.42, -71.03);
  assert.equal(mid.length, 1);
});

test("the index returns each edge once", () => {
  const idx = new GraphIndex(toyGraph());
  const near = idx.edgesNear(42.424, -71.056, CELL * 4);
  const keys = near.map(([a, b]) => `${a},${b}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("the index agrees with a brute-force nearest-node search", () => {
  const g = toyGraph();
  const idx = new GraphIndex(g);
  for (const [lat, lon] of [[42.4231, -71.0589], [42.4262, -71.0533],
                            [42.4205, -71.0601], [42.4278, -71.0522]]) {
    const brute = nearestNode(g.coord, lat, lon);
    const viaIndex = nearestNode(g.coord, lat, lon, idx);
    assert.equal(viaIndex, brute, `disagreed at ${lat},${lon}`);
  }
});

test("the index agrees with brute force on the SHIPPED Malden graph", () => {
  // 30,516 nodes: the regression that matters, and the reason the index
  // exists at all.
  const raw = JSON.parse(readFileSync(
    new URL("../data/street_graph.json", import.meta.url), "utf8"));
  const g = graphFromJson(raw);
  const idx = new GraphIndex(g);
  assert.equal(idx.size, g.coord.size);
  for (const [lat, lon] of [[42.4251, -71.0662], [42.4300, -71.0700],
                            [42.4180, -71.0400], [42.4400, -71.0550]]) {
    assert.equal(nearestNode(g.coord, lat, lon, idx),
                 nearestNode(g.coord, lat, lon),
                 `disagreed at ${lat},${lon}`);
  }
});

test("snapping still works when an index is supplied", () => {
  const g = toyGraph();
  const idx = new GraphIndex(g);
  const pts = [[42.42, -71.06], [42.428, -71.052]];
  const withIdx = snapRoute(pts, g.adj, g.coord, 0.02, idx);
  const without = snapRoute(pts, g.adj, g.coord, 0.02);
  assert.deepEqual(withIdx, without);
  assert.ok(withIdx.length > 2, "should have followed the streets");
});

// --------------------------------------------------------------------------
// Merging tiles
// --------------------------------------------------------------------------
test("merging fills in neighbours a tile only saw half of", () => {
  // This is what stitches a route across a tile boundary.
  const west = { coord: new Map([[1, [42.42, -71.06]], [2, [42.42, -71.05]]]),
                 adj: new Map([[1, [[2, 1]]], [2, [[1, 1]]]]) };
  const east = { coord: new Map([[2, [42.42, -71.05]], [3, [42.42, -71.04]]]),
                 adj: new Map([[2, [[3, 1]]], [3, [[2, 1]]]]) };
  const merged = mergeGraphs(west, east);
  assert.equal(merged.coord.size, 3);
  assert.deepEqual(merged.adj.get(2).map(([n]) => n).sort(), [1, 3]);
});

test("merging the same tile twice changes nothing", () => {
  const g = toyGraph();
  const before = [...g.adj.get(1)].length;
  mergeGraphs(g, toyGraph());
  assert.equal(g.adj.get(1).length, before);
});

test("merging into an empty graph just adopts it", () => {
  const g = mergeGraphs(emptyGraph(), toyGraph());
  assert.equal(g.coord.size, 25);
});

// --------------------------------------------------------------------------
// Tile arithmetic
// --------------------------------------------------------------------------
test("tileForPoint lands on the standard slippy tile", () => {
  // Malden at z14 — the well-known scheme every tiler already speaks.
  const t = tileForPoint(42.4251, -71.0662, 14);
  assert.equal(t.z, 14);
  assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y));
  // A point just east is in the same or the next tile, never far away.
  const t2 = tileForPoint(42.4251, -71.0600, 14);
  assert.ok(Math.abs(t2.x - t.x) <= 1);
});

test("tilesForBbox covers the box", () => {
  const tiles = tilesForBbox([42.40, -71.10, 42.45, -71.02], 14);
  assert.ok(tiles.length >= 4);
  const keys = new Set(tiles.map(tileKey));
  assert.ok(keys.has(tileKey(tileForPoint(42.41, -71.09, 14))));
  assert.ok(keys.has(tileKey(tileForPoint(42.44, -71.03, 14))));
});

test("tilesForBbox is capped, so zooming out asks for a handful not a continent", () => {
  const whole = tilesForBbox([-60, -170, 70, 170], 14, 32);
  assert.equal(whole.length, 32);
});

test("tileUrl substitutes z/x/y", () => {
  assert.equal(tileUrl("roads/{z}/{x}/{y}.json", { z: 14, x: 4954, y: 6051 }),
               "roads/14/4954/6051.json");
});

// --------------------------------------------------------------------------
// The property the tile overlap exists for
// --------------------------------------------------------------------------
test("a route crosses a tile boundary once the tiles are merged", async () => {
  // Each tile carries the edge that leaves it, so merging two adjacent tiles
  // yields a connected graph. Without that overlap a route would stop dead at
  // every tile line.
  const { Store } = await import("../js/store.js");
  const { snapRoute } = await import("../js/routing.js");

  // West tile knows 1-2; east tile knows 2-3. Neither alone connects 1 to 3.
  const west = { coord: { 1: [42.42, -71.070], 2: [42.42, -71.060] },
                 adj: { 1: [[2, 0.5]], 2: [[1, 0.5]] } };
  const east = { coord: { 2: [42.42, -71.060], 3: [42.42, -71.050] },
                 adj: { 2: [[3, 0.5]], 3: [[2, 0.5]] } };
  let call = 0;
  const store = new Store({
    storage: { getItem: () => null, setItem: () => {} },
    fetchText: async (url) => {
      if (url.endsWith("place.json")) {
        return JSON.stringify({ name: "T",
          assets: { street_tiles: "roads/{z}/{x}/{y}.json" }, tile_zoom: 14 });
      }
      call += 1;
      return JSON.stringify(call === 1 ? west : east);
    },
  });
  const src = await store.streetGraphFor([42.415, -71.075, 42.425, -71.045]);
  assert.equal(src.graph.coord.size, 3, "both tiles merged");
  assert.deepEqual(src.graph.adj.get(2).map(([n]) => n).sort(), [1, 3]);

  const route = snapRoute([[42.42, -71.070], [42.42, -71.050]],
                          src.graph.adj, src.graph.coord, 0.02, src.index);
  assert.ok(route.length >= 3, "routed through the shared node, not straight");
});

test("a click far from any street stays where it was put", async () => {
  // The documented off-street behaviour: park interiors and cut-throughs are
  // deliberate, not failures to snap. (Rediscovered the hard way while
  // testing tiles — a point 76 m from a road correctly refused to snap.)
  const { snapRoute } = await import("../js/routing.js");
  const g = toyGraph();
  const idx = new GraphIndex(g);
  const far = [[42.50, -71.20], [42.51, -71.21]];
  const route = snapRoute(far, g.adj, g.coord, 0.02, idx);
  assert.deepEqual(route, far);
});
