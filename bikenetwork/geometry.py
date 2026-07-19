"""Pure geometry helpers: distances, bounding boxes, and shortest path along a
street graph. No external geo dependencies, no network — fully unit-testable.
Coordinates are (lat, lon) tuples in degrees.
"""
from __future__ import annotations

import heapq
import math
from typing import Dict, List, Optional, Tuple

Point = Tuple[float, float]
EARTH_RADIUS_MILES = 3958.7613
WEB_MERCATOR_R = 6378137.0  # EPSG:3857 sphere radius (meters)


def lonlat_to_mercator(lat: float, lon: float) -> Point:
    """Project (lat, lon) degrees to Web Mercator (EPSG:3857) meters (x, y).

    Used so tiled basemaps (contextily) line up sharply with the network instead
    of warping lat/lon onto plot axes.
    """
    x = WEB_MERCATOR_R * math.radians(lon)
    y = WEB_MERCATOR_R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def haversine_miles(a: Point, b: Point) -> float:
    """Great-circle distance between two (lat, lon) points, in miles."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(h))


def polyline_miles(points: List[Point]) -> float:
    """Total length of a polyline (sum of segment lengths), in miles."""
    return sum(haversine_miles(points[i], points[i + 1]) for i in range(len(points) - 1))


def segments_miles(segments: List[List[Point]]) -> float:
    """Total length of a multi-segment path (a BikePath.segments value)."""
    return sum(polyline_miles(seg) for seg in segments)


def bbox_of(points: List[Point], pad_deg: float = 0.0) -> Tuple[float, float, float, float]:
    """Return (south, west, north, east) bounding box of points, padded by pad_deg."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    return (min(lats) - pad_deg, min(lons) - pad_deg,
            max(lats) + pad_deg, max(lons) + pad_deg)


def shortest_path(
    adj: Dict[int, List[Tuple[int, float]]],
    coord: Dict[int, Point],
    src: int,
    dst: int,
) -> Tuple[Optional[List[Point]], Optional[float]]:
    """Dijkstra shortest path between node ids src and dst over a weighted graph.

    `adj` maps node id -> list of (neighbor id, weight_miles).
    `coord` maps node id -> (lat, lon).
    Returns (list_of_points, total_miles) or (None, None) if unreachable.
    """
    dist: Dict[int, float] = {src: 0.0}
    prev: Dict[int, int] = {}
    pq: List[Tuple[float, int]] = [(0.0, src)]
    visited = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        if u == dst:
            break
        for v, w in adj.get(u, []):
            nd = d + w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    if dst not in dist:
        return None, None
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    path.reverse()
    return [coord[n] for n in path], dist[dst]
