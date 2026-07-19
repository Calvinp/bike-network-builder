"""Smoke tests: the map renderer writes a non-empty PNG in every color mode
(offline, Agg backend), and path_color implements the modes correctly."""
import pytest
from bikenetwork.network_format import BikePath, Network, PhaseDef
from bikenetwork.render_map import (COLOR_MODES, PHASE_COLORS, SINGLE_COLOR,
                                    STATE_COLOR, TYPE_COLORS, path_color,
                                    render_map)


def _paths():
    spine = BikePath("Spine", on_street="Spine", frm="Spine & A", to="Spine & B",
                     phase=1, type="quick_build_separated", status="proposed")
    spine.segments = [[(42.42, -71.07), (42.43, -71.06), (42.44, -71.05)]]
    spine.length_miles = 1.0
    trail = BikePath("Trail", on_street="Trail", phase=None,
                     type="shared_use_path", status="existing")
    trail.segments = [[(42.41, -71.07), (42.42, -71.06)]]
    trail.length_miles = 0.5
    state = BikePath("Broadway", on_street="Broadway", phase=2,
                     type="concrete_separated", status="proposed",
                     jurisdiction="state")
    state.segments = [[(42.41, -71.05), (42.42, -71.04)]]
    state.length_miles = 0.5
    return [spine, trail, state]


NET = Network(city="Malden", phases=[PhaseDef(1, "Core", "2029"),
                                     PhaseDef(2, "More", "2032")])
BOUNDARY = [[(42.40, -71.09), (42.45, -71.09), (42.45, -71.02), (42.40, -71.02)]]


@pytest.mark.parametrize("mode", COLOR_MODES)
def test_render_map_writes_png_in_every_mode(tmp_path, mode):
    out = tmp_path / f"map-{mode}.png"
    # basemap=False keeps the test offline (no tile fetch).
    render_map(_paths(), NET, out, boundary=BOUNDARY, basemap=False,
               color_mode=mode)
    assert out.exists() and out.stat().st_size > 1000


def test_path_color_by_phase():
    spine, trail, state = _paths()
    assert path_color(spine, "phase") == PHASE_COLORS[1]
    assert path_color(trail, "phase") == "#000000"       # existing
    assert path_color(state, "phase") == STATE_COLOR     # MassDOT bucket


def test_path_color_by_type():
    spine, trail, state = _paths()
    assert path_color(spine, "type") == TYPE_COLORS["quick_build_separated"]
    assert path_color(trail, "type") == TYPE_COLORS["shared_use_path"]
    assert path_color(state, "type") == TYPE_COLORS["concrete_separated"]


def test_path_color_single():
    for p in _paths():
        assert path_color(p, "single") == SINGLE_COLOR
