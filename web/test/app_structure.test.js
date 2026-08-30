// Source-structure guards for app.js.
//
// app.js drives a live Leaflet map, so it has no unit coverage here — and a
// chevron bug slipped through precisely because the fix lived only in the
// "Show" menu handler, leaving a freshly loaded page (the path every user
// takes) unfixed. These assertions pin the invariants that broke. They are
// deliberately structural: cheap, and they fail for the right reason.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Once there were two app.js files to keep in step; the Flask editor is
// retired, so this is now a single-entry loop kept in shape rather than
// flattened — it costs nothing and the assertions read the same.
const FILES = {
  "web/app.js": readFileSync(new URL("../app.js", import.meta.url), "utf8"),
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

  test(`${name}: clipping reads the user's areas, not the deployment`, () => {
    // The clip boundary used to be store.boundary() — whatever the deployment
    // shipped — which meant adding an area in the editor did not widen where
    // you could draw. It has to come from config.areas or the Areas card is a
    // lie.
    const start = src.indexOf("function areasBoundary()");
    assert.ok(start > 0, "areasBoundary() not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /config\.areas/,
                 "the clip boundary must be built from config.areas");
    assert.doesNotMatch(src, /store\.boundary\(\)[\s\S]{0,80}clipPolyline/,
                        "clipping must not fall back to the deployment boundary");
  });

  test(`${name}: snapping does not clip`, () => {
    // Clipping used to live inside snapPoints, so only SNAPPED lines stopped
    // at the border and freehand ones silently escaped it. One rule, one place.
    const start = src.indexOf("async function snapPoints");
    assert.ok(start > 0, "snapPoints not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.doesNotMatch(body, /clipPolylineLatlon|longestPiece/,
                        "snapPoints must only snap; clipToAreas does the clipping");
  });

  test(`${name}: a line drawn entirely outside the areas creates nothing`, () => {
    // It used to create an invisible stub carrying a default name, which the
    // user could neither see nor select to delete.
    const start = src.indexOf('map.on("pm:create"');
    assert.ok(start > 0, "pm:create handler not found");
    const body = src.slice(start, start + 1600);
    assert.match(body, /clipToAreas/, "the draw commit must clip");
    assert.match(body, /if \(!pieces\.length\)[\s\S]{0,400}return;/,
                 "an all-outside line must bail out before addFeature");
    assert.ok(body.indexOf("showClipNotice") < body.indexOf("addFeature"),
              "and it must say why, rather than failing silently");
  });

  test(`${name}: every clip refusal or trim explains itself`, () => {
    // Trimming is correct but invisible; the message is the only thing that
    // tells the user their boundary, not the tool, decided this.
    const notices = [...src.matchAll(/showClipNotice\(/g)];
    assert.ok(notices.length >= 3,
              "expected a notice for a trimmed line, an outside line, and an "
              + "outside spot");
    // The way out has to be attached to the message that raises the problem.
    assert.match(src, /clip-notice-add"\)\.onclick = pickArea/,
                 "the notice must offer adding an area");
  });

  test(`${name}: swapping the area list rebuilds the memoized clip`, () => {
    // areaClip is memoized, so undo and import both have to invalidate it or
    // drawing keeps obeying the areas you just replaced.
    for (const fn of ["function restoreSnapshot", "function afterImport"]) {
      const start = src.indexOf(fn);
      assert.ok(start > 0, `${fn} not found`);
      const body = src.slice(start, src.indexOf("\n}", start));
      assert.match(body, /areaClip = null/,
                   `${fn} must invalidate the memoized clip boundary`);
    }
  });

  test(`${name}: the treatment picker is filtered by the feature's geometry`, () => {
    // Same list on both geometries let you put bike parking on a corridor (a
    // black dashed line) or a separated lane on a spot (a black dot).
    const start = src.indexOf("function fillForm");
    assert.ok(start > 0, "fillForm not found");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /forGeometry\(kind\)/,
                 "the type options must come from registry().forGeometry");
    assert.match(body, /fits\.includes\(t\.type\) \? fits : \[t\.type/,
                 "a file's existing combination must still be shown, not "
                 + "silently retyped");
  });

  test(`${name}: the per-area feature counts are rebuilt with the totals`, () => {
    // The Areas card counts features per area, so it goes stale on every add,
    // delete and reshape unless recomputeTotals rebuilds it too.
    const start = src.indexOf("function recomputeTotals");
    assert.ok(start > 0, "recomputeTotals not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /renderAreas\(\)/,
                 "recomputeTotals must rebuild the Areas card");
  });

  test(`${name}: the legend is rebuilt when the set of treatments can change`, () => {
    for (const fn of ["function addFeature", "function removeFeature"]) {
      const start = src.indexOf(fn);
      assert.ok(start > 0, `${fn} not found`);
      const body = src.slice(start, src.indexOf("\n}", start));
      assert.match(body, /renderLegend\(\)/,
                   `${fn} must rebuild the legend — it lists the types in use`);
    }
  });
}
