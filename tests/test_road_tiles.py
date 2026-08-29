"""Cutting a street graph into roads tiles.

The property that matters is the OVERLAP: an edge is written into both of its
endpoints' tiles, so two adjacent tiles merged by the app are connected across
their shared border. Without it a route would stop dead at every tile line.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from make_road_tiles import cut, tile_for  # noqa: E402


def graph_across_a_border(zoom=14):
    """Two nodes far enough apart to land in different z14 tiles."""
    coord = {"1": [42.42, -71.09], "2": [42.42, -71.02]}
    adj = {"1": [[2, 3.0]], "2": [[1, 3.0]]}
    assert tile_for(42.42, -71.09, zoom) != tile_for(42.42, -71.02, zoom)
    return {"coord": coord, "adj": adj}


def test_a_node_lands_in_the_tile_that_contains_it():
    tiles = cut({"coord": {"1": [42.42, -71.06]}, "adj": {}}, 14)
    assert list(tiles) == [tile_for(42.42, -71.06, 14)]


def test_a_border_crossing_edge_is_written_into_BOTH_tiles():
    """The overlap that lets a merged pair of tiles route across their line."""
    tiles = cut(graph_across_a_border(), 14)
    assert len(tiles) == 2
    for data in tiles.values():
        # Each tile carries both endpoints and the edge between them.
        assert set(data["coord"]) == {"1", "2"}
        assert data["adj"]


def test_every_tile_is_self_consistent():
    """Any node an adjacency mentions is present in the same tile, or the app
    would merge a graph with dangling references."""
    tiles = cut(graph_across_a_border(), 14)
    for data in tiles.values():
        for node, nbrs in data["adj"].items():
            assert node in data["coord"]
            for nbr, _ in nbrs:
                assert str(nbr) in data["coord"]


def test_the_shipped_malden_graph_cuts_into_usable_tiles():
    graph = json.loads((ROOT / "data" / "street_graph.json").read_text(encoding="utf-8"))
    tiles = cut(graph, 14)
    assert 5 < len(tiles) < 200, "z14 over one city should be tens of tiles"
    sizes = [len(json.dumps({"coord": d["coord"], "adj": dict(d["adj"])}))
             for d in tiles.values()]
    # The whole point: a tile is a fraction of the 3.9 MB whole-city asset.
    assert max(sizes) < 1_500_000
    assert sum(sizes) / len(sizes) < 500_000


def test_no_node_is_lost():
    graph = json.loads((ROOT / "data" / "street_graph.json").read_text(encoding="utf-8"))
    tiles = cut(graph, 14)
    seen = set()
    for d in tiles.values():
        seen.update(d["coord"])
    assert seen == set(graph["coord"])
