"""The PNG basemap: OpenFreeMap "Bright", rendered in a headless browser.

OpenFreeMap serves only vector tiles (no keys, no limits; see AGENTS.md
"Basemap" for why CARTO went), and Python has no Windows-friendly renderer for
them — pymgl, the MapLibre Native wrapper, ships no Windows wheels. So this
drives headless Chromium through Playwright to run web/js/basemap.js's
renderBasemap(): the very code the web app's PNG export uses, so the camera
math, the label scale and the style URL live in one place. The page is served
from a made-up origin that Playwright answers itself; only the style, tiles
and MapLibre come from the network.

Needs `pip install playwright` and, once, `python -m playwright install
--only-shell chromium`. Anything missing or failing (offline, no browser)
means no basemap — render_map then keeps its plain background, as it always
has offline. Never an exception.
"""
from __future__ import annotations

import base64
import io
import time
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BASEMAP_JS = ROOT / "web" / "js" / "basemap.js"
ORIGIN = "http://basemap.localhost/"   # answered by page.route, never resolved

# Plain-text credit for the image (web/test/basemap.test.js keeps it equal to
# BASEMAP.attributionText in basemap.js).
ATTRIBUTION = "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors"

Extent = Tuple[float, float, float, float]   # mercator x0, x1, y0, y1

# Recent results, so per-phase PNGs and every GIF frame (same extent) share
# one browser launch. Failures are remembered briefly too: a GIF must not
# relaunch a browser per frame while offline, but a later export should retry.
_cache: dict = {}            # key -> (time, image or None)
_CACHE_SIZE = 2
_FAILURE_TTL_S = 60.0

_RENDER_JS = """async ({view, width, height, imagePx}) => {
  const m = await import("/basemap.js");
  await new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = m.BASEMAP.maplibreJs; s.onload = ok; s.onerror = fail;
    document.head.append(s);
  });
  const canvas = await m.renderBasemap(view, width, height,
    { pixelRatio: m.basemapPixelRatio(imagePx) });
  return canvas ? canvas.toDataURL("image/png") : null;
}"""


def render_basemap(extent: Extent, width_px: int, height_px: int,
                   image_px: int) -> Optional[np.ndarray]:
    """An RGB(A) image of the basemap exactly covering `extent`, or None.
    `image_px` is the long side of the whole figure: it sets the label scale
    (2x on the print, smaller on GIF frames) just as the web PNG does."""
    key = (tuple(round(v, 3) for v in extent), width_px, height_px, image_px)
    hit = _cache.get(key)
    if hit and (hit[1] is not None or time.monotonic() - hit[0] < _FAILURE_TTL_S):
        return hit[1]
    try:
        img = _render_in_browser(extent, width_px, height_px, image_px)
    except Exception as e:        # no playwright / no browser / offline
        print(f"  (map basemap skipped: {e})")
        img = None
    _cache[key] = (time.monotonic(), img)
    while len(_cache) > _CACHE_SIZE:
        _cache.pop(next(iter(_cache)))
    return img


def _render_in_browser(extent: Extent, width_px: int, height_px: int,
                       image_px: int) -> Optional[np.ndarray]:
    from playwright.sync_api import sync_playwright
    from matplotlib import image as mpimg

    x0, x1, y0, y1 = extent
    view = {"minX": x0, "maxX": x1, "minY": y0, "maxY": y1,
            "scale": width_px / (x1 - x0)}
    module = BASEMAP_JS.read_text(encoding="utf-8")

    def serve(route):
        if route.request.url.endswith("/basemap.js"):
            route.fulfill(body=module, content_type="text/javascript")
        else:
            route.fulfill(body="<!doctype html><html><body></body></html>",
                          content_type="text/html")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.route(ORIGIN + "**", serve)
            page.goto(ORIGIN)
            data_url = page.evaluate(_RENDER_JS, {
                "view": view, "width": width_px, "height": height_px,
                "imagePx": image_px})
        finally:
            browser.close()
    if not data_url:
        raise RuntimeError("the basemap did not load")
    png = base64.b64decode(data_url.split(",", 1)[1])
    return mpimg.imread(io.BytesIO(png), format="png")
