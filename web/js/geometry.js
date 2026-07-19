// Pure geometry helpers: distances, bounding boxes, and shortest path along a
// street graph. Port of bikenetwork/geometry.py — same math, same names in
// camelCase. Coordinates are [lat, lon] pairs in degrees; graphs are Maps
// (node id -> value).
export const EARTH_RADIUS_MILES = 3958.7613;
export const WEB_MERCATOR_R = 6378137.0; // EPSG:3857 sphere radius (meters)

const rad = (deg) => (deg * Math.PI) / 180;

export function lonlatToMercator(lat, lon) {
  const x = WEB_MERCATOR_R * rad(lon);
  const y = WEB_MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));
  return [x, y];
}

export function haversineMiles(a, b) {
  const lat1 = rad(a[0]), lon1 = rad(a[1]);
  const lat2 = rad(b[0]), lon2 = rad(b[1]);
  const dlat = lat2 - lat1, dlon = lon2 - lon1;
  const h = Math.sin(dlat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

export function polylineMiles(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineMiles(points[i], points[i + 1]);
  }
  return total;
}

export function segmentsMiles(segments) {
  return segments.reduce((sum, seg) => sum + polylineMiles(seg), 0);
}

export function bboxOf(points, padDeg = 0.0) {
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return [Math.min(...lats) - padDeg, Math.min(...lons) - padDeg,
          Math.max(...lats) + padDeg, Math.max(...lons) + padDeg];
}

// A small binary min-heap of [priority, value] pairs (Python used heapq).
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Dijkstra shortest path between node ids src and dst.
// `adj` maps node id -> [[neighbor id, weight_miles], ...]; `coord` maps node
// id -> [lat, lon]. Returns [points, totalMiles] or [null, null].
export function shortestPath(adj, coord, src, dst) {
  const dist = new Map([[src, 0.0]]);
  const prev = new Map();
  const pq = new MinHeap();
  pq.push([0.0, src]);
  const visited = new Set();
  while (pq.size) {
    const [d, u] = pq.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === dst) break;
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
        pq.push([nd, v]);
      }
    }
  }
  if (!dist.has(dst)) return [null, null];
  const path = [dst];
  while (path[path.length - 1] !== src) path.push(prev.get(path[path.length - 1]));
  path.reverse();
  return [path.map((n) => coord.get(n)), dist.get(dst)];
}
