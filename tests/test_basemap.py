"""The PNG basemap: OpenFreeMap Bright, rendered by running web/js/basemap.js
in headless Chromium (bikenetwork/basemap.py), drawn under the network by
render_map. All offline: the browser is never launched here — the render is
stubbed at its seam, so these pin how the image is used, and that every
failure falls back to the plain background."""
import sys

import numpy as np
from matplotlib import image as mpimg

from bikenetwork import basemap as bm
from bikenetwork import render_map as rm
from bikenetwork.network_format import BikePath, Network, PhaseDef

MAGENTA = np.array([1.0, 0.0, 1.0])
# The "plain background" is the figure's white: set_axis_off() hides the axes
# patch, so its #eef0ef facecolor never actually shows.
PLAIN = np.array([1.0, 1.0, 1.0])


def _net():
    p = BikePath("Spine", on_street="Spine", phase=1,
                 type="quick_build_separated", status="proposed")
    p.segments = [[(42.42, -71.07), (42.43, -71.06)]]
    p.length_miles = 1.0
    return [p], Network(city="Malden", phases=[PhaseDef(1, "Core", "2029")])


BOUNDARY = [[(42.40, -71.09), (42.45, -71.09), (42.45, -71.02), (42.40, -71.02)]]


def _share(png_path, color):
    """Fraction of the image's pixels within a hair of `color`."""
    px = mpimg.imread(png_path)[..., :3]
    return float(np.mean(np.all(np.abs(px - color) < 0.02, axis=-1)))


def test_render_map_draws_the_basemap_under_the_network(tmp_path, monkeypatch):
    calls = []

    def fake(extent, width_px, height_px, image_px):
        calls.append((extent, width_px, height_px, image_px))
        return np.ones((height_px, width_px, 3)) * MAGENTA

    monkeypatch.setattr(rm, "render_basemap", fake)
    paths, net = _net()
    out = tmp_path / "map.png"
    rm.render_map(paths, net, out, boundary=BOUNDARY, basemap=True, dpi=40)

    assert len(calls) == 1
    (x0, x1, y0, y1), w, h, image_px = calls[0]
    # Asked for the map's own extent, at a matching aspect ratio.
    assert x0 < x1 and y0 < y1
    assert abs(w / h - (x1 - x0) / (y1 - y0)) < 0.01
    assert image_px == 16 * 40          # long side of the figure, in pixels
    # And it fills the map: most of the image is the basemap's color.
    assert _share(out, MAGENTA) > 0.5


def test_no_basemap_means_the_plain_background(tmp_path, monkeypatch):
    monkeypatch.setattr(rm, "render_basemap", lambda *a: None)
    paths, net = _net()
    out = tmp_path / "map.png"
    rm.render_map(paths, net, out, boundary=BOUNDARY, basemap=True, dpi=40)
    assert _share(out, PLAIN) > 0.5


def test_basemap_false_never_asks_for_one(tmp_path, monkeypatch):
    def boom(*a):
        raise AssertionError("basemap=False must not render a basemap")
    monkeypatch.setattr(rm, "render_basemap", boom)
    paths, net = _net()
    rm.render_map(paths, net, tmp_path / "m.png", boundary=BOUNDARY,
                  basemap=False, dpi=40)


def test_missing_playwright_is_no_basemap_not_an_error(monkeypatch):
    bm._cache.clear()
    monkeypatch.setitem(sys.modules, "playwright.sync_api", None)  # ImportError
    assert bm.render_basemap((0, 1000, 0, 1000), 100, 100, 100) is None


def test_renders_are_cached_so_frames_share_one_browser_launch(monkeypatch):
    bm._cache.clear()
    launches = []

    def fake_browser(extent, width_px, height_px, image_px):
        launches.append(extent)
        return np.zeros((height_px, width_px, 3))

    monkeypatch.setattr(bm, "_render_in_browser", fake_browser)
    a = bm.render_basemap((0, 1000, 0, 1000), 100, 100, 900)
    b = bm.render_basemap((0, 1000, 0, 1000), 100, 100, 900)
    bm.render_basemap((0, 2000, 0, 1000), 200, 100, 900)
    assert a is b
    assert len(launches) == 2


def test_a_failed_render_is_not_retried_for_every_frame(monkeypatch):
    bm._cache.clear()
    launches = []

    def offline(*a):
        launches.append(a)
        raise RuntimeError("offline")

    monkeypatch.setattr(bm, "_render_in_browser", offline)
    for _ in range(5):
        assert bm.render_basemap((0, 1000, 0, 1000), 100, 100, 900) is None
    assert len(launches) == 1
