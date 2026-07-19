"""Tests for assembling the city polygon and clipping corridors to it (pure)."""
import pytest
from bikenetwork.boundary import build_polygon, clip_polyline_latlon


# A unit square boundary, given as (lat, lon) ring: lat in [0,1], lon in [0,1].
SQUARE_RING = [[(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]]


def test_build_polygon_contains_interior_point():
    poly = build_polygon(SQUARE_RING)
    from shapely.geometry import Point
    assert poly.contains(Point(0.5, 0.5))   # shapely is (x=lon, y=lat)
    assert not poly.contains(Point(2.0, 2.0))


def test_clip_keeps_inside_portion():
    poly = build_polygon(SQUARE_RING)
    # Horizontal line at lat=0.5, lon from -0.5 (outside) to 0.5 (inside).
    geom = [(0.5, -0.5), (0.5, 0.5)]
    clipped, miles = clip_polyline_latlon(geom, poly)
    lons = [lon for _, lon in clipped]
    assert min(lons) >= -1e-9          # nothing west of lon=0
    assert max(lons) == pytest.approx(0.5)
    assert miles > 0


def test_clip_fully_outside_returns_empty():
    poly = build_polygon(SQUARE_RING)
    geom = [(5.0, 5.0), (6.0, 6.0)]
    clipped, miles = clip_polyline_latlon(geom, poly)
    assert clipped == []
    assert miles == 0.0


def test_clip_fully_inside_unchanged_length():
    poly = build_polygon(SQUARE_RING)
    geom = [(0.5, 0.2), (0.5, 0.8)]
    clipped, miles = clip_polyline_latlon(geom, poly)
    assert len(clipped) >= 2
    assert miles > 0
