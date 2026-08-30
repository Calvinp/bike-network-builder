// The multi-treatment drawing rule.
//
// This file exists mainly to pin one thing: treatment list order is
// insignificant, so two files listing the same treatments in different orders
// MUST render identically. Without that test, "order doesn't matter" is a
// claim rather than a property.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BASE_WEIGHT,
  MAX_STACKED,
  MIN_STACK_ZOOM,
  dashFor,
  featureLayers,
  featureStrokes,
  glyphRunPoints,
  labelText,
  mapPalette,
  pointColor,
  strokeColor,
  treatmentColor,
  treatmentGlyph,
  treatmentLabel,
} from "../js/render_common.js";
import { makeFeature, makeTreatment } from "../js/network_format.js";
import { setRegistry } from "../js/registry.js";

setRegistry(JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8")));

const t = (f) => makeTreatment(f);
const withTreatments = (treatments) => makeFeature({
  name: "Corridor", treatments, geometry: [[[0, 0], [1, 1]]] });

const phaseNumberOf = (id) => ({ p1: 1, p2: 2, p4: 4 }[id] ?? null);

test("a feature draws EVERY treatment it carries", () => {
  const f = withTreatments([
    t({ id: "a", type: "shared_use_path", status: "existing" }),
    t({ id: "b", type: "streetcar", status: "proposed", phase: "p4" }),
  ]);
  assert.equal(featureStrokes(f, "treatment").length, 2);
});

test("shuffling the treatment list produces identical strokes", () => {
  const forward = withTreatments([
    t({ id: "a", type: "concrete_separated", status: "proposed", phase: "p1" }),
    t({ id: "b", type: "street_trees", status: "proposed", phase: "p1" }),
  ]);
  const reversed = withTreatments([
    t({ id: "b", type: "street_trees", status: "proposed", phase: "p1" }),
    t({ id: "a", type: "concrete_separated", status: "proposed", phase: "p1" }),
  ]);
  const strip = (s) => s.map(({ color, weight, dashArray, treatment }) =>
    ({ color, weight, dashArray, type: treatment.type }));
  assert.deepEqual(strip(featureStrokes(forward, "treatment")),
                   strip(featureStrokes(reversed, "treatment")));
});

test("nothing treats treatments[0] as primary", () => {
  // The lowest stack_rank is drawn FIRST (widest, underneath) regardless of
  // where it sits in the list.
  const f = withTreatments([
    t({ id: "a", type: "concrete_separated", status: "existing" }),  // rank 65
    t({ id: "b", type: "street_trees", status: "existing" }),        // rank 11
  ]);
  const strokes = featureStrokes(f, "treatment");
  assert.equal(strokes[0].treatment.type, "street_trees");
  assert.equal(strokes[strokes.length - 1].treatment.type, "concrete_separated");
});

test("strokes get narrower as they stack, so every layer stays visible", () => {
  const f = withTreatments([
    t({ id: "a", type: "concrete_separated", status: "existing" }),
    t({ id: "b", type: "street_trees", status: "existing" }),
  ]);
  const weights = featureStrokes(f, "treatment").map((s) => s.weight);
  assert.ok(weights[0] > weights[1]);
  assert.equal(weights[weights.length - 1], BASE_WEIGHT);
});

test("a zoomed-out map falls back to one stroke rather than mush", () => {
  const f = withTreatments([
    t({ id: "a", type: "concrete_separated", status: "existing" }),
    t({ id: "b", type: "street_trees", status: "existing" }),
  ]);
  const zoomedOut = featureStrokes(f, "treatment", { zoom: MIN_STACK_ZOOM - 1 });
  assert.equal(zoomedOut.length, 1);
  // The highest-ranked treatment is the one that survives.
  assert.equal(zoomedOut[0].treatment.type, "concrete_separated");
});

test("too many treatments also fall back to one stroke", () => {
  const many = ["concrete_separated", "street_trees", "bollards", "speed_hump"]
    .map((type, i) => t({ id: `x${i}`, type, status: "existing" }));
  assert.ok(many.length > MAX_STACKED);
  assert.equal(featureStrokes(withTreatments(many), "treatment").length, 1);
});

// --------------------------------------------------------------------------
// Colour modes
// --------------------------------------------------------------------------
test("treatment mode colours by the registry", () => {
  assert.equal(strokeColor(t({ type: "concrete_separated" }), "treatment"),
               treatmentColor("concrete_separated"));
});

test("single mode uses one colour for everything", () => {
  const a = strokeColor(t({ type: "concrete_separated" }), "single");
  const b = strokeColor(t({ type: "street_trees" }), "single");
  assert.equal(a, b);
});

test("phase mode colours the ask by phase and context by status", () => {
  const proposed = strokeColor(
    t({ type: "quick_build_separated", status: "proposed", phase: "p2" }),
    "phase", phaseNumberOf);
  const existing = strokeColor(
    t({ type: "quick_build_separated", status: "existing" }), "phase", phaseNumberOf);
  const funded = strokeColor(
    t({ type: "quick_build_separated", status: "funded" }), "phase", phaseNumberOf);
  const building = strokeColor(
    t({ type: "quick_build_separated", status: "under_construction" }),
    "phase", phaseNumberOf);
  assert.equal(new Set([proposed, existing, funded, building]).size, 4);
});

test("an unknown treatment draws neutrally rather than throwing", () => {
  assert.equal(strokeColor(t({ type: "transit:bus_lane" }), "treatment"), "#8c8c8c");
  assert.equal(treatmentGlyph("transit:bus_lane"), "?");
  assert.equal(treatmentLabel("transit:bus_lane"), "transit: bus lane");
});

// --------------------------------------------------------------------------
// Status is carried by line style, orthogonal to colour
// --------------------------------------------------------------------------
test("every status has its own dash pattern, and only existing is solid", () => {
  const patterns = ["existing", "under_construction", "funded", "proposed"]
    .map(dashFor);
  assert.equal(patterns[0], null);
  assert.equal(new Set(patterns.map(String)).size, 4);
});

// --------------------------------------------------------------------------
// Labels and palette
// --------------------------------------------------------------------------
test("a default name is not worth labelling", () => {
  assert.equal(labelText(makeFeature({ name: "New path" })), "");
  assert.equal(labelText(makeFeature({ name: "New path", on_street: "Main St" })),
               "Main St");
});

test("a trailing qualifier is dropped so parts share one label", () => {
  assert.equal(labelText(makeFeature({ name: "Main Street (Salem to Pleasant)" })),
               "Main Street");
});

test("the map palette includes every registry colour", () => {
  const palette = mapPalette();
  assert.ok(palette.includes(treatmentColor("concrete_separated")));
  assert.ok(palette.includes("#ffffff"));
});

test("a counted treatment on a line draws as glyphs, not as a stroke", () => {
  // The bug: treatmentColor falls back to POINT_PROPOSED_COLOR for a treatment
  // with no colour, so a row of street trees painted a black dashed LINE and
  // read as an unrecognised bike facility.
  const f = { treatments: [{ type: "street_trees", status: "proposed", phase: null }] };
  const { strokes, glyphRuns, spine } = featureLayers(f, "treatment", {});
  assert.equal(strokes.length, 0, "a counted treatment is not a stroke");
  assert.equal(glyphRuns.length, 1);
  assert.equal(glyphRuns[0].glyph, treatmentGlyph("street_trees"));
  assert.equal(spine, true, "with no stroke it needs a hairline to be visible");
});

test("a corridor keeps its stroke and carries its glyph run alongside", () => {
  const f = { treatments: [
    { type: "quick_build_separated", status: "proposed", phase: null },
    { type: "street_trees", status: "proposed", phase: null },
  ] };
  const { strokes, glyphRuns, spine } = featureLayers(f, "treatment", {});
  assert.deepEqual(strokes.map((s) => s.treatment.type), ["quick_build_separated"]);
  assert.deepEqual(glyphRuns.map((g) => g.treatment.type), ["street_trees"]);
  assert.equal(spine, false, "a real stroke already shows the extent");
});

test("glyph runs take the point colour, so one tree matches a row of them", () => {
  const existing = { treatments: [{ type: "street_trees", status: "existing" }] };
  const proposed = { treatments: [{ type: "street_trees", status: "proposed", phase: null }] };
  assert.equal(featureLayers(existing, "treatment", {}).glyphRuns[0].color,
               pointColor({ status: "existing" }));
  assert.equal(featureLayers(proposed, "treatment", {}).glyphRuns[0].color,
               pointColor({ status: "proposed" }));
});

test("glyph spacing is geographic, not per-vertex", () => {
  // The same line described with 2 points and with 41 must produce the same
  // row of trees — otherwise how you happened to click changes the drawing.
  const coarse = [[42.4, -71.0], [42.409, -71.0]];
  const fine = [];
  for (let i = 0; i <= 40; i++) fine.push([42.4 + (0.009 * i) / 40, -71.0]);
  const a = glyphRunPoints(coarse, 0.25, 24);
  const b = glyphRunPoints(fine, 0.25, 24);
  assert.equal(a.length, b.length);
  a.forEach((pt, i) => {
    assert.ok(Math.abs(pt[0] - b[i][0]) < 1e-6, `point ${i} lat differs`);
  });
});

test("glyph runs stay inside the line and respect the cap", () => {
  const part = [[42.4, -71.0], [42.5, -71.0]];      // ~11 km
  const pts = glyphRunPoints(part, 0.06, 20);
  assert.equal(pts.length, 20, "the cap is what stops a city map filling up");
  for (const [lat] of pts) {
    assert.ok(lat > 42.4 && lat < 42.5, "no glyph outside the part it belongs to");
  }
  assert.deepEqual(glyphRunPoints([[42.4, -71.0]], 0.06), [],
                   "a single point is not a run");
});
