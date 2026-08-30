// Looking an area up by name.
//
// Every test here stubs fetch: the suite must not touch the network, and the
// point of the injectable fetchImpl is that this module's SHAPE handling — the
// coordinate flip, the name tidying, the duplicate towns — is testable without
// the Census being up.
import test from "node:test";
import assert from "node:assert/strict";
import {
  areaAt, areaBoundary, censusId, nearbyAreas, searchAreas, stateAbbr,
  tidyName, toBoundary,
} from "../js/census.js";

const rows = (features) => ({ ok: true, json: async () => ({ features }) });
const attrs = (name, base, geoid, state) => ({
  attributes: { NAME: name, BASENAME: base, GEOID: geoid, STATE: state },
});

// A stub that answers each layer differently, and records what was asked.
function stub(byLayer) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const m = url.match(/MapServer\/(\d+)\/query/);
      return rows(byLayer[m[1]] || []);
    },
  };
}

test("the coordinate flip happens once, at the edge", () => {
  // GeoJSON is [lon, lat] and every boundary in this codebase is [lat, lon].
  // Getting this backwards puts Massachusetts in the Indian Ocean.
  const poly = { type: "Polygon", coordinates: [[[-71.06, 42.42], [-71.0, 42.4]]] };
  assert.deepEqual(toBoundary(poly), [[[[42.42, -71.06], [42.4, -71.0]]]]);
  const multi = {
    type: "MultiPolygon",
    coordinates: [[[[-71.0, 42.4]]], [[[-70.9, 42.3]]]],
  };
  assert.equal(toBoundary(multi).length, 2, "a multipolygon stays two polygons");
  assert.deepEqual(toBoundary(null), []);
  assert.deepEqual(toBoundary({ type: "Point", coordinates: [0, 0] }), [],
                   "a point is not a boundary");
});

test("Census names are tidied, and the suffix survives as a kind", () => {
  assert.deepEqual(tidyName({ NAME: "Medford city", BASENAME: "Medford" }),
                   { name: "Medford", kind: "city" });
  assert.deepEqual(tidyName({ NAME: "Saugus town", BASENAME: "Saugus" }),
                   { name: "Saugus", kind: "town" });
  assert.deepEqual(tidyName({ NAME: "Yarmouth CDP", BASENAME: "Yarmouth" }),
                   { name: "Yarmouth", kind: "cdp" });
  assert.deepEqual(tidyName({ NAME: "Bristol", BASENAME: "Bristol" }),
                   { name: "Bristol", kind: "" });
});

test("state FIPS become the abbreviations people recognise", () => {
  assert.equal(stateAbbr("25"), "MA");
  assert.equal(stateAbbr(6), "CA", "a bare number still pads to 06");
  assert.equal(stateAbbr("99"), "", "an unknown code is blank, not a crash");
});

test("the same town from two layers is offered once", async () => {
  // Medford is both a county subdivision and an incorporated place. Offering
  // it twice, with two different ids, would let you add it twice.
  const { fetchImpl } = stub({
    1: [attrs("Medford city", "Medford", "2501739835", "25"),
        attrs("Saugus town", "Saugus", "2501759385", "25")],
    4: [attrs("Medford city", "Medford", "2503939835", "25")],
  });
  const near = await nearbyAreas([42.4, -71.09, 42.46, -71.02], { fetchImpl });
  assert.deepEqual(near.map((a) => a.name), ["Medford", "Saugus"]);
  assert.equal(near[0].geoid, "2501739835",
               "the county subdivision wins — in New England it is the town");
});

test("a CCD loses to a real incorporated place", async () => {
  // Outside New England the county subdivision is a statistical invention that
  // nobody builds bike lanes for, so the place is the right answer.
  const { fetchImpl } = stub({
    1: [attrs("Phoenix CCD", "Phoenix", "0401391650", "04")],
    4: [attrs("Phoenix city", "Phoenix", "0455000", "04")],
  });
  const found = await searchAreas("phoenix", { fetchImpl });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "city");
  assert.equal(found[0].geoid, "0455000");
});

test("search puts the state you are already working in first", async () => {
  // There is a Somerville in five states. From Malden, you mean the near one.
  const { fetchImpl } = stub({
    1: [attrs("Somerville city", "Somerville", "3407169930", "34"),
        attrs("Somerville city", "Somerville", "2501762535", "25"),
        attrs("Somerville town", "Somerville", "4804869930", "48")],
    4: [],
  });
  const found = await searchAreas("somerville", { fetchImpl, preferState: "MA" });
  assert.equal(found[0].state, "MA");
});

test("a short query asks the service nothing at all", async () => {
  const { fetchImpl, calls } = stub({ 1: [], 4: [] });
  assert.deepEqual(await searchAreas("m", { fetchImpl }), []);
  assert.equal(calls.length, 0, "one letter is not a search");
});

test("an apostrophe in a name cannot break the query", async () => {
  // Coeur d'Alene, Martha's Vineyard. An unescaped quote would end the WHERE
  // clause early and the service would reject the request.
  const { fetchImpl, calls } = stub({ 1: [], 4: [] });
  await searchAreas("coeur d'alene", { fetchImpl });
  assert.ok(calls.length > 0);
  // URLSearchParams encodes a space as "+", which decodeURIComponent leaves be.
  const where = decodeURIComponent(calls[0]).match(/where=([^&]*)/)[1]
    .replace(/\+/g, " ");
  assert.match(where, /COEUR D''ALENE/, "the quote is doubled, not left raw");
});

test("a boundary lookup asks for simplified geometry in WGS84", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /f=geojson/);
    assert.match(url, /outSR=4326/);
    assert.match(url, /maxAllowableOffset=/,
                 "a full-resolution city outline is 6x the bytes for no gain");
    return { ok: true, json: async () => ({
      features: [{ geometry: { type: "Polygon", coordinates: [[[-71, 42.4]]] } }],
    }) };
  };
  const b = await areaBoundary({ layer: 1, geoid: "2501739835" }, { fetchImpl });
  assert.deepEqual(b, [[[[42.4, -71]]]]);
});

test("a service error becomes an Error, not a silent empty result", async () => {
  const fetchImpl = async () => ({
    ok: true, json: async () => ({ error: { message: "Invalid where clause" } }),
  });
  await assert.rejects(() => areaAt(42.4, -71.0, { fetchImpl }),
                       /Invalid where clause/);
  await assert.rejects(
    () => areaBoundary({ layer: 1, geoid: "x" }, { fetchImpl }),
    /Invalid where clause/);
  const bad = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => areaAt(42.4, -71.0, { fetchImpl: bad }), /503/);
});

test("census ids are stable, so the same town is never added twice", () => {
  assert.equal(censusId({ geoid: "2501739835" }), "census:2501739835");
});
