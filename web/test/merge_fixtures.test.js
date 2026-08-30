// The awkward files, run through the BROWSER's importer.
//
// tests/test_merge_fixtures.py checks the same files against the Python
// implementation. Both are here because the browser is what a user actually
// points at a hand-edited file, and because the two parsers agreeing about
// what is legal is the whole premise of a shared format.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../js/store.js";
import { parseNetwork, validateNetwork } from "../js/network_format.js";

const fixture = (name) => readFileSync(
  new URL(`../../tests/fixtures/merge/${name}`, import.meta.url), "utf8");

const PLACE_JSON = JSON.stringify({
  id: "test", name: "Malden", context: "Massachusetts", kind: "municipality",
  authorities: [], assets: { treatments: "data/treatments.json" },
});
const TREATMENTS = readFileSync(
  new URL("../data/treatments.json", import.meta.url), "utf8");

function importer() {
  const mem = new Map();
  return new Store({
    storage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
    },
    fetchText: async (url) => {
      if (url.endsWith("place.json")) return PLACE_JSON;
      if (url.endsWith("treatments.json")) return TREATMENTS;
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
}
const bytes = (text) => new TextEncoder().encode(text);

const IMPORTABLE = ["absurd-but-valid.yaml", "adversarial.yaml"];
const REFUSED = {
  "adversarial-rejected.yaml": /loop/i,
  "bad-references.yaml": /upgrade itself/i,
  "id-collision.yaml": /duplicate id/i,
  "invalid-bad-units.yaml": /units/i,
  "invalid-future-version.yaml": /newer than this tool/i,
  "invalid-geometry-types.yaml": /\[lat, lon\]/i,
  "invalid-wrong-format.yaml": /unrecognized format/i,
  "invalid-not-yaml.yaml": /not parseable as yaml/i,
  "invalid-truncated.yaml": /not parseable as yaml/i,
  "invalid-empty.yaml": /look like a bike network/i,
};

for (const name of IMPORTABLE) {
  test(`${name} imports through the browser`, async () => {
    const j = await importer().importBytes(bytes(fixture(name)));
    assert.equal(j.ok, true, `errors: ${JSON.stringify(j.errors)}`);
    assert.ok(j.parsed.features.length, "and carries features");
  });
}

for (const [name, phrase] of Object.entries(REFUSED)) {
  test(`${name} is refused, with a message that says why`, async () => {
    const j = await importer().importBytes(bytes(fixture(name)));
    assert.equal(j.ok, false, `${name} should NOT import`);
    assert.match(j.errors.join(" "), phrase);
  });
}

test("an empty file is refused rather than treated as an empty network", async () => {
  // The gap these fixtures were written to find: an empty document parsed into
  // a default network that validated clean, so importing junk reported SUCCESS
  // — and on an empty map that replaced everything with nothing.
  for (const text of ["", "\n\n", "# just a comment\n", "other_tool: true\n"]) {
    const j = await importer().importBytes(bytes(text));
    assert.equal(j.ok, false, `${JSON.stringify(text)} should be refused`);
    assert.match(j.errors.join(" "), /look like a bike network/i);
  }
});

test("a counted treatment on a line stays legal in the FORMAT", () => {
  // The editor will not offer a speed hump on a line, and a file from another
  // tool is still not wrong for containing one. Strict about structure,
  // lenient about vocabulary.
  const net = parseNetwork(fixture("absurd-but-valid.yaml"));
  const humps = net.features.find((f) => f.id === "f-humps");
  assert.equal(humps.treatments[0].type, "speed_hump");
  assert.ok(humps.geometry[0].length >= 2, "on a line, not a point");
  assert.deepEqual(validateNetwork(net), []);
});

test("an unknown treatment type is a notice, not a refusal", async () => {
  // Lenient vocabulary: a file naming a treatment this version has never heard
  // of still imports, and the unknown one is reported rather than dropped.
  const j = await importer().importBytes(bytes(fixture("adversarial.yaml")));
  assert.equal(j.ok, true);
  assert.ok(j.unknownTypes.includes("antigravity_corridor"),
            `expected the unknown type to be reported, got ${j.unknownTypes}`);
});

test("absurd geometry does not produce absurd arithmetic", () => {
  // A corridor from pole to pole and one whose start equals its end are both
  // legal. Lengths must stay finite and non-negative or the totals go strange.
  const net = parseNetwork(fixture("adversarial.yaml"));
  for (const f of net.features) {
    const km = f.length_km || 0;
    assert.ok(Number.isFinite(km) && km >= 0,
              `${f.name} produced a length of ${km}`);
  }
  const zero = net.features.find((f) => f.id === "f-zero-length");
  assert.equal(zero.length_km, 0, "start == end is zero, not NaN");
});
