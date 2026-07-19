// The export pipeline — web port of bikenetwork/pipeline.render_all(). Clip
// to the city, then produce every artifact in memory: network.geojson,
// map.html, (in a browser) map.png, and a mileage summary with the same
// warnings/notices the desktop tool reports.
import { pathsToGeojson } from "./geojson.js";
import { segmentsMiles } from "./geometry.js";
import { clipPaths, summarize } from "./pipeline.js";
import { COLOR_MODES } from "./render_common.js";
import { renderHtml } from "./render_html.js";

// `boundaryRings` are the raw boundary ways (drawn on maps); `clipRing` is the
// precomputed city polygon ring (used for clipping). `renderPng` is injected
// (it needs a DOM canvas, so Node tests pass none). Returns
// { geojson, html, pngBlob, summary }.
export async function buildArtifacts(net, boundaryRings, clipRing, {
  colorMode = "type",
  renderPng = null,
} = {}) {
  if (!COLOR_MODES.includes(colorMode)) {
    throw new Error(`color_mode must be one of ${COLOR_MODES.join(", ")} (got '${colorMode}')`);
  }
  const warnings = [];
  const notices = [];

  let paths = net.paths.map((p) => ({ ...p }));
  for (const p of paths) {
    if (!p.length_miles && p.segments.some((s) => s.length >= 2)) {
      p.length_miles = segmentsMiles(p.segments);
    }
  }
  if (clipRing && clipRing.length >= 3) {
    paths = clipPaths(paths, clipRing, warnings, notices);
  }

  const geojson = pathsToGeojson(paths);
  const html = renderHtml(paths, net, { boundary: boundaryRings, colorMode });
  const pngBlob = renderPng
    ? await renderPng(paths, net, { boundary: boundaryRings, colorMode })
    : null;

  const summary = summarize(paths, net);
  summary.warnings = warnings;
  summary.notices = notices;
  return { geojson, html, pngBlob, summary };
}
