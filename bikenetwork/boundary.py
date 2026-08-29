"""Assemble an area polygon from raw boundary ways, and test containment.

Pure Python — no shapely. The web app is the only renderer now, so clipping and
mileage live in `web/js/boundary.js`; what remains on this side is what
`build.py` needs to prefer an in-area intersection when the same street names
cross in a neighbouring town.

This module is a deliberate mirror of the ring-assembly and containment halves
of `web/js/boundary.js` — same shapes, same rules — so the two implementations
keep each other honest.

Boundary shape (matching the JS side):

    boundary = [polygon, ...]
    polygon  = [outer_ring, hole, ...]
    ring     = [(lat, lon), ...]

Work is planar (x=lon, y=lat), which is fine for containment at city scale.
"""
from __future__ import annotations

from typing import List, Sequence, Tuple

Point = Tuple[float, float]
Ring = List[Point]

JOIN_EPS = 1e-9      # coordinate equality when chaining ways


def _same(a: Point, b: Point) -> bool:
    return abs(a[0] - b[0]) < JOIN_EPS and abs(a[1] - b[1]) < JOIN_EPS


def _closed(ring: Sequence[Point]) -> Ring:
    return list(ring) if _same(ring[0], ring[-1]) else [*ring, ring[0]]


def point_in_ring(lat: float, lon: float, ring: Sequence[Point]) -> bool:
    """Ray-casting containment for a single ring of (lat, lon) points."""
    r = _closed(ring)
    inside = False
    for i in range(len(r) - 1):
        ay, ax = r[i]
        by, bx = r[i + 1]
        if (ay > lat) != (by > lat):
            x = ax + ((lat - ay) / (by - ay)) * (bx - ax)
            if lon < x:
                inside = not inside
    return inside


def point_in_boundary(lat: float, lon: float, boundary) -> bool:
    """True inside any polygon's outer ring and outside that polygon's holes."""
    for poly in boundary or []:
        if not poly or not point_in_ring(lat, lon, poly[0]):
            continue
        if not any(point_in_ring(lat, lon, hole) for hole in poly[1:]):
            return True
    return False


def rings_from_ways(ways: Sequence[Sequence[Point]]) -> List[Ring]:
    """Chain open ways into closed rings, reversing one when it joins
    end-to-end. Ways that never close are dropped: a boundary of dangling
    fragments is not an area, and hulling it (as the old shapely fallback did)
    over-includes territory without saying so."""
    pool = [[(float(p[0]), float(p[1])) for p in w]
            for w in (ways or []) if w is not None and len(w) >= 2]
    rings: List[Ring] = []

    while pool:
        chain = pool.pop(0)
        if len(chain) >= 4 and _same(chain[0], chain[-1]):
            rings.append(chain)
            continue
        extended = True
        while extended:
            extended = False
            for i, w in enumerate(pool):
                if _same(chain[-1], w[0]):
                    chain = chain + w[1:]
                elif _same(chain[-1], w[-1]):
                    chain = chain + list(reversed(w[:-1]))
                elif _same(chain[0], w[-1]):
                    chain = w[:-1] + chain
                elif _same(chain[0], w[0]):
                    chain = list(reversed(w[1:])) + chain
                else:
                    continue
                pool.pop(i)
                extended = True
                break
            if not extended:
                break
            if _same(chain[0], chain[-1]):
                break
        if len(chain) >= 4 and _same(chain[0], chain[-1]):
            rings.append(chain)
    return rings


def _ring_area(ring: Sequence[Point]) -> float:
    r = _closed(ring)
    return sum(r[i][1] * r[i + 1][0] - r[i + 1][1] * r[i][0]
               for i in range(len(r) - 1)) / 2.0


def boundary_from_ways(ways: Sequence[Sequence[Point]]) -> List[List[Ring]]:
    """Assemble a boundary (list of polygons) from raw ways. A ring contained
    by a larger one becomes that polygon's hole."""
    rings = rings_from_ways(ways)
    if not rings:
        return []
    # Largest first, so a container is always seen before the rings inside it.
    polys: List[List[Ring]] = []
    for ring in sorted(rings, key=lambda r: abs(_ring_area(r)), reverse=True):
        lat, lon = ring[0]
        host = next((p for p in polys if point_in_ring(lat, lon, p[0])), None)
        if host is not None:
            host.append(ring)
        else:
            polys.append([ring])
    return polys


def _point_seg_degrees(p: Point, a: Point, b: Point) -> float:
    """Planar distance in degrees from p to segment a-b (lat/lon as y/x)."""
    py, px = p
    ay, ax = a
    by, bx = b
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def near_boundary(lat: float, lon: float, boundary, tolerance: float) -> bool:
    """True if the point is inside the boundary OR within `tolerance` degrees
    of one of its rings.

    This is the shapely `polygon.buffer(t).contains(pt)` the OSM resolver used
    to rely on: a border intersection that sits a stone's throw outside the
    line still counts as "in this town" when choosing between same-named
    junctions in two towns.
    """
    if point_in_boundary(lat, lon, boundary):
        return True
    for poly in boundary or []:
        for ring in poly:
            r = _closed(ring)
            for i in range(len(r) - 1):
                if _point_seg_degrees((lat, lon), r[i], r[i + 1]) <= tolerance:
                    return True
    return False
