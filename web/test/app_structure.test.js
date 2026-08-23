// Source-structure guards for the two editor files.
//
// app.js drives a live Leaflet map, so it has no unit coverage here — and a
// chevron bug slipped through precisely because the fix lived only in the
// "Show" menu handler, leaving a freshly loaded page (the path every user
// takes) unfixed. These assertions pin the invariants that broke. They are
// deliberately structural: cheap, and they fail for the right reason.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPOT_GLYPHS, SPOT_LABELS } from "../js/render_common.js";

const FILES = {
  "web/app.js": readFileSync(new URL("../app.js", import.meta.url), "utf8"),
  "editor/app.js": readFileSync(
    new URL("../../editor/app.js", import.meta.url), "utf8"),
};

for (const [name, src] of Object.entries(FILES)) {
  test(`${name}: arrows only ever enter the map through syncArrows`, () => {
    // Anything else re-adds a replaced path's chevron on the next edit,
    // import or page load.
    const adds = [...src.matchAll(/arrowsGroup\.addLayer\(|\.addTo\(arrowsGroup\)/g)];
    assert.equal(adds.length, 1, "expected exactly one place that adds arrows");
    const fn = src.slice(0, adds[0].index).lastIndexOf("function ");
    assert.match(src.slice(fn, fn + 40), /function syncArrows/);
  });

  test(`${name}: a freshly loaded editor applies the phase view`, () => {
    // Without this the first paint ignores upgrades until the user happens to
    // touch the Show menu. Anchoring on a two-space indent matters: init()
    // also *registers* a handler that calls applyPhaseView(), and matching
    // that would let the startup call go missing unnoticed (it did).
    const init = src.slice(src.lastIndexOf("async function init()"));
    assert.match(init, /^ {2}applyPhaseView\(\);/m,
                 "init() must call applyPhaseView() itself, not only inside a "
                 + "listener, so the first paint already honours upgrades");
  });

  test(`${name}: the legend is rebuilt when the set of types can change`, () => {
    for (const fn of ["function addFeature", "function removeFeature"]) {
      const start = src.indexOf(fn);
      assert.ok(start > 0, `${fn} not found`);
      const body = src.slice(start, src.indexOf("\n}", start));
      assert.match(body, /renderLegend\(\)/,
                   `${fn} must rebuild the legend — it lists the types in use`);
    }
  });
}

test("editor/app.js mirrors the spot glyph and label tables", () => {
  // web/app.js imports these from render_common.js; the desktop editor is
  // plain script-tag JS and keeps its own copy, so a type added on one side
  // only would draw the catch-all dot in exactly one of the two editors.
  const src = FILES["editor/app.js"].replace(/\/\/.*$/gm, "");
  const table = (name) => {
    const start = src.indexOf(`const ${name} = {`);
    assert.ok(start > 0, `${name} not found in editor/app.js`);
    const body = src.slice(start, src.indexOf("};", start));
    return Object.fromEntries(
      [...body.matchAll(/(\w+)\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  };
  assert.deepEqual(table("SPOT_GLYPHS"), SPOT_GLYPHS);
  assert.deepEqual(table("SPOT_LABELS"), SPOT_LABELS);
});
