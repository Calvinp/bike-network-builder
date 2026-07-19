"""Snap-to-road routing for the editor: snap clicked points to the nearest road
node and route along the street network between them (Dijkstra), so a drawn line
follows real streets. Reuses the graph + shortest-path machinery already built
for intersection resolution.

The street graph is fetched once from OpenStreetMap and cached to disk, so
snapping is fast after the first use.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .geometry import haversine_miles, shortest_path

Point = Tuple[float, float]


def nearest_node(coord: Dict[int, Point], lat: float, lon: float) -> Optional[int]:
    """Return the id of the graph node closest to (lat, lon)."""
    best, best_d = None, math.inf
    for nid, (nlat, nlon) in coord.items():
        d = haversine_miles((lat, lon), (nlat, nlon))
        if d < best_d:
            best, best_d = nid, d
    return best


def _point_seg_miles(p: Point, a: Point, b: Point) -> float:
    """Distance from point p to segment a-b, all (lat, lon), in miles.
    Flat-earth projection (lon scaled by cos lat) — fine at city scale."""
    scale = math.cos(math.radians(p[0]))
    px, py = p[1] * scale, p[0]
    ax_, ay = a[1] * scale, a[0]
    bx, by = b[1] * scale, b[0]
    dx, dy = bx - ax_, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if not denom else max(0.0, min(1.0, ((px - ax_) * dx + (py - ay) * dy) / denom))
    cx, cy = ax_ + t * dx, ay + t * dy
    return haversine_miles(p, (cy, cx / scale))


def _near_road(pt, edges, coord, max_miles: float) -> bool:
    """True if pt (lat, lon) is within max_miles of any graph EDGE. Edges, not
    nodes: OSM ways only carry shape vertices, so a mid-block click on a long
    straight street can be far from every node while sitting ON the road."""
    lat, lon = float(pt[0]), float(pt[1])
    # Quick reject: the point must fall inside the edge's bounding box padded
    # by the threshold (1 degree ~ 69 mi; padding is generous for longitude).
    margin = max_miles / 69.0 * 1.5
    for a, b in edges:
        (alat, alon), (blat, blon) = coord[a], coord[b]
        if not (min(alat, blat) - margin <= lat <= max(alat, blat) + margin):
            continue
        if not (min(alon, blon) - margin <= lon <= max(alon, blon) + margin):
            continue
        if _point_seg_miles((lat, lon), (alat, alon), (blat, blon)) <= max_miles:
            return True
    return False


def snap_route(waypoints, adj, coord, max_snap_miles: float = 0.02) -> List[Point]:
    """Route a polyline through `waypoints` (each [lat, lon]) along the street
    graph. Each consecutive pair is connected by the shortest on-street path; a
    pair with no connecting path falls back to a straight segment.

    A waypoint farther than `max_snap_miles` (~30 m) from every road EDGE is
    treated as deliberately OFF-STREET (a park interior, a cut-through between
    buildings): its legs stay exactly where they were drawn. One drawn line
    can therefore mix snapped street sections with free-drawn off-street
    sections — click on streets where you want snapping, click away from them
    where you don't. The radius is tight on purpose: even a mid-block backlot
    a lot-depth away from the street centerline stays free-drawn."""
    if len(waypoints) < 2:
        return [(float(w[0]), float(w[1])) for w in waypoints]

    edges = [(a, b) for a, nbrs in adj.items() for b, _ in nbrs if a < b]
    nodes: List[Optional[int]] = []
    for w in waypoints:
        if _near_road(w, edges, coord, max_snap_miles):
            nodes.append(nearest_node(coord, w[0], w[1]))
        else:
            nodes.append(None)  # off-street click

    out: List[Point] = []
    for i in range(len(waypoints) - 1):
        a, b = nodes[i], nodes[i + 1]
        seg: Optional[List[Point]] = None
        if a is not None and b is not None and a != b:
            pts, _ = shortest_path(adj, coord, a, b)
            if pts:
                seg = [(float(la), float(lo)) for la, lo in pts]
        if not seg:
            seg = [(float(waypoints[i][0]), float(waypoints[i][1])),
                   (float(waypoints[i + 1][0]), float(waypoints[i + 1][1]))]
        if out and out[-1] == seg[0]:
            out.extend(seg[1:])
        else:
            out.extend(seg)
    return out


def load_street_graph(cache_path, fetch_fn):
    """Load (adj, coord) from a JSON cache, or fetch via fetch_fn() and cache it.
    fetch_fn returns (adj, coord) with integer node ids."""
    cache_path = Path(cache_path)
    if cache_path.exists():
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
        coord = {int(k): tuple(v) for k, v in raw["coord"].items()}
        adj = {int(k): [(int(n), float(w)) for n, w in v]
               for k, v in raw["adj"].items()}
        return adj, coord

    adj, coord = fetch_fn()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps({
        "coord": {str(k): list(v) for k, v in coord.items()},
        "adj": {str(k): [[n, w] for n, w in v] for k, v in adj.items()},
    }), encoding="utf-8")
    return adj, coord
