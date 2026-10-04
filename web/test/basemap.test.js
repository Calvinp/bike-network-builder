// The basemap is OpenFreeMap "Bright" vector tiles drawn by MapLibre GL (via
// the maplibre-gl-leaflet plugin) on every surface: both editors and the
// exported map.html. CARTO started answering keyless requests with an "API KEY
// REQUIRED" tile (2026-10) — with a 200 status, so nothing errored, the maps
// just went blank — and the static site has no server to keep a key private.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASEMAP, basemapCamera, basemapPixelRatio, renderBasemap,
} from "../js/basemap.js";
import { WEB_MERCATOR_R, lonlatToMercator } from "../js/geometry.js";
import { renderHtml } from "../js/render_html.js";
import { makeNetwork, makePath } from "../js/network_format.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SURFACES = {
  "web/index.html": read("../index.html"),
  "web/app.js": read("../app.js"),
  "editor/index.html": read("../../editor/index.html"),
  "editor/app.js": read("../../editor/app.js"),
  "bikenetwork/render_html.py": read("../../bikenetwork/render_html.py"),
  "web/js/render_png.js": read("../js/render_png.js"),
};

function exportedHtml() {
  const path = makePath({ name: "Main", on_street: "Main", phase: 1,
    status: "proposed", type: "quick_build_separated",
    segments: [[[42.42, -71.07], [42.43, -71.06]]] });
  path.length_miles = 0.8;
  return renderHtml([path], makeNetwork({ city: "Malden", paths: [path] }));
}

test("the basemap is OpenFreeMap Bright, credited as its terms require", () => {
  assert.equal(BASEMAP.style, "https://tiles.openfreemap.org/styles/bright");
  for (const credit of ["OpenFreeMap", "OpenMapTiles", "OpenStreetMap"]) {
    assert.ok(BASEMAP.attribution.includes(credit), `attribution lacks ${credit}`);
  }
});

for (const [name, src] of Object.entries({ ...SURFACES, "map.html": exportedHtml() })) {
  test(`${name}: no CARTO tiles left`, () => {
    assert.ok(!src.includes("cartocdn"), "still requests CARTO tiles");
    assert.ok(!/CartoDB/i.test(src), "still names a CARTO folium tileset");
  });
}

// The Flask editor and the Python export can't import the JS module, so they
// carry their own copy of the style URL (as they do the palette).
for (const name of ["editor/app.js", "bikenetwork/render_html.py"]) {
  test(`${name}: uses the same basemap style as web/js/basemap.js`, () => {
    assert.ok(SURFACES[name].includes(BASEMAP.style));
  });
}

// The plugin extends L, so it must load after Leaflet; maplibre-gl must load
// before the plugin; and both before whatever builds the map.
for (const [name, html] of Object.entries({
  "web/index.html": SURFACES["web/index.html"],
  "editor/index.html": SURFACES["editor/index.html"],
  "map.html": exportedHtml(),
})) {
  test(`${name}: loads Leaflet, then MapLibre, then the plugin, then the map`, () => {
    const at = (needle) => {
      const i = html.indexOf(needle);
      assert.ok(i >= 0, `${needle} not loaded`);
      return i;
    };
    const leaflet = at(BASEMAP.leafletJs);
    const maplibre = at(BASEMAP.maplibreJs);
    const plugin = at(BASEMAP.pluginJs);
    at(BASEMAP.maplibreCss);
    const map = html.search(/app\.js"|L\.map\(/);
    assert.ok(leaflet < plugin && maplibre < plugin && plugin < map,
              "scripts are out of order");
  });
}

for (const [name, call] of [["web/app.js", /basemapLayer\(L\)\.addTo\(map\)/],
                            ["editor/app.js", /L\.maplibreGL\(/]]) {
  test(`${name}: draws the basemap with MapLibre, not a raster tile layer`, () => {
    const src = SURFACES[name];
    assert.match(src, call);
    assert.doesNotMatch(src, /L\.tileLayer\(/);
  });
}

test("web/app.js takes the basemap from basemap.js (one setting to change)", () => {
  assert.match(SURFACES["web/app.js"], /from "\.\/js\/basemap\.js"/);
});

// ---- PNG export: the basemap rendered off-screen by MapLibre ------------- //

// render_png's view: mercator bounds plus canvas pixels per mercator meter.
function viewOf([lat0, lon0], [lat1, lon1], widthPx) {
  const [minX, minY] = lonlatToMercator(lat0, lon0);
  const [maxX, maxY] = lonlatToMercator(lat1, lon1);
  return { minX, maxX, minY, maxY, scale: widthPx / (maxX - minX) };
}

test("the PNG basemap camera centers on the view and matches its scale", () => {
  const view = viewOf([42.40, -71.09], [42.45, -71.02], 4000);
  const cam = basemapCamera(view, 2);
  const [lon, lat] = cam.center;
  const [cx, cy] = lonlatToMercator(lat, lon);
  assert.ok(Math.abs(cx - (view.minX + view.maxX) / 2) < 1e-6);
  assert.ok(Math.abs(cy - (view.minY + view.maxY) / 2) < 1e-6);
  // MapLibre's world is 512 * 2^zoom CSS px wide; at pixelRatio 2 every CSS
  // px is 2 canvas px, so the world must span exactly scale * circumference.
  const worldCanvasPx = 512 * 2 ** cam.zoom * 2;
  const expected = 2 * Math.PI * WEB_MERCATOR_R * view.scale;
  assert.ok(Math.abs(worldCanvasPx / expected - 1) < 1e-9);
});

test("a smaller image zooms out instead of shrinking the map's labels", () => {
  const big = basemapCamera(viewOf([42.40, -71.09], [42.45, -71.02], 4000), 2);
  const small = basemapCamera(viewOf([42.40, -71.09], [42.45, -71.02], 1000), 2);
  assert.ok(Math.abs(big.zoom - small.zoom - 2) < 1e-9);   // 4x smaller = 2 zooms
});

test("no MapLibre (offline, or node) means no basemap rather than an error", async () => {
  const view = viewOf([42.40, -71.09], [42.45, -71.02], 400);
  assert.equal(await renderBasemap(view, 400, 400, { maplibregl: null }), null);
});

test("web/js/render_png.js draws the basemap through renderBasemap", () => {
  assert.match(SURFACES["web/js/render_png.js"], /renderBasemap\(/);
});

test("basemap labels are 2x on the print and shrink toward 1x for small images", () => {
  assert.equal(basemapPixelRatio(4000), 2);           // the 16 in @ 250 dpi print
  assert.equal(basemapPixelRatio(250), 1);            // never below 1x
  const gif = basemapPixelRatio(900);
  assert.ok(gif >= 1 && gif < 2);
  assert.ok(basemapPixelRatio(2000) > gif);
});

// The Python PNG renders the basemap by running THIS module in a headless
// browser; it only keeps its own copy of the credit line.
test("bikenetwork/basemap.py credits the basemap exactly as the web PNG does", () => {
  assert.ok(read("../../bikenetwork/basemap.py").includes(BASEMAP.attributionText));
});

test("bikenetwork/render_map.py: no CARTO tiles left", () => {
  const src = read("../../bikenetwork/render_map.py");
  assert.ok(!src.includes("cartocdn") && !/CartoDB|contextily/.test(src));
});
