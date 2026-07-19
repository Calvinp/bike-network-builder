"""Tests for geometry helpers (pure, no network)."""
import math
import pytest
from bikenetwork.geometry import (
    haversine_miles, polyline_miles, bbox_of, shortest_path, lonlat_to_mercator,
)


def test_mercator_origin():
    x, y = lonlat_to_mercator(0.0, 0.0)
    assert x == pytest.approx(0.0, abs=1e-6)
    assert y == pytest.approx(0.0, abs=1e-6)


def test_mercator_equator_x_at_180():
    x, _ = lonlat_to_mercator(0.0, 180.0)
    assert x == pytest.approx(20037508.34, rel=1e-4)


def test_mercator_y_increases_north():
    _, y_lo = lonlat_to_mercator(42.42, -71.06)
    _, y_hi = lonlat_to_mercator(42.45, -71.06)
    assert y_hi > y_lo  # higher latitude -> larger mercator y


def test_haversine_known_distance():
    # One degree of latitude is ~69 miles.
    d = haversine_miles((42.0, -71.0), (43.0, -71.0))
    assert d == pytest.approx(69.0, abs=0.5)


def test_haversine_zero():
    assert haversine_miles((42.42, -71.06), (42.42, -71.06)) == pytest.approx(0.0)


def test_polyline_miles_sums_segments():
    pts = [(42.0, -71.0), (42.0, -71.0), (43.0, -71.0)]  # 0 then ~69
    assert polyline_miles(pts) == pytest.approx(69.0, abs=0.5)


def test_polyline_miles_single_point_is_zero():
    assert polyline_miles([(42.0, -71.0)]) == 0.0


def test_bbox_of_with_padding():
    pts = [(42.42, -71.07), (42.45, -71.04)]
    s, w, n, e = bbox_of(pts, pad_deg=0.01)
    assert s == pytest.approx(42.41)
    assert w == pytest.approx(-71.08)
    assert n == pytest.approx(42.46)
    assert e == pytest.approx(-71.03)


def test_shortest_path_simple_line():
    # graph: 1 - 2 - 3 colinear; coords spaced along latitude
    coord = {1: (42.00, -71.0), 2: (42.01, -71.0), 3: (42.02, -71.0)}
    adj = {
        1: [(2, haversine_miles(coord[1], coord[2]))],
        2: [(1, haversine_miles(coord[2], coord[1])), (3, haversine_miles(coord[2], coord[3]))],
        3: [(2, haversine_miles(coord[3], coord[2]))],
    }
    pts, miles = shortest_path(adj, coord, 1, 3)
    assert pts == [coord[1], coord[2], coord[3]]
    assert miles == pytest.approx(haversine_miles(coord[1], coord[3]), abs=0.05)


def test_shortest_path_unreachable_returns_none():
    coord = {1: (42.0, -71.0), 9: (42.5, -71.0)}
    adj = {1: [], 9: []}
    pts, miles = shortest_path(adj, coord, 1, 9)
    assert pts is None and miles is None
