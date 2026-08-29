"""Offline test of resolve_network's in-area node preference (the wrong-town
intersection problem), using a fake Overpass client."""
from bikenetwork.geometry import haversine_miles
from bikenetwork.model import Corridor
from bikenetwork.osm import resolve_network


class FakeClient:
    """Stands in for OverpassClient. 'A Street' crosses Main both in Malden
    (node 1) and Melrose (node 99); 'C Street' crosses Main ONLY in Melrose."""

    coord = {1: (42.43, -71.06), 2: (42.44, -71.06), 99: (42.48, -71.06)}
    nodes = {
        ("Main Street", "A Street"): [(1, 42.43, -71.06), (99, 42.48, -71.06)],
        ("Main Street", "B Street"): [(2, 42.44, -71.06)],
        ("Main Street", "C Street"): [(99, 42.48, -71.06)],
    }

    def intersection_nodes(self, on_street, cross_street):
        return self.nodes.get((on_street, cross_street), [])

    def street_graph(self, on_street):
        adj = {}
        for a, b in [(1, 2), (2, 99)]:
            d = haversine_miles(self.coord[a], self.coord[b])
            adj.setdefault(a, []).append((b, d))
            adj.setdefault(b, []).append((a, d))
        return adj, self.coord


# Malden is everything south of lat 42.46 in this toy world.
def inside_malden(lat, lon):
    return lat < 42.46


def _corr(name, frm, to):
    return Corridor(name=name, on_street="Main Street", frm=frm, to=to, phase=1,
                    type="quick_build_separated", status="proposed", notes="")


def test_prefers_in_malden_node(tmp_path):
    good = _corr("Main A-B", "Main Street & A Street", "Main Street & B Street")
    resolved, warnings, notices = resolve_network(
        [good], tmp_path / "cache.json", refresh=True,
        client=FakeClient(), inside=inside_malden,
    )
    assert "Main A-B" in resolved
    geom = resolved["Main A-B"]["geometry"]
    # Must use the Malden node (1), never the Melrose node (99 at lat 42.48).
    assert all(lat < 42.46 for lat, _ in geom)
    assert resolved["Main A-B"]["miles"] > 0
    assert notices == []  # both endpoints in Malden -> no alert


def test_border_only_intersection_kept_with_notice(tmp_path):
    # 'C Street' crosses Main ONLY at the Melrose node (99). The corridor is kept
    # (build clips it to the city line) but a notice flags it for verification.
    bad = _corr("Main A-C", "Main Street & A Street", "Main Street & C Street")
    resolved, warnings, notices = resolve_network(
        [bad], tmp_path / "cache.json", refresh=True,
        client=FakeClient(), inside=inside_malden,
    )
    assert "Main A-C" in resolved          # kept, not dropped
    assert warnings == []                   # not a failure
    assert any("outside the area" in n.lower() for n in notices)
