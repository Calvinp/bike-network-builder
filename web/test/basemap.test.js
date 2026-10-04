// The basemap is OpenFreeMap "Bright" vector tiles drawn by MapLibre GL (via
// the maplibre-gl-leaflet plugin) on every surface: both editors and the
// exported map.html. CARTO started answering keyless requests with an "API KEY
// REQUIRED" tile (2026-10) — with a 200 status, so nothing errored, the maps
// just went blank — and the static site has no server to keep a key private.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASEMAP } from "../js/basemap.js";
import { renderHtml } from "../js/render_html.js";
import { makeNetwork, makePath } from "../js/network_format.js";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const SURFACES = {
  "web/index.html": read("../index.html"),
  "web/app.js": read("../app.js"),
  "editor/index.html": read("../../editor/index.html"),
  "editor/app.js": read("../../editor/app.js"),
  "bikenetwork/render_html.py": read("../../bikenetwork/render_html.py"),
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
