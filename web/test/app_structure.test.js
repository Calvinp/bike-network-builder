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

const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("every .sheet is a backdrop with a .sheet-inner card inside", () => {
  // `.sheet` is the full-screen backdrop: fixed, and `display:flex` to centre
  // its child. Putting that class on the CARD instead makes the card a flex
  // container, which lays its heading, hint, lists and buttons out in a ROW.
  // The area picker shipped like that and looked broken at every size.
  const tags = [...HTML.matchAll(/<div\b[^>]*\bclass="([^"]*)"[^>]*>/g)];
  // Exact class token: "sheet-inner" contains "sheet" but is not it.
  const backdrops = tags.filter((m) => m[1].split(/\s+/).includes("sheet"));
  assert.ok(backdrops.length >= 3,
            `expected several sheets, found ${backdrops.length}`);
  for (const m of backdrops) {
    const after = HTML.slice(m.index, m.index + 400);
    assert.match(after, /class="sheet-inner"/,
                 `a .sheet must wrap a .sheet-inner: ${m[0]}`);
    assert.ok(!m[1].split(/\s+/).includes("sheet-inner"),
              "the backdrop and the card are different elements");
  }
});

test("the start screen and reset both exist, and reset warns", () => {
  // An empty map with no explanation is a dead end, and a reset that does not
  // say what it destroys is a trap.
  for (const id of ["start-sheet", "reset-sheet", "start-fresh", "start-import",
                    "reset-go", "reset-export", "reset-cancel"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
});

test("the import input accepts the formats the start screen offers", () => {
  // The start screen says ".yaml or .zip, or a .geojson"; the input has to
  // agree or the file chooser greys out what we just promised.
  const m = HTML.match(/id="import-file"[^>]*accept="([^"]*)"/);
  assert.ok(m, "import-file has no accept list");
  for (const ext of [".yaml", ".zip", ".geojson"]) {
    assert.ok(m[1].includes(ext), `import must accept ${ext}`);
  }
});

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
    assert.match(src, /clip-notice-add"\)\.onclick = openAreaPicker/,
                 "the notice must offer adding an area");
    // And when we can name the town the line ran into, the button says so —
    // "Add Medford" is a decision; "Add an area..." is a chore.
    const start = src.indexOf("function showClipNotice");
    assert.ok(start > 0, "showClipNotice not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /areaAt\(/,
                 "showClipNotice must look up which area the line ran into");
    assert.match(body, /btn\.textContent = `Add \$\{found\.name\}`/,
                 "and offer that area by name");
  });

  test(`${name}: a trim is detected by geometry, not by vertex count`, () => {
    // Clipping a two-point line that starts in the next town returns a
    // two-point line with its first vertex moved onto the border: same
    // count, same piece. Counting vertices reported "not trimmed", so the
    // user lost half of what they drew and was told nothing.
    const start = src.indexOf("function clipToAreas");
    assert.ok(start > 0, "clipToAreas not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /trimmed: Boolean\(outside\)/,
                 "a vertex outside the areas is what makes it a trim");
  });

  test(`${name}: reset deletes the network and returns to the start screen`, () => {
    const start = src.indexOf("async function doReset");
    assert.ok(start > 0, "doReset not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /markStarted\(false\)/,
                 "reset must forget that the user ever started, or the start "
                 + "screen will not come back");
    assert.match(body, /store\.clear\(\)/, "and actually delete the network");
    assert.match(body, /dirty = false/,
                 "a pending autosave would otherwise rewrite what we deleted");
  });

  test(`${name}: "export, then reset" does not reset on a failed export`, () => {
    // Otherwise the one option chosen BY someone protecting their work is the
    // one that loses it.
    const i = src.indexOf('reset-export"');
    assert.ok(i > 0, "reset-export handler not found");
    const body = src.slice(i, i + 500);
    assert.match(body, /catch[\s\S]{0,160}return;/,
                 "a failed export must stop before doReset()");
  });

  test(`${name}: the area picker is not a file dialog`, () => {
    // "+ Add an area" opening a file picker assumed the user has boundary
    // files lying around. Almost nobody does, and adding the next town over is
    // the ordinary case, not an advanced one.
    assert.match(src, /btn-add-area"\)\.onclick = openAreaPicker/,
                 "Add an area must open the picker, not a file input");
    const start = src.indexOf("async function openAreaPicker");
    assert.ok(start > 0, "openAreaPicker not found");
    const body = src.slice(start, src.indexOf("\n}", start));
    assert.match(body, /nearbyAreas\(/,
                 "the picker must open already showing the neighbours");
    // The upload path stays: no registry has \"these six neighbourhoods\".
    assert.match(src, /area-file-btn"\)\.onclick/,
                 "the .geojson escape hatch must remain reachable");
  });

  test(`${name}: a failed lookup never looks like a broken editor`, () => {
    // The Census is optional. Every call site has to degrade to a sentence and
    // the file option, not to a stack trace or a dead dialog.
    for (const fn of ["async function openAreaPicker", "async function addCensusArea"]) {
      const start = src.indexOf(fn);
      assert.ok(start > 0, `${fn} not found`);
      const body = src.slice(start, src.indexOf("\n}", start));
      assert.match(body, /catch/, `${fn} must handle the service being down`);
    }
    assert.match(src, /function offlineNote/,
                 "one shared explanation for an unreachable service");
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
