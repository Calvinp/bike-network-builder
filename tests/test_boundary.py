"""Tests for assembling an area polygon from raw ways and testing containment.

Pure Python, no shapely. Mirrors web/test/boundary.test.js — the two
implementations of ring assembly have to agree, since build.py uses this one
and the app uses the other.
"""
from bikenetwork.boundary import (boundary_from_ways, near_boundary,
                                  point_in_boundary, point_in_ring,
                                  rings_from_ways)

SQUARE = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]
HOLE = [(0.4, 0.4), (0.4, 0.6), (0.6, 0.6), (0.6, 0.4), (0.4, 0.4)]
FAR_SQUARE = [(10.0, 10.0), (10.0, 11.0), (11.0, 11.0), (11.0, 10.0), (10.0, 10.0)]


def test_point_in_ring_interior_and_exterior():
    assert point_in_ring(0.5, 0.5, SQUARE)
    assert not point_in_ring(2.0, 2.0, SQUARE)


def test_rings_from_ways_chains_scrambled_ways():
    ways = [
        [(1.0, 1.0), (1.0, 0.0), (0.0, 0.0)],
        [(0.0, 1.0), (1.0, 1.0)],
        [(0.0, 0.0), (0.0, 1.0)],
    ]
    rings = rings_from_ways(ways)
    assert len(rings) == 1
    assert rings[0][0] == rings[0][-1]
    assert point_in_ring(0.5, 0.5, rings[0])


def test_rings_from_ways_reverses_ways_that_join_end_to_end():
    ways = [
        [(0.0, 0.0), (0.0, 1.0)],
        [(1.0, 1.0), (0.0, 1.0)],          # reversed
        [(1.0, 1.0), (1.0, 0.0), (0.0, 0.0)],
    ]
    assert len(rings_from_ways(ways)) == 1


def test_rings_from_ways_drops_ways_that_never_close():
    assert rings_from_ways([[(0.0, 0.0), (0.0, 1.0)]]) == []


def test_a_ring_inside_another_becomes_a_hole():
    boundary = boundary_from_ways([SQUARE, HOLE])
    assert len(boundary) == 1
    assert len(boundary[0]) == 2               # outer + hole
    assert point_in_boundary(0.2, 0.2, boundary)
    assert not point_in_boundary(0.5, 0.5, boundary)   # in the hole


def test_disjoint_rings_become_separate_polygons():
    boundary = boundary_from_ways([SQUARE, FAR_SQUARE])
    assert len(boundary) == 2
    assert point_in_boundary(0.5, 0.5, boundary)
    assert point_in_boundary(10.5, 10.5, boundary)
    assert not point_in_boundary(5.0, 5.0, boundary)


def test_near_boundary_accepts_a_point_just_outside_the_line():
    boundary = boundary_from_ways([SQUARE])
    # 0.001 degrees outside the eastern edge: outside, but within tolerance.
    assert not point_in_boundary(0.5, 1.001, boundary)
    assert near_boundary(0.5, 1.001, boundary, 0.0015)
    assert not near_boundary(0.5, 1.100, boundary, 0.0015)


def test_the_shipped_malden_boundary_assembles():
    """The real data is 5 ways of very different lengths that only form an
    area once chained — the regression that matters after dropping shapely."""
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    fc = json.loads((root / "data" / "malden_boundary.geojson").read_text(encoding="utf-8"))
    ways = [[(lat, lon) for lon, lat in f["geometry"]["coordinates"]]
            for f in fc["features"]]
    boundary = boundary_from_ways(ways)
    assert len(boundary) == 1 and len(boundary[0]) == 1
    assert point_in_boundary(42.4251, -71.0662, boundary)    # Malden City Hall
    assert not point_in_boundary(42.4584, -71.0662, boundary)  # Melrose
    assert not point_in_boundary(42.3601, -71.0589, boundary)  # Boston
