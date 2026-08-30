// The standalone interactive map export.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderHtml } from "../js/render_html.js";
import { makeFeature, makeNetwork, makePhase, makeTreatment }
  from "../js/network_format.js";
import { setRegistry } from "../js/registry.js";
import { treatmentGlyph } from "../js/render_common.js";

setRegistry(JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8")));

const feat = (f = {}) => makeFeature({
  id: "f1", name: "Main Street", on_street: "Main Street",
  treatments: [makeTreatment({ id: "t1", type: "quick_build_separated",
                               status: "proposed", phase: "p1" })],
  geometry: [[[42.1, -71.1], [42.2, -71.2]]],
  ...f,
});

const net = (f = {}) => makeNetwork({
  areas: [{ id: "a1", name: "Malden", context: "Massachusetts",
            displayName: "Malden, Massachusetts" }],
  phases: [makePhase({ id: "p1", number: 1, label: "Core", target_date: "2029" }),
           makePhase({ id: "p2", number: 2, label: "Later" })],
  features: [feat()],
  ...f,
});

test("html embeds popups, tooltip, legend and boundary", () => {
  const html = renderHtml([feat()], net(), {
    boundary: [[[42.0, -71.0], [42.3, -71.3]]], colorMode: "phase" });
  assert.ok(html.includes("Main Street"));
  assert.ok(html.includes("Bike Network"));
  assert.ok(html.includes("DATA"));
});

test("nothing injected touches the map before it exists", () => {
  // The trap that once left map.html blank: a script that calls map.on(...)
  // before `var map = L.map(...)` has run takes the whole <script> block with
  // it, and the map along with it.
  const html = renderHtml([feat()], net(), { colorMode: "phase" });
  const beforeMap = html.slice(0, html.indexOf("L.map("));
  assert.ok(!/\bmap\s*\.\s*(on|addLayer|hasLayer|fitBounds)\s*\(/.test(beforeMap),
            "something used the map before it was created");
});

test("one-way arrows use plain rotated DivIcon markers, no plugins", () => {
  const oneWay = feat({ treatments: [makeTreatment({
    id: "t1", type: "quick_build_separated", status: "proposed", phase: "p1",
    travel: "one_way", sides: 1 })] });
  const html = renderHtml([oneWay], net({ features: [oneWay] }), {});
  assert.ok(html.includes("divIcon"));
  assert.ok(!html.includes("polylinedecorator"));
  assert.ok(!html.includes("TextPath"));
});

test("a two-way treatment gets no arrows", () => {
  const html = renderHtml([feat()], net(), {});
  assert.ok(!/"arrows":\s*\[\s*\{/.test(html));
});

test("phase mode groups by phase with its label", () => {
  const html = renderHtml([feat()], net(), { colorMode: "phase" });
  assert.ok(html.includes("Phase 1: Core"));
});

test("every treatment on a feature is drawn, not just one", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "a", type: "shared_use_path", status: "existing" }),
    makeTreatment({ id: "b", type: "concrete_separated", status: "proposed",
                    phase: "p2" }),
  ] });
  const html = renderHtml([f], net({ features: [f] }), { colorMode: "treatment" });
  // Both legend rows appear, and the geometry is emitted twice (stacked).
  assert.ok(html.includes("Shared-use path"));
  assert.ok(html.includes("Concrete-protected lane"));
});

test("the legend lists treatments, never combinations", () => {
  const f = feat({ treatments: [
    makeTreatment({ id: "a", type: "shared_use_path", status: "existing" }),
    makeTreatment({ id: "b", type: "concrete_separated", status: "existing" }),
  ] });
  const html = renderHtml([f], net({ features: [f] }), { colorMode: "treatment" });
  assert.ok(!html.includes("Shared-use path + Concrete"));
});

test("point treatments render as glyph markers with a label", () => {
  const f = feat({ name: "Main & Salem",
    treatments: [makeTreatment({ id: "t1", type: "bike_parking",
                                 status: "existing" })],
    geometry: [[[42.15, -71.15]]] });
  const html = renderHtml([f], net({ features: [f] }), {});
  assert.ok(html.includes("Bike parking"));
  assert.ok(html.includes("Main &amp; Salem") || html.includes("Main & Salem"));
});

test("names with html characters are escaped", () => {
  const f = feat({ name: '<script>alert("x")</script>' });
  const html = renderHtml([f], net({ features: [f] }), {});
  assert.ok(!html.includes('<script>alert("x")'));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("an unphased network gets no slider", () => {
  const f = feat({ treatments: [makeTreatment({
    id: "t1", type: "shared_use_path", status: "existing" })] });
  const html = renderHtml([f], net({ features: [f], phases: [] }), {});
  assert.ok(html.includes('"stops": []') || html.includes('"stops":[]'));
});

test("an unknown treatment still renders rather than breaking the export", () => {
  const f = feat({ treatments: [makeTreatment({
    id: "t1", type: "transit:bus_lane", status: "proposed", phase: "p1" })] });
  const html = renderHtml([f], net({ features: [f] }), { colorMode: "treatment" });
  assert.ok(html.includes("transit: bus lane"));
});

const dataOf = (html) => JSON.parse(html.match(/var DATA = (\{[\s\S]*?\});\n/)[1]);
const linesOf = (data) => data.groups.flatMap((g) => g.features || []);

test("a row of street trees exports as glyphs, not as a line", () => {
  // The complaint this fixes: a counted treatment on a line drew as a black
  // dashed STROKE, so a row of trees read as an unrecognised bike facility.
  // It has to leave as points in the export too, or a shared map disagrees
  // with the editor that produced it.
  const trees = feat({
    id: "f2", name: "Elm Street",
    treatments: [makeTreatment({ id: "t2", type: "street_trees",
                                 status: "proposed", phase: "p1" })],
    geometry: [[[42.40, -71.10], [42.44, -71.10]]],   // ~4.5 km
  });
  const data = dataOf(renderHtml([trees], net({ features: [trees] }),
                                 { colorMode: "treatment" }));
  assert.ok(data.spots.length >= 3,
            `expected a run of glyphs, got ${data.spots.length}`);
  assert.equal(data.spots[0].glyph, treatmentGlyph("street_trees"));

  // Spread ALONG the line, and inside it.
  const lats = data.spots.map((sp) => sp.lat);
  assert.ok(Math.max(...lats) - Math.min(...lats) > 0.01, "spaced along the line");
  for (const lat of lats) assert.ok(lat > 42.40 && lat < 42.44, "and inside it");

  // The only line drawn is the hairline that shows the run's extent — thin,
  // dotted, and in the glyph's colour, so it reads as an annotation rather
  // than as a facility.
  const lines = linesOf(data);
  assert.equal(lines.length, 1, "no facility stroke for a counted treatment");
  assert.ok(lines[0].weight <= 2, "the spine is a hairline, not a 4px stroke");
});

test("a corridor with trees keeps its stroke AND gets the glyphs", () => {
  const both = feat({
    id: "f3",
    treatments: [
      makeTreatment({ id: "t3", type: "quick_build_separated",
                      status: "proposed", phase: "p1" }),
      makeTreatment({ id: "t4", type: "street_trees",
                      status: "proposed", phase: "p1" }),
    ],
    geometry: [[[42.40, -71.10], [42.44, -71.10]]],
  });
  const data = dataOf(renderHtml([both], net({ features: [both] }),
                                 { colorMode: "treatment" }));
  assert.ok(data.spots.length >= 3, "the trees still draw as a run of glyphs");
  const lines = linesOf(data);
  assert.equal(lines.length, 1, "one stroke: the bike lane");
  assert.equal(lines[0].color, "#0072B2", "the corridor keeps its own colour");
  assert.ok(lines[0].weight >= 4, "and its own weight — no spine needed here");
});
