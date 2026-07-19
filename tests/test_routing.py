"""Tests for snap-to-road routing (pure, no network)."""
import pytest
from bikenetwork.geometry import haversine_miles
from bikenetwork.routing import nearest_node, snap_route


# A small graph: nodes 1-2-3 along an L shape; node 9 is isolated.
COORD = {1: (42.400, -71.000), 2: (42.400, -71.010), 3: (42.410, -71.010),
         9: (42.500, -71.500)}


def _adj():
    adj = {}
    for a, b in [(1, 2), (2, 3)]:
        d = haversine_miles(COORD[a], COORD[b])
        adj.setdefault(a, []).append((b, d))
        adj.setdefault(b, []).append((a, d))
    return adj


def test_nearest_node_picks_closest():
    assert nearest_node(COORD, 42.401, -71.0005) == 1
    assert nearest_node(COORD, 42.409, -71.0102) == 3


def test_snap_route_follows_edges():
    # Two clicks near node 1 and node 3 -> route should run 1 -> 2 -> 3.
    route = snap_route([[42.4002, -71.000], [42.4098, -71.010]], _adj(), COORD)
    assert route[0] == COORD[1]
    assert route[-1] == COORD[3]
    assert COORD[2] in route  # went around the corner along the street


def test_snap_route_mid_edge_click_still_snaps():
    # OSM ways only carry shape vertices, so a click halfway along a straight
    # block is far from every NODE while sitting on the road — nearness is
    # measured to edges, not nodes.
    route = snap_route([[42.4001, -71.005], [42.4098, -71.010]], _adj(), COORD)
    assert route[-1] == COORD[3]
    assert COORD[2] in route


def test_snap_route_keeps_far_clicks_off_street():
    # Clicks along the street snap; a click away from every road (a park, a
    # cut-through between buildings) anchors straight legs exactly where
    # drawn — one line can mix snapped and free-drawn sections.
    route = snap_route([[42.4002, -71.000], [42.4098, -71.010],
                        [42.405, -71.030]], _adj(), COORD)
    assert COORD[2] in route                  # street part still routed
    assert route[-1] == (42.405, -71.030)     # off-street click untouched
    assert route[-2] == (42.4098, -71.010)    # straight leg from the drawn point


def test_snap_route_backlot_click_stays_free_drawn():
    # ~80 m from the street centerline (a mid-block backlot) is beyond the
    # ~30 m snap radius: the click must NOT get dragged onto the road.
    backlot = [42.4007, -71.005]   # 0.0007 deg lat ~ 0.048 mi from edge 1-2
    route = snap_route([[42.4002, -71.000], backlot], _adj(), COORD)
    assert route[-1] == (42.4007, -71.005)


def test_snap_route_disconnected_falls_back_to_straight():
    # Click near node 3 then near isolated node 9 -> no path -> straight segment.
    route = snap_route([[42.410, -71.010], [42.50, -71.50]], _adj(), COORD)
    assert route[0] == (42.410, -71.010)
    assert route[-1] == (42.50, -71.50)
    assert len(route) == 2


def test_snap_route_single_point_passthrough():
    assert snap_route([[42.4, -71.0]], _adj(), COORD) == [(42.4, -71.0)]
