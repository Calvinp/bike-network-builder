// Tests for the export pipeline — mirrors the render_all checks in
// tests/test_pipeline.py that apply without a filesystem or a canvas.
import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifacts } from "../js/export.js";
import { makeNetwork, makePath, makePhase } from "../js/network_format.js";

const CLIP_RING = [[42.40, -71.09], [42.45, -71.09], [42.45, -71.02],
                   [42.40, -71.02], [42.40, -71.09]];
const BOUNDARY_RINGS = [CLIP_RING];

function p(name, geometry, over = {}) {
  return makePath({ name, on_street: name, phase: 1, status: "proposed",
    type: "quick_build_separated", segments: [geometry], ...over });
}

function net(paths) {
  return makeNetwork({ city: "Malden",
    phases: [makePhase(1, "Core", "2029"), makePhase(2, "More", "2032")], paths });
}

test("buildArtifacts produces geojson/html/summary and keeps duplicates", async () => {
  const paths = [
    p("New corridor", [[42.41, -71.07], [42.42, -71.06]]),
    p("New corridor", [[42.43, -71.05], [42.44, -71.04]]),
    p("Trail", [[42.42, -71.03], [42.43, -71.03]], { status: "existing", phase: null }),
  ];
  const source = net(paths);
  const { geojson, html, pngBlob, summary } =
    await buildArtifacts(source, BOUNDARY_RINGS, CLIP_RING);
  assert.equal(geojson.features.length, 3);      // duplicates did NOT collapse
  assert.ok(summary.total_build_miles > 0);
  assert.ok(html.includes("Trail"));
  assert.equal(pngBlob, null);                   // no canvas in Node
  // The source network is not mutated (clipping happens on copies).
  assert.deepEqual(source.paths[0].segments, [[[42.41, -71.07], [42.42, -71.06]]]);
  assert.equal(source.paths[0].length_miles, 0);
});

test("buildArtifacts warns about dropped outside paths", async () => {
  const paths = [
    p("In", [[42.42, -71.07], [42.43, -71.06]]),
    p("Out", [[42.50, -71.07], [42.52, -71.06]]),
  ];
  const { geojson, summary } = await buildArtifacts(net(paths), BOUNDARY_RINGS, CLIP_RING);
  assert.equal(geojson.features.length, 1);
  assert.ok(summary.warnings.some((w) => w.includes("Out")));
});

test("buildArtifacts rejects unknown color mode", async () => {
  await assert.rejects(
    () => buildArtifacts(net([p("A", [[42.42, -71.07], [42.43, -71.06]])]),
                         BOUNDARY_RINGS, CLIP_RING, { colorMode: "rainbow" }),
    /color_mode/);
});
