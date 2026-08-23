"""Smoke tests: the map renderer writes a non-empty PNG in every color mode
(offline, Agg backend), and path_color implements the modes correctly."""
import pytest
from bikenetwork.network_format import (SPOT_TYPES, BikePath, Network,
                                         PhaseDef)
from bikenetwork.render_map import (COLOR_MODES, PHASE_COLORS, SINGLE_COLOR,
                                    SPOT_GLYPHS, SPOT_LABELS, STATE_COLOR,
                                    TYPE_COLORS, path_color, render_map,
                                    spot_label_midsentence)


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


def test_untight_frames_have_a_fixed_canvas_and_axes(tmp_path):
    """Animation frames must be pixel-stable: same canvas AND same axes box no
    matter how long the title is or whether a frame has route labels — the
    map would otherwise jump around as the GIF plays."""
    from PIL import Image

    sizes, boxes = set(), set()
    for paths, title in ((_paths()[1:2], "Today\n"),
                         (_paths(), "Phase 2: A Very Long Phase Label Indeed\n"
                                    "by December 31, 2032")):
        out = tmp_path / f"frame-{len(paths)}.png"
        fig_before = len(_open_figures())
        render_map(paths, NET, out, boundary=BOUNDARY, basemap=False,
                   figsize=(10, 6), dpi=40, tight=False, title=title)
        assert len(_open_figures()) == fig_before  # figures are closed
        with Image.open(out) as im:
            sizes.add(im.size)
        boxes.add(_last_axes_box)
    assert sizes == {(400, 240)}, sizes          # figsize * dpi exactly
    assert len(boxes) == 1, boxes                # identical axes rectangle


_last_axes_box = None


@pytest.fixture(autouse=True)
def _capture_axes_box(monkeypatch):
    """Record the axes rectangle of the last rendered figure."""
    import matplotlib.pyplot as plt
    real = plt.Figure.savefig

    def spy(self, *a, **k):
        global _last_axes_box
        if self.axes:
            _last_axes_box = tuple(round(v, 6)
                                   for v in self.axes[0].get_position().bounds)
        return real(self, *a, **k)

    monkeypatch.setattr(plt.Figure, "savefig", spy)


def _open_figures():
    import matplotlib.pyplot as plt
    return plt.get_fignums()


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


def test_superseded_path_loses_its_one_way_chevron(tmp_path, monkeypatch):
    """The full-network map draws a replaced path and its replacement on the
    same geometry, so the upgrade covers the old line completely — but the old
    chevron would still float on top, claiming the new lane is one-way."""
    import bikenetwork.render_map as rm

    drawn = []
    real = rm._direction_arrow

    def spy(ax, seg):
        drawn.append(seg)
        return real(ax, seg)

    monkeypatch.setattr(rm, "_direction_arrow", spy)

    geom = [(42.42, -71.07), (42.43, -71.06)]
    old = BikePath("Main Street", phase=1, type="quick_build_separated",
                   status="proposed", directions=1, id="main-1")
    old.segments = [geom]
    new = BikePath("Main Street rebuild", phase=2, type="concrete_separated",
                   status="proposed", directions=2, upgrades="main-1")
    new.segments = [geom]

    # On its own the one-way path draws its chevron...
    rm.render_map([old], NET, tmp_path / "alone.png", boundary=BOUNDARY,
                  basemap=False, dpi=40)
    assert len(drawn) == 1

    # ...but not once the upgrade that replaces it is on the same map.
    drawn.clear()
    rm.render_map([old, new], NET, tmp_path / "both.png", boundary=BOUNDARY,
                  basemap=False, dpi=40)
    assert drawn == []


def test_every_spot_type_has_a_glyph_and_a_label():
    """A type the tables don't know draws the catch-all dot and legends itself
    with a raw slug, so the tables track SPOT_TYPES exactly — order included,
    since it is the order of both the legend and the editor's dropdown."""
    assert tuple(SPOT_GLYPHS) == SPOT_TYPES
    assert tuple(SPOT_LABELS) == SPOT_TYPES


def test_acronyms_survive_the_midsentence_spot_label():
    """The HTML popup says "Proposed <label>" — lowercasing the whole label
    would turn a HAWK signal into a hawk signal."""
    assert spot_label_midsentence("raised_crosswalk") == "raised crosswalk"
    assert spot_label_midsentence("hawk_signal") == "HAWK signal"
