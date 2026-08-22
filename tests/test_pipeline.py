"""Tests for the shared pipeline: clipping, summarizing, and rendering all
outputs (offline — basemap disabled)."""
import json

import pytest
from bikenetwork.boundary import build_polygon
from bikenetwork.network_format import BikePath, Network, PhaseDef, Spot
from bikenetwork.pipeline import (clip_paths, paths_as_of_phase, render_all,
                                  render_phase_exports, spots_as_of_phase,
                                  summarize)

BOUNDARY = [[(42.40, -71.09), (42.45, -71.09), (42.45, -71.02),
             (42.40, -71.02), (42.40, -71.09)]]


def _p(name, phase=1, status="proposed", geometry=None, **kw):
    p = BikePath(name=name, on_street=name, phase=phase, status=status,
                 type="quick_build_separated", **kw)
    p.segments = [geometry] if geometry else [[(42.42, -71.07), (42.43, -71.06)]]
    return p


def _net(paths):
    return Network(city="Malden",
                   phases=[PhaseDef(1, "Core", "2029"), PhaseDef(2, "More", "2032")],
                   paths=paths)


def test_clip_drops_outside_and_trims_crossing():
    polygon = build_polygon(BOUNDARY)
    inside = _p("In")
    outside = _p("Out", geometry=[(42.50, -71.07), (42.52, -71.06)])
    crossing = _p("Cross", geometry=[(42.42, -71.05), (42.48, -71.05)])
    warnings, notices = [], []
    out = clip_paths([inside, outside, crossing], polygon, warnings, notices)
    names = [p.name for p in out]
    assert "In" in names and "Out" not in names and "Cross" in names
    assert any("Out" in w for w in warnings)
    clipped = next(p for p in out if p.name == "Cross")
    assert max(lat for seg in clipped.segments for lat, lon in seg) <= 42.45 + 1e-6
    assert any("Cross" in n for n in notices)


def test_clip_handles_duplicate_names_independently():
    # Regression for the map-export bug: identically-named paths must each
    # keep their own geometry through the pipeline.
    polygon = build_polygon(BOUNDARY)
    a = _p("New corridor", geometry=[(42.41, -71.07), (42.42, -71.06)])
    b = _p("New corridor", geometry=[(42.43, -71.05), (42.44, -71.04)])
    out = clip_paths([a, b], polygon, [], [])
    assert len(out) == 2
    assert out[0].segments != out[1].segments


def test_summarize_buckets_statuses_and_state():
    paths = [
        _p("A", 1), _p("B", 2),
        _p("State Rd", 1, jurisdiction="state"),
        _p("Trail", None, status="existing"),
        _p("Greenway", None, status="funded"),
    ]
    for p in paths:
        p.length_miles = 1.0
    s = summarize(paths, _net(paths))
    assert s["total_build_miles"] == pytest.approx(2.0)
    assert s["total_lane_miles"] == pytest.approx(4.0)  # directions=2
    assert s["state_miles"] == pytest.approx(1.0)
    assert s["existing_miles"] == pytest.approx(1.0)
    assert s["committed_miles"] == pytest.approx(1.0)
    assert [ph["phase"] for ph in s["phases"]] == [1, 2]
    assert s["phases"][0]["label"] == "Core"


def test_summarize_excludes_superseded_from_totals():
    # Quick-build in phase 1, full rebuild of the same corridor in phase 2:
    # the corridor counts ONCE at full buildout, but each phase's row still
    # shows its own work (you pay to build twice).
    a = _p("Main quick-build", 1, id="a")
    b = _p("Main rebuild", 2, upgrades="a")
    for p in (a, b):
        p.length_miles = 1.0
    s = summarize([a, b], _net([a, b]))
    assert s["total_build_miles"] == pytest.approx(1.0)
    assert s["total_lane_miles"] == pytest.approx(2.0)
    assert s["total_paths"] == 1
    assert [ph["miles"] for ph in s["phases"]] == [pytest.approx(1.0)] * 2


def test_render_all_writes_outputs_and_keeps_duplicates(tmp_path):
    paths = [
        _p("New corridor", geometry=[(42.41, -71.07), (42.42, -71.06)]),
        _p("New corridor", geometry=[(42.43, -71.05), (42.44, -71.04)]),
        _p("Trail", None, status="existing",
           geometry=[(42.42, -71.03), (42.43, -71.03)]),
    ]
    net = _net(paths)
    summary = render_all(net, BOUNDARY, tmp_path, basemap=False)
    for name in ("map.png", "map.html", "network.geojson"):
        assert (tmp_path / name).exists(), name
    fc = json.loads((tmp_path / "network.geojson").read_text(encoding="utf-8"))
    assert len(fc["features"]) == 3  # duplicates did NOT collapse
    assert summary["total_build_miles"] > 0
    # render_all must not mutate the source network (clipping happens on copies).
    assert net.paths[0].segments == [[(42.41, -71.07), (42.42, -71.06)]]


def test_html_one_way_arrows_use_plain_markers(tmp_path):
    # Regression: the folium TextPath plugin crashed the whole map.html at
    # runtime (its setText ran before groups attached; nothing rendered).
    # Arrows must be plugin-free DivIcon markers.
    paths = [_p("OneWay", directions=1)]
    render_all(_net(paths), BOUNDARY, tmp_path, basemap=False)
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert "dir-arrow" in html          # the rotated chevron marker
    assert "setText" not in html        # the plugin that broke rendering
    assert "polyline_text_path" not in html.lower().replace("-", "_")
    # Fixed-size chevrons dwarf the streets when zoomed way out — the page
    # must hide them below the minimum zoom (and re-hide on layer re-add).
    assert "zoomend" in html
    assert "getZoom() >= 14" in html


def test_paths_as_of_phase_hides_superseded():
    a = _p("Quick", 1, id="a")
    b = _p("Rebuild", 2, upgrades="a")
    e = _p("Trail", None, status="existing")
    assert [p.name for p in paths_as_of_phase([a, b, e], 0)] == ["Trail"]
    assert [p.name for p in paths_as_of_phase([a, b, e], 1)] == ["Quick", "Trail"]
    # Once the rebuild's phase arrives, it replaces the quick-build.
    assert [p.name for p in paths_as_of_phase([a, b, e], 2)] == ["Rebuild", "Trail"]


def test_render_phase_exports_writes_pngs_and_gif(tmp_path):
    paths = [_p("A", 1), _p("B", 2),
             _p("Trail", None, status="existing",
                geometry=[(42.42, -71.03), (42.43, -71.03)])]
    render_phase_exports(_net(paths), BOUNDARY, tmp_path, basemap=False,
                         dpi=40, gif_dpi=30)
    assert (tmp_path / "map-phase-1.png").exists()
    assert (tmp_path / "map-phase-2.png").exists()
    assert (tmp_path / "phases.gif").exists()
    from PIL import Image
    with Image.open(tmp_path / "phases.gif") as im:
        assert im.n_frames == 3  # Today + two phases
    # Intermediate frame files are cleaned up.
    assert not list(tmp_path.glob("*frame*"))


def test_spots_as_of_phase():
    built = Spot(kind="bike_parking", status="existing", location=(42.42, -71.06))
    later = Spot(kind="speed_hump", status="proposed", phase=2,
                 location=(42.42, -71.06))
    anytime = Spot(kind="raised_crosswalk", status="proposed",
                   location=(42.42, -71.06))  # proposed, no phase
    spots = [built, later, anytime]
    assert spots_as_of_phase(spots, 0) == [built]
    assert spots_as_of_phase(spots, 1) == [built, anytime]
    assert spots_as_of_phase(spots, 2) == spots


def test_render_all_draws_and_clips_spots(tmp_path):
    net = _net([_p("A", 1)])
    net.spots = [
        Spot(name="Square hump", kind="speed_hump", status="proposed", phase=1,
             location=(42.42, -71.06)),
        Spot(kind="bike_parking", status="existing",
             location=(42.60, -71.06)),  # far outside the boundary
    ]
    render_all(net, BOUNDARY, tmp_path, basemap=False)
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert "spot-glyph" in html and "Spot improvements" in html
    fc = json.loads((tmp_path / "network.geojson").read_text(encoding="utf-8"))
    points = [f for f in fc["features"] if f["geometry"]["type"] == "Point"]
    assert [f["properties"]["kind"] for f in points] == ["speed_hump"]
    assert net.spots[0].name == "Square hump"  # source net not mutated
    assert (tmp_path / "map.png").exists()


def test_html_has_phase_slider_when_phased(tmp_path):
    a = _p("Quick", 1, id="a")
    b = _p("Rebuild", 2, upgrades="a",
           geometry=[(42.42, -71.07), (42.43, -71.06)])
    render_all(_net([a, b]), BOUNDARY, tmp_path, basemap=False)
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert "phase-slider" in html
    # Phased grouping: LayerControl lists per-phase groups.
    assert "Phase 1: Core" in html and "Phase 2: More" in html
    assert "setText" not in html  # still no folium plugins (TextPath history)


def test_html_has_no_slider_without_phases(tmp_path):
    e = _p("Trail", None, status="existing")
    net = Network(city="Malden", paths=[e])
    render_all(net, BOUNDARY, tmp_path, basemap=False)
    html = (tmp_path / "map.html").read_text(encoding="utf-8")
    assert "phase-slider" not in html


def test_render_all_rejects_unknown_color_mode(tmp_path):
    with pytest.raises(ValueError):
        render_all(_net([_p("A")]), BOUNDARY, tmp_path, basemap=False,
                   color_mode="rainbow")
