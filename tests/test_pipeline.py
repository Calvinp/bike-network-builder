"""Tests for the shared pipeline: clipping, summarizing, and rendering all
outputs (offline — basemap disabled)."""
import json

import pytest
from bikenetwork.boundary import build_polygon
from bikenetwork.network_format import BikePath, Network, PhaseDef
from bikenetwork.pipeline import clip_paths, render_all, summarize

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


def test_render_all_rejects_unknown_color_mode(tmp_path):
    with pytest.raises(ValueError):
        render_all(_net([_p("A")]), BOUNDARY, tmp_path, basemap=False,
                   color_mode="rainbow")
