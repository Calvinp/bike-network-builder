// Tests for the export pipeline — mirrors the render_all checks in
// tests/test_pipeline.py that apply without a filesystem or a canvas.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArtifacts, buildPhaseArtifacts, phaseStops,
} from "../js/export.js";
import {
  makeNetwork, makePath, makePhase, makeSpot,
} from "../js/network_format.js";

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

test("spots are clipped and ride along in the exported geojson", async () => {
  const n = net([p("A", [[42.41, -71.07], [42.42, -71.06]])]);
  n.spots = [
    makeSpot({ name: "In town", type: "speed_hump", phase: 1,
               location: [42.42, -71.06] }),
    makeSpot({ type: "bike_parking", status: "existing",
               location: [42.60, -71.06] }),   // far outside the boundary
  ];
  const { geojson, html } = await buildArtifacts(n, BOUNDARY_RINGS, CLIP_RING);
  const points = geojson.features.filter((f) => f.geometry.type === "Point");
  assert.deepEqual(points.map((f) => f.properties.type), ["speed_hump"]);
  assert.match(html, /Spot improvements/);
  assert.match(html, /spot-glyph/);
});

test("a phased network gets a slider; an unphased one does not", async () => {
  const phased = await buildArtifacts(
    net([p("A", [[42.41, -71.07], [42.42, -71.06]])]), BOUNDARY_RINGS, CLIP_RING);
  assert.match(phased.html, /phase-slider/);

  const flat = makeNetwork({ city: "Malden", paths: [
    p("Trail", [[42.41, -71.07], [42.42, -71.06]], { status: "existing", phase: null }),
  ] });
  const out = await buildArtifacts(flat, BOUNDARY_RINGS, CLIP_RING);
  assert.ok(!out.html.includes("phase-slider"));
});

test("context layers embed when small and are skipped with a notice when huge", async () => {
  const entry = { id: "bike-parking", label: "Bike parking (existing)",
                  style: { color: "#0072B2", radius: 4 } };
  const feature = { type: "Feature", properties: { capacity: "8", pad: "x".repeat(90) },
                    geometry: { type: "Point", coordinates: [-71.06, 42.42] } };
  const small = { entry, geojson: { type: "FeatureCollection", features: [feature] } };
  const n = net([p("A", [[42.41, -71.07], [42.42, -71.06]])]);

  const ok = await buildArtifacts(n, BOUNDARY_RINGS, CLIP_RING,
                                  { contextLayers: [small] });
  assert.match(ok.html, /Bike parking \(existing\)/);
  assert.deepEqual(ok.summary.notices, []);

  const huge = { entry, geojson: { type: "FeatureCollection",
                                   features: Array(5000).fill(feature) } };
  const capped = await buildArtifacts(n, BOUNDARY_RINGS, CLIP_RING,
                                      { contextLayers: [huge] });
  assert.ok(!capped.html.includes("Bike parking (existing)"));
  assert.ok(capped.summary.notices.some((s) => s.includes("left out")));
});

test("phaseStops walks Today then each phase with proposed work", () => {
  const paths = [p("A", [[42.41, -71.07], [42.42, -71.06]]),
                 p("B", [[42.41, -71.07], [42.42, -71.06]], { phase: 2 })];
  const stops = phaseStops(net(paths), paths);
  assert.deepEqual(stops.map((s) => s.n), [0, 1, 2]);
  assert.equal(stops[0].caption, "Today");
  assert.match(stops[1].caption, /^Phase 1: Core/);
});

test("phase artifacts need a canvas renderer, so they are empty without one", async () => {
  const paths = [p("A", [[42.41, -71.07], [42.42, -71.06]])];
  assert.deepEqual(
    await buildPhaseArtifacts(net(paths), BOUNDARY_RINGS, CLIP_RING), []);
});

test("a replaced path stays in map.html and returns if the upgrade is hidden", async () => {
  // The slider removes the old path when its replacement arrives, but the
  // reader can also untick the upgrade's phase in the layer list — and then
  // the corridor must fall back to what it replaced, not go blank.
  const geom = [[42.41, -71.07], [42.42, -71.06]];
  const old = p("Main Street", geom, { id: "main-1", directions: 1 });
  const up = p("Main Street rebuild", geom, { phase: 2, upgrades: "main-1" });
  const { html } = await buildArtifacts(net([old, up]), BOUNDARY_RINGS, CLIP_RING);
  // Both are still in the file (hiding is a runtime decision, not a filter).
  assert.match(html, /Main Street rebuild/);
  assert.match(html, /"Main Street"/);
  // ...and the decision consults whether the replacement is actually shown.
  assert.match(html, /replacement: groupLayers\[gi\]/);
  assert.match(html, /hasLayer\(h\.replacement\)/);
  // Unticking a box must not be undone by the slider re-asserting groups.
  assert.match(html, /overlayadd overlayremove/);
});
