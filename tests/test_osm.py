"""Tests for the pure helpers in the OSM resolution seam (no network)."""
import pytest
from bikenetwork.osm import parse_cross_street, build_graph_from_overpass


def test_parse_cross_street_ampersand():
    assert parse_cross_street("Main Street", "Main Street & Pleasant Street") == "Pleasant Street"


def test_parse_cross_street_and_word():
    assert parse_cross_street("Main Street", "Main Street and Salem Street") == "Salem Street"


def test_parse_cross_street_order_independent():
    # on_street may appear second
    assert parse_cross_street("Main Street", "Pleasant Street & Main Street") == "Pleasant Street"


def test_parse_cross_street_unparseable_returns_none():
    assert parse_cross_street("Main Street", "Malden Center") is None


def test_build_graph_from_overpass_elements():
    # Simulate a minimal Overpass JSON 'elements' list for one way with 3 nodes.
    elements = [
        {
            "type": "way",
            "nodes": [10, 11, 12],
            "geometry": [
                {"lat": 42.00, "lon": -71.00},
                {"lat": 42.01, "lon": -71.00},
                {"lat": 42.02, "lon": -71.00},
            ],
        }
    ]
    adj, coord = build_graph_from_overpass(elements)
    assert set(coord) == {10, 11, 12}
    assert coord[10] == (42.00, -71.00)
    # adjacency is bidirectional along the way
    assert any(n == 11 for n, _ in adj[10])
    assert any(n == 10 for n, _ in adj[11])
    assert any(n == 12 for n, _ in adj[11])
