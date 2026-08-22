"""Tests for BikePath <-> GeoJSON conversion (pure, no network)."""
import pytest
from bikenetwork.geojson import paths_from_geojson, paths_to_geojson
from bikenetwork.network_format import BikePath


def _p(name, phase=1, status="proposed", **kw):
    p = BikePath(name=name, on_street=name, frm=f"{name} & A", to=f"{name} & B",
                 phase=phase, type="quick_build_separated", status=status,
                 notes="hi", **kw)
    p.segments = [[(42.42, -71.07), (42.43, -71.06)]]
    return p


def test_roundtrip_preserves_properties_and_geometry():
    paths = [
        _p("Main"),
        _p("Broadway", phase=3, jurisdiction="state", directions=1),
        _p("Trail", phase=None, status="existing"),
    ]
    out = paths_from_geojson(paths_to_geojson(paths))
    assert [p.name for p in out] == ["Main", "Broadway", "Trail"]
    assert out[1].jurisdiction == "state" and out[1].directions == 1
    assert out[0].type == "quick_build_separated" and out[0].notes == "hi"
    assert out[2].status == "existing" and out[2].phase is None
    # Geometry preserved as (lat, lon); length computed and positive.
    assert out[0].segments[0][0] == (42.42, -71.07)
    assert out[0].length_miles > 0


def test_duplicate_names_survive_roundtrip():
    # Regression for the map-export bug: six paths all named "New corridor"
    # used to collapse into one because geometry was keyed by name.
    paths = [_p("New corridor") for _ in range(6)]
    for i, p in enumerate(paths):
        p.segments = [[(42.40 + i / 100, -71.07), (42.41 + i / 100, -71.06)]]
    out = paths_from_geojson(paths_to_geojson(paths))
    assert len(out) == 6
    assert len({tuple(p.segments[0][0]) for p in out}) == 6  # all distinct


def test_combined_path_roundtrips_as_multilinestring():
    p = _p("Northern Strand")
    p.segments = [[(42.41, -71.05), (42.42, -71.04)],
                  [(42.43, -71.03), (42.44, -71.02)]]
    fc = paths_to_geojson([p])
    assert fc["features"][0]["geometry"]["type"] == "MultiLineString"
    out = paths_from_geojson(fc)
    assert len(out) == 1 and out[0].segments == p.segments


def test_geojson_features_carry_full_property_set():
    fc = paths_to_geojson([_p("Main")])
    props = fc["features"][0]["properties"]
    assert props["name"] == "Main"
    assert props["type"] == "quick_build_separated"
    assert props["from"] == "Main & A"
    assert props["miles"] > 0
    # GeoJSON coordinate order is [lon, lat].
    assert fc["features"][0]["geometry"]["coordinates"][0] == [-71.07, 42.42]


def test_upgrade_fields_survive_roundtrip():
    # id/upgrades ride the wire — the editor's autosave round-trips every
    # path through this module, so a missing property would silently wipe
    # upgrade links a second after any edit.
    a = _p("Main", id="main-1")
    b = _p("Main rebuild", phase=2, upgrades="main-1")
    out = paths_from_geojson(paths_to_geojson([a, b]))
    assert out[0].id == "main-1" and out[0].upgrades == ""
    assert out[1].upgrades == "main-1" and out[1].id == ""


def test_from_geojson_skips_degenerate_features():
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "Stub"},
         "geometry": {"type": "LineString", "coordinates": [[-71.0, 42.4]]}},
    ]}
    assert paths_from_geojson(fc) == []


def test_from_geojson_accepts_legacy_treatment_property():
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature",
         "properties": {"name": "Old", "treatment": "concrete_separated"},
         "geometry": {"type": "LineString",
                      "coordinates": [[-71.0, 42.4], [-71.1, 42.5]]}},
    ]}
    assert paths_from_geojson(fc)[0].type == "concrete_separated"
