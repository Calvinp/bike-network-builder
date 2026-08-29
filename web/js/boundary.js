// Clip corridors to an area boundary, so the network (and the mileage/cost
// totals derived from it) only ever count street inside the areas the network
// covers.
//
// v2 replaces shapely entirely — there is no Python side to lean on any more:
//
//  * `ringsFromWays` does what shapely's polygonize did: chain raw boundary
//    ways into closed rings. OSM boundary relations arrive as member ways, so
//    this is needed at runtime; the precomputed ring file is gone.
//  * The boundary is a MULTIPOLYGON with holes — Census and OSM return those
//    routinely (islands, exclaves, and enclave towns that punch a hole in a
//    neighbour). A single ring was only ever enough for Malden.
//  * Clipping keeps EVERY in-boundary piece. v1 kept only the longest one per
//    segment, silently dropping mileage whenever a line left the boundary and
//    came back — invisible with Malden's outline, wrong with a hole or a
//    multi-area union.
//
// Like shapely, this works in planar (x=lon, y=lat) coordinates — fine for
// containment and intersection at city scale. Lengths are still geodesic.
import { polylineMiles } from "./geometry.js";

const EPS = 1e-12;
const JOIN_EPS = 1e-9;      // coordinate equality when chaining ways

function closedRing(ring) {
  const [a, z] = [ring[0], ring[ring.length - 1]];
  return (a[0] === z[0] && a[1] === z[1]) ? ring : [...ring, a];
}

const samePoint = (a, b) =>
  Math.abs(a[0] - b[0]) < JOIN_EPS && Math.abs(a[1] - b[1]) < JOIN_EPS;

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

// --------------------------------------------------------------------------
// Boundary shape
// --------------------------------------------------------------------------
// The internal representation is always a multipolygon:
//     [ polygon, ... ]  where  polygon = [ outerRing, hole, hole, ... ]
//     and                       ring    = [ [lat, lon], ... ]
//
// `normalizeBoundary` accepts a bare ring, a single polygon, or a multipolygon
// and returns the multipolygon form. It exists so callers at the edges (the
// store, the exporters) can hand over whatever they hold; everything inside
// this module assumes the normalized shape.
const isPoint = (v) => Array.isArray(v) && v.length === 2
  && typeof v[0] === "number" && typeof v[1] === "number";

export function normalizeBoundary(boundary) {
  if (!Array.isArray(boundary) || boundary.length === 0) return [];
  if (isPoint(boundary[0])) return [[boundary]];              // a bare ring
  if (Array.isArray(boundary[0]) && isPoint(boundary[0][0])) {
    return [boundary];                                        // one polygon
  }
  return boundary;                                            // multipolygon
}

// True if the point is inside any polygon's outer ring and not inside one of
// that polygon's holes.
export function pointInBoundary(lat, lon, boundary) {
  for (const poly of normalizeBoundary(boundary)) {
    if (!poly.length || !pointInRing(lat, lon, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(lat, lon, poly[h])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Ring assembly (the shapely polygonize replacement)
// --------------------------------------------------------------------------
// Chain open ways into closed rings by matching endpoints, reversing a way
// when it joins end-to-end. Ways that never close are dropped: a boundary made
// of dangling fragments is not an area, and silently hulling it (as the Python
// fallback did) over-includes territory without saying so.
export function ringsFromWays(ways) {
  const pool = (ways || [])
    .filter((w) => Array.isArray(w) && w.length >= 2)
    .map((w) => w.map((p) => [Number(p[0]), Number(p[1])]));
  const rings = [];

  while (pool.length) {
    let chain = pool.shift();
    if (samePoint(chain[0], chain[chain.length - 1]) && chain.length >= 4) {
      rings.push(chain);
      continue;
    }
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      const head = chain[0];
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i];
        const wHead = w[0], wTail = w[w.length - 1];
        let piece = null;
        if (samePoint(tail, wHead)) piece = w.slice(1);
        else if (samePoint(tail, wTail)) piece = w.slice(0, -1).reverse();
        if (piece) {
          chain = chain.concat(piece);
          pool.splice(i, 1);
          extended = true;
          break;
        }
        let front = null;
        if (samePoint(head, wTail)) front = w.slice(0, -1);
        else if (samePoint(head, wHead)) front = w.slice(1).reverse();
        if (front) {
          chain = front.concat(chain);
          pool.splice(i, 1);
          extended = true;
          break;
        }
      }
      if (!extended && samePoint(chain[0], chain[chain.length - 1])) break;
    }
    if (chain.length >= 4 && samePoint(chain[0], chain[chain.length - 1])) {
      rings.push(chain);
    }
  }
  return rings;
}

// Assemble a boundary (multipolygon) from raw ways. Rings that sit inside
// another ring become that polygon's holes; the rest are separate polygons.
export function boundaryFromWays(ways) {
  const rings = ringsFromWays(ways);
  if (!rings.length) return [];
  // Sort by |area| descending so a container is always seen before its holes.
  const withArea = rings.map((r) => ({ ring: r, area: Math.abs(ringArea(r)) }))
    .sort((a, b) => b.area - a.area);
  const polys = [];
  for (const { ring } of withArea) {
    const [lat, lon] = representativePoint(ring);
    const host = polys.find((p) => pointInRing(lat, lon, p[0]));
    if (host) host.push(ring);
    else polys.push([ring]);
  }
  return polys;
}

function ringArea(ring) {
  const r = closedRing(ring);
  let sum = 0;
  for (let i = 0; i < r.length - 1; i++) {
    sum += r[i][1] * r[i + 1][0] - r[i + 1][1] * r[i][0];
  }
  return sum / 2;
}

// A point guaranteed to lie on the ring itself — good enough to test which
// other ring contains it, since rings of a valid boundary never cross.
function representativePoint(ring) {
  return ring[0];
}

// --------------------------------------------------------------------------
// Clipping
// --------------------------------------------------------------------------
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

// Every ring of every polygon — crossings with holes split a line just as
// crossings with the outer edge do.
function allRings(boundary) {
  const rings = [];
  for (const poly of boundary) for (const ring of poly) rings.push(closedRing(ring));
  return rings;
}

// Clip a [lat, lon] polyline to the boundary, returning EVERY in-boundary
// piece as [[lat, lon], ...] plus the total geodesic length in miles.
// Returns [[], 0.0] if nothing is inside.
export function clipPolylineLatlon(geom, boundary) {
  const polys = normalizeBoundary(boundary);
  if (!geom || geom.length < 2 || !polys.length) return [[], 0.0];
  const rings = allRings(polys);

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
    for (const r of rings) {
      for (let e = 0; e < r.length - 1; e++) {
        const t = segCrossT(p, q, r[e], r[e + 1]);
        if (t !== null) ts.push(t);
      }
    }
    ts.push(1);
    ts.sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < EPS) continue;
      const mid = lerp(p, q, (t0 + t1) / 2);
      if (!pointInBoundary(mid[0], mid[1], polys)) { current = null; continue; }
      const a = lerp(p, q, t0), b = lerp(p, q, t1);
      const startsNew = !current
        || Math.abs(current[current.length - 1][0] - a[0]) > 1e-9
        || Math.abs(current[current.length - 1][1] - a[1]) > 1e-9;
      pushPoint(a, startsNew);
      pushPoint(b, false);
    }
  }

  const kept = [];
  let total = 0.0;
  for (const piece of pieces) {
    if (piece.length < 2) continue;
    kept.push(piece);
    total += polylineMiles(piece);
  }
  return [kept, total];
}

// The longest of a set of clipped pieces, or [] for none. Drawing aids (the
// snap preview) want one continuous line rather than the true clipped set;
// they call this so the choice is deliberate rather than hidden in the clipper.
export function longestPiece(pieces) {
  let best = [], bestMiles = -1;
  for (const piece of pieces || []) {
    if (!piece || piece.length < 2) continue;
    const miles = polylineMiles(piece);
    if (miles > bestMiles) { best = piece; bestMiles = miles; }
  }
  return best;
}

// Clip a multi-segment feature: each input segment contributes every one of
// its in-boundary pieces, so a segment interrupted by a hole or a border
// becomes several output segments. Returns [keptSegments, totalMiles].
export function clipSegmentsLatlon(segments, boundary) {
  const kept = [];
  let total = 0.0;
  for (const seg of segments) {
    const [pieces, miles] = clipPolylineLatlon(seg, boundary);
    for (const piece of pieces) if (piece.length >= 2) kept.push(piece);
    total += miles;
  }
  return [kept, total];
}
