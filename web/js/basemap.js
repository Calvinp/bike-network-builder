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
  // The same credit as plain text, for images.
  attributionText: "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors",
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

// ---- PNG export ----------------------------------------------------------- //
// Vector tiles are not images, so the PNG exporter can't paste tiles onto its
// canvas the way it did CARTO's rasters. Instead MapLibre renders the exact
// extent in a hidden map, and its pixels are copied out once every tile has
// drawn. Self-contained on purpose: the only contract with the exporter is
// `view` (render_png's mercator bounds + canvas px per mercator meter).

const R = 6378137.0;   // EPSG:3857 sphere radius (meters)

// MapLibre center/zoom that puts `view` exactly edge to edge. MapLibre's
// world is 512 * 2^zoom CSS px wide; every CSS px is `pixelRatio` canvas px.
// The ratio is fixed (not scaled with the image) so labels keep a readable
// size and a smaller image shows the city zoomed out instead.
export function basemapCamera(view, pixelRatio) {
  const mx = (view.minX + view.maxX) / 2;
  const my = (view.minY + view.maxY) / 2;
  const lon = (mx / R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
  const zoom = Math.log2((2 * Math.PI * R * view.scale) / (512 * pixelRatio));
  return { center: [lon, lat], zoom };
}

// Basemap labels at 2x suit the 4000 px print; a small animation frame (whose
// own lines shrink with the image) would drown in them, so they shrink too —
// but only part way, and never below 1x, so they stay legible. Shared by the
// web PNG and the Python one (bikenetwork/basemap.py runs this module).
const PRINT_PX = 4000;
export function basemapPixelRatio(imageLongSidePx) {
  return Math.min(2, Math.max(1, 2 * Math.sqrt(imageLongSidePx / PRINT_PX)));
}

// Recent renders, so the per-phase PNGs and every GIF frame (all the same
// extent) cost one render instead of one each. Failures are remembered only
// briefly: a GIF must not wait out the timeout once per frame, but a later
// export, once back online, should try again.
const cache = [];   // [{ key, at, promise }], newest last
const FAILURE_TTL_MS = 60_000;

// A canvas of exactly width x height holding the basemap for `view`, or null
// if it can't be drawn (offline, no MapLibre, no WebGL, too slow). Callers
// fall back to a plain background, as the PNG always has offline.
export function renderBasemap(view, width, height, {
  maplibregl = globalThis.maplibregl,
  pixelRatio = 2,
  timeoutMs = 30_000,
} = {}) {
  if (!maplibregl || typeof document === "undefined") return Promise.resolve(null);
  const key = [view.minX, view.maxX, view.minY, view.maxY, view.scale, width, height]
    .join(",");
  const hit = cache.find((c) => c.key === key);
  if (hit) {
    if (!hit.failed || Date.now() - hit.at < FAILURE_TTL_MS) return hit.promise;
    cache.splice(cache.indexOf(hit), 1);
  }
  const entry = { key, at: Date.now(), failed: false, promise: null };
  entry.promise = drawOffscreen(maplibregl, view, width, height, pixelRatio, timeoutMs)
    .catch(() => null)
    .then((canvas) => { entry.failed = !canvas; return canvas; });
  cache.push(entry);
  if (cache.length > 2) cache.shift();
  return entry.promise;
}

function drawOffscreen(maplibregl, view, width, height, pixelRatio, timeoutMs) {
  const div = document.createElement("div");
  // Laid out (MapLibre sizes itself from the container) but off screen.
  div.style.cssText = `position:fixed; top:0; left:${-width - 100}px; `
    + `width:${width / pixelRatio}px; height:${height / pixelRatio}px; `
    + "pointer-events:none; visibility:hidden;";
  document.body.appendChild(div);
  const { center, zoom } = basemapCamera(view, pixelRatio);
  let map;
  return new Promise((resolve) => {
    map = new maplibregl.Map({
      container: div, style: BASEMAP.style, center, zoom, pixelRatio,
      interactive: false, attributionControl: false, fadeDuration: 0,
      // A 4000 px print exceeds the default 4096 cap once the legend band
      // is added; let the GPU's own limit decide instead.
      maxCanvasSize: [16384, 16384],
      // Keep the pixels readable after the frame is presented.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    const timer = setTimeout(() => resolve(null), timeoutMs);
    // A missing style means no basemap at all; a missing tile is just a gap.
    // (Not isStyleLoaded(): that also stays false while tiles are loading.)
    let styleLoaded = false;
    map.once("style.load", () => { styleLoaded = true; });
    map.on("error", () => { if (!styleLoaded) { clearTimeout(timer); resolve(null); } });
    map.once("idle", () => {
      clearTimeout(timer);
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      out.getContext("2d").drawImage(map.getCanvas(), 0, 0, width, height);
      resolve(out);
    });
  }).finally(() => {
    map?.remove();
    div.remove();
  });
}
