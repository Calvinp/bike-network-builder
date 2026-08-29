"""The deployment's default area, read from data/place.json.

This is what makes the tool geography-agnostic in practice: nothing in the code
names a city, a boundary file, or a bounding box. Point place.json somewhere
else and the whole pipeline follows.

The acceptance test at the bottom is the definition of done for that claim —
a synthetic place for a town that doesn't exist must work with no code change.
"""
import json

import pytest

from bikenetwork.place import (BBOX_PAD_LAYERS, BBOX_PAD_OSM, Place,
                               bbox_from_ways, load_place)

TESTVILLE = {
    "id": "test:testville",
    "name": "Testville",
    "context": "Nowhere",
    "kind": "municipality",
    "authorities": [
        {"id": "testville", "name": "Town of Testville", "level": "municipal"},
        {"id": "statedot", "name": "State DOT", "level": "state"},
    ],
    "default_authority": "testville",
    "assets": {"boundary": "data/testville_boundary.geojson"},
    "map": {"center": [10.5, 20.5], "zoom": 13},
}

# A square town: lat 10..11, lon 20..21, given as two open ways that must be
# chained (the same shape the real Malden data has).
BOUNDARY_FC = {
    "type": "FeatureCollection",
    "features": [
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [
            [20.0, 10.0], [21.0, 10.0], [21.0, 11.0]]}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [
            [21.0, 11.0], [20.0, 11.0], [20.0, 10.0]]}},
    ],
}


@pytest.fixture
def testville(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "place.json").write_text(json.dumps(TESTVILLE),
                                                  encoding="utf-8")
    (tmp_path / "data" / "testville_boundary.geojson").write_text(
        json.dumps(BOUNDARY_FC), encoding="utf-8")
    return tmp_path


def test_load_place_reads_identity_and_authorities(testville):
    place = load_place(testville)
    assert place.name == "Testville"
    assert place.context == "Nowhere"
    assert place.display_name == "Testville, Nowhere"
    assert place.default_authority == "testville"
    assert place.authority_name("statedot") == "State DOT"


def test_asset_paths_resolve_against_the_root(testville):
    place = load_place(testville)
    assert place.asset("boundary") == testville / "data" / "testville_boundary.geojson"
    assert place.asset("boundary").exists()


def test_missing_assets_are_none_not_an_error(testville):
    """A deployment need not ship a street graph or a seed network."""
    place = load_place(testville)
    assert place.asset("street_graph") is None
    assert place.asset("seed_network") is None


def test_boundary_ways_and_polygon_come_from_the_place(testville):
    place = load_place(testville)
    ways = place.boundary_ways()
    assert len(ways) == 2
    boundary = place.boundary()
    assert len(boundary) == 1                      # one polygon, chained
    from bikenetwork.boundary import point_in_boundary
    assert point_in_boundary(10.5, 20.5, boundary)
    assert not point_in_boundary(50.0, 50.0, boundary)


def test_bbox_is_derived_from_the_boundary_not_hardcoded(testville):
    place = load_place(testville)
    south, west, north, east = place.bbox()
    # The square is lat 10..11, lon 20..21, padded outward.
    assert south < 10.0 and north > 11.0
    assert west < 20.0 and east > 21.0
    assert south == pytest.approx(10.0 - BBOX_PAD_OSM)
    # Layers want a tighter box than OSM resolution does.
    assert place.bbox(pad=BBOX_PAD_LAYERS)[0] > south


def test_bbox_from_ways_pads_and_orders_south_west_north_east():
    ways = [[(1.0, 2.0), (3.0, 4.0)]]
    assert bbox_from_ways(ways, pad=0.0) == (1.0, 2.0, 3.0, 4.0)


def test_a_place_with_no_boundary_has_no_bbox(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "place.json").write_text(
        json.dumps({"name": "Bare"}), encoding="utf-8")
    place = load_place(tmp_path)
    assert place.boundary_ways() == []
    assert place.bbox() is None
    assert place.display_name == "Bare"


def test_the_shipped_place_is_malden():
    """The repo's own default. Malden stays the default throughout v2."""
    place = load_place()
    assert place.name == "Malden"
    assert place.context == "Massachusetts"
    assert place.asset("boundary").exists()
    assert place.asset("street_graph").exists()
    south, west, north, east = place.bbox()
    assert south < 42.4251 < north and west < -71.0662 < east


# The bounding box that used to be hardcoded in osm.py as MALDEN_BBOX, kept
# here as a literal because it is now purely historical: nothing in the code
# names a city any more.
HISTORICAL_MALDEN_BBOX = (42.405, -71.098, 42.452, -71.012)


def test_the_derived_bbox_still_covers_the_old_hardcoded_one():
    """MALDEN_BBOX was hand-tuned over months of OSM lookups. The derived box
    must never be TIGHTER than it, or corridors that used to resolve would
    quietly start failing."""
    s, w, n, e = load_place().bbox()
    os_, ow, on, oe = HISTORICAL_MALDEN_BBOX
    assert s <= os_ and w <= ow and n >= on and e >= oe


# --------------------------------------------------------------------------
# The acceptance test for the whole geography-agnostic project
# --------------------------------------------------------------------------
def test_a_town_that_does_not_exist_works_with_no_code_change(testville):
    """If Testville passes, the tool is geography-agnostic. If it doesn't, it
    isn't — whatever the code looks like."""
    from bikenetwork.boundary import point_in_boundary

    place = load_place(testville)
    boundary = place.boundary()

    # Identity, authorities, extent and containment all come from the file.
    assert "Testville" in place.display_name
    assert place.authority_name(place.default_authority) == "Town of Testville"
    assert place.map_center == (10.5, 20.5)
    assert point_in_boundary(10.5, 20.5, boundary)

    # And the bbox an OSM client would use is Testville's, not Malden's.
    south, west, north, east = place.bbox()
    assert 9 < south < 11 and 19 < west < 21
