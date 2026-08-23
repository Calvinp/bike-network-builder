"""Assemble the Malden city polygon from its boundary ways and clip corridors to
it, so the network (and the mileage/cost totals derived from it) only ever count
street inside Malden. Streets like Main St, Lebanon St, Broadway and Eastern Ave
continue into neighboring cities, and same-named intersections exist there; this
guarantees we never include out-of-Malden segments.

shapely uses planar (x=lon, y=lat) coordinates; at city scale that's fine for
containment and intersection. Lengths are still measured geodesically (haversine).
"""
from __future__ import annotations

from typing import List, Sequence, Tuple

from shapely.geometry import LineString, MultiLineString, Polygon
from shapely.ops import polygonize, unary_union

from .geometry import polyline_miles

Point = Tuple[float, float]


def build_polygon(rings: Sequence[Sequence[Point]]) -> Polygon:
    """Build the city polygon from boundary polylines (each a list of (lat, lon)).

    Tries to polygonize the boundary ways into a closed area; falls back to the
    convex hull of all boundary points if the ways don't form clean rings.
    """
    lines = [LineString([(lon, lat) for lat, lon in ring])
             for ring in rings if len(ring) >= 2]
    merged = unary_union(lines)
    polys = list(polygonize(merged))
    if polys:
        return max(polys, key=lambda p: p.area)
    # Fallback: convex hull (over-includes, but better than no clipping).
    return unary_union(lines).convex_hull


def clip_polyline_latlon(geom: Sequence[Point], polygon: Polygon):
    """Clip a (lat, lon) polyline to `polygon`, returning the single longest
    in-boundary piece as [(lat, lon), ...] and its geodesic length in miles.
    Returns ([], 0.0) if nothing is inside."""
    if len(geom) < 2:
        return [], 0.0
    line = LineString([(lon, lat) for lat, lon in geom])
    inside = line.intersection(polygon)
    if inside.is_empty:
        return [], 0.0

    if isinstance(inside, LineString):
        parts = [inside]
    elif isinstance(inside, MultiLineString):
        parts = list(inside.geoms)
    else:  # GeometryCollection or a stray Point — keep only line parts
        parts = [g for g in getattr(inside, "geoms", []) if isinstance(g, LineString)]
    if not parts:
        return [], 0.0

    best, best_miles = [], 0.0
    for part in parts:
        latlon = [(y, x) for x, y in part.coords]  # back to (lat, lon)
        miles = polyline_miles(latlon)
        if miles > best_miles:
            best, best_miles = latlon, miles
    return best, best_miles


def point_in_polygon_latlon(pt: Point, polygon: Polygon) -> bool:
    """True if a (lat, lon) point lies inside (or on) the city polygon."""
    from shapely.geometry import Point as ShapelyPoint
    return polygon.covers(ShapelyPoint(pt[1], pt[0]))


def clip_segments_latlon(segments, polygon):
    """Clip a multi-segment path (BikePath.segments) to `polygon`: each segment
    keeps its longest in-boundary piece; fully-outside segments are dropped.
    Returns (kept_segments, total_miles)."""
    kept, total = [], 0.0
    for seg in segments:
        piece, miles = clip_polyline_latlon(seg, polygon)
        if len(piece) >= 2:
            kept.append(piece)
            total += miles
    return kept, total
