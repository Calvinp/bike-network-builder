// The basemap: OpenFreeMap "Bright" vector tiles, drawn by MapLibre GL inside
// Leaflet through the maplibre-gl-leaflet plugin. The ONE place the JS side
// names its basemap; editor/app.js and bikenetwork/render_html.py keep copies
// of the style URL (test-enforced, like the palette).
//
// Why not CARTO any more: in 2026-10 CARTO began answering keyless requests
// with an "API KEY REQUIRED" tile — status 200, so nothing errored, the map
// just went blank — and this app is a static site with no server to keep a
// key private. OpenFreeMap needs no key, no sign-up and sets no request
// limits; it runs on donations, so the polite thing is to sponsor it. If the
// tool outgrows a public service, self-host a Malden-only tile file instead
// (see AGENTS.md, "Basemap") and change `style` here.
//
// MapLibre is pinned to 5.x: 6.x ships only as an ES module, and the plugin
// expects the `maplibregl` global that the 5.x UMD build defines.
export const BASEMAP = {
  style: "https://tiles.openfreemap.org/styles/bright",
  attribution:
    '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> '
    + '&copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> '
    + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">'
    + "OpenStreetMap</a>",
  leafletJs: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  maplibreJs: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
  maplibreCss: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
  pluginJs: "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js",
};

// Leaflet layer for the basemap. `L` is the page's global Leaflet; the
// plugin script must already have loaded (it adds L.maplibreGL).
export function basemapLayer(L) {
  return L.maplibreGL({ style: BASEMAP.style, attribution: BASEMAP.attribution });
}
