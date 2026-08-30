// The treatment registry — mirrors tests/test_registry.py.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KM_PER_MILE, Registry, registry, setRegistry, treatment,
         unknownTreatment } from "../js/registry.js";

const DOC = JSON.parse(readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8"));
const reg = Registry.fromDoc(DOC);

test("a known treatment carries everything a renderer needs", () => {
  const t = reg.get("quick_build_separated");
  assert.equal(t.label, "Quick-build separated lane");
  assert.equal(t.category, "bike");
  assert.equal(t.measure, "linear");
  assert.equal(t.color, "#0072B2");
  assert.ok(t.appliesTo("line") && !t.appliesTo("point"));
  assert.ok(t.costPerKm[0] < t.costPerKm[1]);
});

test("an unknown treatment degrades instead of failing", () => {
  const t = reg.get("transit:bus_lane");
  assert.equal(t.unknown, true);
  assert.equal(t.label, "transit: bus lane");
  assert.equal(t.category, "unknown");
  assert.equal(t.costPerKm, null);          // never invents a figure
  assert.ok(t.appliesTo("line") && t.appliesTo("point"));
  assert.equal(reg.isKnown("transit:bus_lane"), false);
});

test("unknown ids are reported so the UI can say so", () => {
  assert.deepEqual(
    reg.unknownIds(["quick_build_separated", "transit:bus_lane", "streetcar",
                    "bollards"]),
    ["streetcar", "transit:bus_lane"]);
});

test("only bike treatments count toward bike lane totals", () => {
  assert.equal(reg.get("quick_build_separated").isBike, true);
  assert.equal(reg.get("pedestrianized").isBike, false);
  assert.equal(reg.get("street_trees").isBike, false);
  assert.equal(reg.get("transit:bus_lane").isBike, false);
});

test("counted treatments declare a unit and linear ones do not", () => {
  assert.equal(reg.get("street_trees").measure, "counted");
  assert.equal(reg.get("street_trees").unit, "trees");
  assert.equal(reg.get("shared_use_path").measure, "linear");
  assert.equal(reg.get("shared_use_path").unit, "");
});

test("removal is just a registry entry", () => {
  const t = reg.get("parking_removal");
  assert.equal(t.measure, "counted");
  assert.equal(t.unit, "spaces");
});

test("stack_rank orders treatments deterministically", () => {
  const a = reg.sortedForDraw(["concrete_separated", "street_trees", "bollards"]);
  const b = reg.sortedForDraw(["bollards", "concrete_separated", "street_trees"]);
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
  const ranks = a.map((t) => t.stackRank);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
});

test("unknown treatments sort last and stay stable", () => {
  const a = reg.sortedForDraw(["zzz_unknown", "quick_build_separated"]);
  const b = reg.sortedForDraw(["quick_build_separated", "zzz_unknown"]);
  assert.deepEqual(a.map((t) => t.id), b.map((t) => t.id));
});

test("costs are metric and convert back to the documented dollars", () => {
  const [low, high] = reg.get("quick_build_separated").costPerKm;
  assert.equal(Math.round(low * KM_PER_MILE / 1000) * 1000, 150_000);
  assert.equal(Math.round(high * KM_PER_MILE / 1000) * 1000, 500_000);
});

test("uncosted treatments report nothing rather than zero", () => {
  assert.equal(reg.get("street_trees").costPerKm, null);
  assert.equal(reg.get("street_trees").costPerUnit, null);
});

test("every shipped entry answers the three questions", () => {
  for (const t of reg.all()) {
    assert.ok(t.category, `${t.id} has no category`);
    assert.ok(["linear", "counted"].includes(t.measure), `${t.id} bad measure`);
    assert.ok(t.geometry.length, `${t.id} declares no geometry kinds`);
    assert.ok(t.color || t.glyph, `${t.id} has no way to draw`);
    if (t.measure === "counted") assert.ok(t.unit, `${t.id} has no unit`);
  }
});

test("stack ranks are unique so draw order is total", () => {
  const ranks = reg.all().map((t) => t.stackRank);
  assert.equal(ranks.length, new Set(ranks).size);
});

test("a registry can be built from a document for tests", () => {
  const custom = Registry.fromDoc({ treatments: [
    { id: "bus_lane", label: "Bus lane", category: "transit", measure: "linear",
      geometry: ["line"], cost: { per_km: [100, 200] },
      style: { color: "#123456", stack_rank: 5 } },
  ] });
  assert.equal(custom.get("bus_lane").unknown, false);
  assert.equal(custom.get("bus_lane").category, "transit");
  assert.equal(custom.get("quick_build_separated").unknown, true);
});

test("unknownTreatment is usable without a registry", () => {
  const t = unknownTreatment("mystery");
  assert.ok(t.unknown);
  assert.equal(t.category, "unknown");
  assert.equal(t.costPerKm, null);
});

test("setRegistry installs the module-level registry the renderers read", () => {
  setRegistry(DOC);
  assert.equal(registry().isKnown("concrete_separated"), true);
  assert.equal(treatment("concrete_separated").color, "#D55E00");
});

test("the shipped file is valid with a version", () => {
  assert.ok(DOC.registry_version >= 1);
  assert.ok(DOC.treatments.length > 10);
});

test("forGeometry offers only treatments that suit the geometry", () => {
  const reg = Registry.fromDoc({
    registry_version: 1,
    treatments: [
      { id: "lane", geometry: ["line"] },
      { id: "hump", geometry: ["point"] },
      { id: "trees", geometry: ["point", "line"] },
    ],
  });
  assert.deepEqual(reg.forGeometry("line").map((t) => t.id), ["lane", "trees"]);
  assert.deepEqual(reg.forGeometry("point").map((t) => t.id), ["hump", "trees"]);
});

test("forGeometry defaults an unspecified geometry to both", () => {
  // The format stays lenient about vocabulary: a treatment that says nothing
  // about geometry must remain offerable, not vanish from every menu.
  const reg = Registry.fromDoc({ treatments: [{ id: "mystery" }] });
  assert.deepEqual(reg.forGeometry("line").map((t) => t.id), ["mystery"]);
  assert.deepEqual(reg.forGeometry("point").map((t) => t.id), ["mystery"]);
});
