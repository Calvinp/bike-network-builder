// Tests for the standalone HTML export — mirrors the html-related checks in
// tests/test_pipeline.py (dir-arrow markers, no TextPath plugin) plus content
// spot-checks.
import test from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../js/render_html.js";
import { makeNetwork, makePath, makePhase } from "../js/network_format.js";

function net(paths) {
  return makeNetwork({
    city: "Malden",
    phases: [makePhase(1, "Core", "2029")],
    paths,
  });
}

function p(name, over = {}) {
  const path = makePath({ name, on_street: name, phase: 1, status: "proposed",
    type: "quick_build_separated",
    segments: [[[42.42, -71.07], [42.43, -71.06]]], ...over });
  path.length_miles = 0.8;
  return path;
}

test("one-way arrows use plain rotated DivIcon markers, no plugins", () => {
  const html = renderHtml([p("OneWay", { directions: 1 })], net([]));
  assert.ok(html.includes("dir-arrow"));
  assert.ok(!html.includes("setText"));
  assert.ok(!html.toLowerCase().replace(/-/g, "_").includes("polyline_text_path"));
});

test("html embeds popups, tooltip, legend and boundary", () => {
  const paths = [p("Main Street"), p("Trail", { status: "existing", phase: null })];
  const html = renderHtml(paths, net(paths),
    { boundary: [[[42.4, -71.09], [42.4, -71.02]]], colorMode: "type" });
  assert.ok(html.includes("Main Street"));
  assert.ok(html.includes("Malden Bike Network"));          // legend title
  assert.ok(html.includes("Existing infrastructure"));      // group + legend
  assert.ok(html.includes("boundary"));
  assert.ok(html.includes("Quick-build separated lane"));
  assert.ok(html.includes("0.80 mi"));
});

test("phase mode groups by phase with label", () => {
  const paths = [p("Main"), p("Hwy", { jurisdiction: "state" })];
  const html = renderHtml(paths, net(paths), { colorMode: "phase" });
  assert.ok(html.includes("Phase 1: Core"));
  assert.ok(html.includes("MassDOT"));
});

test("names with html characters are escaped", () => {
  const html = renderHtml([p('<img src=x onerror=alert(1)>')], net([]));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});
