// Clip corridors to the city polygon, so the network (and the mileage/cost
// totals derived from it) only ever count street inside Malden. Port of
// bikenetwork/boundary.py with one difference: the Python tools polygonize the
// raw boundary ways with shapely at runtime; here the polygon arrives as a
// PRECOMPUTED closed ring (web/data/malden_boundary_polygon.json, written by
// tools/export_boundary_polygon.py — rerun it if the boundary data changes).
//
// Like shapely, clipping works in planar (x=lon, y=lat) coordinates — fine for
// containment/intersection at city scale. Lengths are still geodesic.
import { polylineMiles } from "./geometry.js";

const EPS = 1e-12;

function closedRing(ring) {
  const [a, z] = [ring[0], ring[ring.length - 1]];
  return (a[0] === z[0] && a[1] === z[1]) ? ring : [...ring, a];
}

// Ray-casting point-in-polygon test; `ring` is [[lat, lon], ...].
export function pointInRing(lat, lon, ring) {
  const r = closedRing(ring);
  let inside = false;
  for (let i = 0; i < r.length - 1; i++) {
    const [ay, ax] = r[i];      // y = lat, x = lon
    const [by, bx] = r[i + 1];
    if ((ay > lat) !== (by > lat)) {
      const x = ax + ((lat - ay) / (by - ay)) * (bx - ax);
      if (lon < x) inside = !inside;
    }
  }
  return inside;
}

// Parameter t in (0,1) where segment p->q crosses segment a->b, or null.
function segCrossT(p, q, a, b) {
  // All points are [lat, lon]; work in (x=lon, y=lat).
  const rX = q[1] - p[1], rY = q[0] - p[0];
  const sX = b[1] - a[1], sY = b[0] - a[0];
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < EPS) return null;    // parallel / degenerate
  const dX = a[1] - p[1], dY = a[0] - p[0];
  const t = (dX * sY - dY * sX) / denom;
  const u = (dX * rY - dY * rX) / denom;
  if (t <= EPS || t >= 1 - EPS || u < -EPS || u > 1 + EPS) return null;
  return t;
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

// Clip a [lat, lon] polyline to the polygon ring, returning the single longest
// in-boundary piece as [[lat, lon], ...] and its geodesic length in miles.
// Returns [[], 0.0] if nothing is inside.
export function clipPolylineLatlon(geom, ring) {
  if (!geom || geom.length < 2) return [[], 0.0];
  const r = closedRing(ring);

  // Walk the polyline, splitting each segment at every boundary crossing and
  // keeping the sub-pieces whose midpoints are inside; chain consecutive kept
  // sub-pieces into continuous pieces.
  const pieces = [];
  let current = null;
  const pushPoint = (pt, startsNew) => {
    if (startsNew || !current) {
      current = [pt];
      pieces.push(current);
    } else {
      const last = current[current.length - 1];
      if (Math.abs(last[0] - pt[0]) > EPS || Math.abs(last[1] - pt[1]) > EPS) {
        current.push(pt);
      }
    }
  };

  for (let i = 0; i < geom.length - 1; i++) {
    const p = geom[i], q = geom[i + 1];
    const ts = [0];
    for (let e = 0; e < r.length - 1; e++) {
      const t = segCrossT(p, q, r[e], r[e + 1]);
      if (t !== null) ts.push(t);
    }
    ts.push(1);
    ts.sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < EPS) continue;
      const mid = lerp(p, q, (t0 + t1) / 2);
      if (!pointInRing(mid[0], mid[1], r)) { current = null; continue; }
      const a = lerp(p, q, t0), b = lerp(p, q, t1);
      const startsNew = !current
        || Math.abs(current[current.length - 1][0] - a[0]) > 1e-9
        || Math.abs(current[current.length - 1][1] - a[1]) > 1e-9;
      pushPoint(a, startsNew);
      pushPoint(b, false);
    }
  }

  let best = [], bestMiles = 0.0;
  for (const piece of pieces) {
    if (piece.length < 2) continue;
    const miles = polylineMiles(piece);
    if (miles > bestMiles) { best = piece; bestMiles = miles; }
  }
  return [best, bestMiles];
}

// Clip a multi-segment path (its `segments` value): each segment keeps its
// longest in-boundary piece; fully-outside segments are dropped.
// Returns [keptSegments, totalMiles].
export function clipSegmentsLatlon(segments, ring) {
  const kept = [];
  let total = 0.0;
  for (const seg of segments) {
    const [piece, miles] = clipPolylineLatlon(seg, ring);
    if (piece.length >= 2) {
      kept.push(piece);
      total += miles;
    }
  }
  return [kept, total];
}
