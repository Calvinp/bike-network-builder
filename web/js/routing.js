// Snap-to-road routing — port of bikenetwork/routing.py. Snap clicked points
// to the nearest road node and route along the street network between them
// (Dijkstra), so a drawn line follows real streets. The street graph ships as
// a static asset (web/data/street_graph.json), fetched lazily on first use.
import { haversineMiles, shortestPath } from "./geometry.js";

// Return the id of the graph node closest to (lat, lon).
export function nearestNode(coord, lat, lon) {
  let best = null, bestD = Infinity;
  for (const [nid, [nlat, nlon]] of coord) {
    const d = haversineMiles([lat, lon], [nlat, nlon]);
    if (d < bestD) { best = nid; bestD = d; }
  }
  return best;
}

// Distance from point p to segment a-b, all [lat, lon], in miles.
// Flat-earth projection (lon scaled by cos lat) — fine at city scale.
function pointSegMiles(p, a, b) {
  const scale = Math.cos((p[0] * Math.PI) / 180);
  const px = p[1] * scale, py = p[0];
  const ax = a[1] * scale, ay = a[0];
  const bx = b[1] * scale, by = b[0];
  const dx = bx - ax, dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = !denom ? 0.0
    : Math.max(0.0, Math.min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom));
  const cx = ax + t * dx, cy = ay + t * dy;
  return haversineMiles(p, [cy, cx / scale]);
}

// True if pt [lat, lon] is within maxMiles of any graph EDGE. Edges, not
// nodes: OSM ways only carry shape vertices, so a mid-block click on a long
// straight street can be far from every node while sitting ON the road.
function nearRoad(pt, edges, coord, maxMiles) {
  const lat = Number(pt[0]), lon = Number(pt[1]);
  // Quick reject: the point must fall inside the edge's bounding box padded
  // by the threshold (1 degree ~ 69 mi; padding is generous for longitude).
  const margin = (maxMiles / 69.0) * 1.5;
  for (const [a, b] of edges) {
    const [alat, alon] = coord.get(a);
    const [blat, blon] = coord.get(b);
    if (!(Math.min(alat, blat) - margin <= lat && lat <= Math.max(alat, blat) + margin)) continue;
    if (!(Math.min(alon, blon) - margin <= lon && lon <= Math.max(alon, blon) + margin)) continue;
    if (pointSegMiles([lat, lon], [alat, alon], [blat, blon]) <= maxMiles) return true;
  }
  return false;
}

// Route a polyline through `waypoints` (each [lat, lon]) along the street
// graph. Each consecutive pair is connected by the shortest on-street path; a
// pair with no connecting path falls back to a straight segment.
//
// A waypoint farther than `maxSnapMiles` (~30 m) from every road EDGE is
// treated as deliberately OFF-STREET (a park interior, a cut-through between
// buildings): its legs stay exactly where they were drawn. One drawn line can
// therefore mix snapped street sections with free-drawn off-street sections.
export function snapRoute(waypoints, adj, coord, maxSnapMiles = 0.02) {
  if (waypoints.length < 2) {
    return waypoints.map((w) => [Number(w[0]), Number(w[1])]);
  }

  const edges = [];
  for (const [a, nbrs] of adj) {
    for (const [b] of nbrs) if (a < b) edges.push([a, b]);
  }
  const nodes = waypoints.map((w) => (
    nearRoad(w, edges, coord, maxSnapMiles)
      ? nearestNode(coord, w[0], w[1])
      : null  // off-street click
  ));

  const out = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    let seg = null;
    if (a !== null && b !== null && a !== b) {
      const [pts] = shortestPath(adj, coord, a, b);
      if (pts) seg = pts.map(([la, lo]) => [Number(la), Number(lo)]);
    }
    if (!seg) {
      seg = [[Number(waypoints[i][0]), Number(waypoints[i][1])],
             [Number(waypoints[i + 1][0]), Number(waypoints[i + 1][1])]];
    }
    const last = out[out.length - 1];
    if (last && last[0] === seg[0][0] && last[1] === seg[0][1]) {
      out.push(...seg.slice(1));
    } else {
      out.push(...seg);
    }
  }
  return out;
}

// Parse the street-graph JSON asset ({coord: {id: [lat,lon]}, adj: {id:
// [[nbr, w], ...]}}) into the Maps the routing functions take.
export function graphFromJson(raw) {
  const coord = new Map(Object.entries(raw.coord)
    .map(([k, v]) => [parseInt(k, 10), [Number(v[0]), Number(v[1])]]));
  const adj = new Map(Object.entries(raw.adj)
    .map(([k, v]) => [parseInt(k, 10),
                      v.map(([n, w]) => [Math.trunc(Number(n)), Number(w)])]));
  return { adj, coord };
}
