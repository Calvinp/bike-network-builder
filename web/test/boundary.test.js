// Tests for boundary assembly and clipping.
//
// v2: the boundary is a MULTIPOLYGON assembled here at runtime — no precomputed
// ring file, no shapely. Rings are chained from raw ways (what polygonize did),
// holes are honoured, and clipping keeps EVERY in-boundary piece rather than
// only the longest one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  boundaryFromWays,
  clipPolylineLatlon,
  clipSegmentsLatlon,
  longestPiece,
  normalizeBoundary,
  pointInBoundary,
  pointInRing,
  ringsFromWays,
  splitBoundaryEdges,
} from "../js/boundary.js";

// A unit square ring in (lat, lon): lat in [0,1], lon in [0,1].
const SQUARE = [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]];

// The same square with a square hole from 0.4..0.6 in both axes.
const HOLE = [[0.4, 0.4], [0.4, 0.6], [0.6, 0.6], [0.6, 0.4], [0.4, 0.4]];
const SQUARE_WITH_HOLE = [[SQUARE, HOLE]];

// Two disjoint squares — an area with an exclave (or an island).
const FAR_SQUARE = [[10.0, 10.0], [10.0, 11.0], [11.0, 11.0], [11.0, 10.0],
                    [10.0, 10.0]];
const TWO_SQUARES = [[SQUARE], [FAR_SQUARE]];

test("point in ring: interior and exterior", () => {
  assert.ok(pointInRing(0.5, 0.5, SQUARE));
  assert.ok(!pointInRing(2.0, 2.0, SQUARE));
});

// --------------------------------------------------------------------------
// normalizeBoundary: one internal shape, three accepted inputs
// --------------------------------------------------------------------------
test("normalizeBoundary accepts a bare ring, a polygon and a multipolygon", () => {
  const fromRing = normalizeBoundary(SQUARE);
  const fromPoly = normalizeBoundary([SQUARE]);
  const fromMulti = normalizeBoundary([[SQUARE]]);
  assert.deepEqual(fromRing, [[SQUARE]]);
  assert.deepEqual(fromPoly, [[SQUARE]]);
  assert.deepEqual(fromMulti, [[SQUARE]]);
});

test("normalizeBoundary keeps holes and multiple polygons", () => {
  assert.equal(normalizeBoundary(SQUARE_WITH_HOLE).length, 1);
  assert.equal(normalizeBoundary(SQUARE_WITH_HOLE)[0].length, 2);
  assert.equal(normalizeBoundary(TWO_SQUARES).length, 2);
});

test("normalizeBoundary treats an empty boundary as no boundary", () => {
  assert.deepEqual(normalizeBoundary(null), []);
  assert.deepEqual(normalizeBoundary([]), []);
});

// --------------------------------------------------------------------------
// ringsFromWays: what shapely's polygonize used to do
// --------------------------------------------------------------------------
test("ringsFromWays chains ways into a closed ring", () => {
  // The square, cut into three ways given in scrambled order and directions.
  const ways = [
    [[1.0, 1.0], [1.0, 0.0], [0.0, 0.0]],   // north + west edges
    [[0.0, 1.0], [1.0, 1.0]],               // east edge
    [[0.0, 0.0], [0.0, 1.0]],               // south edge
  ];
  const rings = ringsFromWays(ways);
  assert.equal(rings.length, 1);
  const ring = rings[0];
  // Closed, and encloses the square's interior.
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(pointInRing(0.5, 0.5, ring));
  assert.ok(!pointInRing(1.5, 0.5, ring));
});

test("ringsFromWays reverses ways that join end-to-end", () => {
  // Second way runs backwards relative to the first.
  const ways = [
    [[0.0, 0.0], [0.0, 1.0]],
    [[1.0, 1.0], [0.0, 1.0]],               // reversed
    [[1.0, 1.0], [1.0, 0.0], [0.0, 0.0]],
  ];
  const rings = ringsFromWays(ways);
  assert.equal(rings.length, 1);
  assert.ok(pointInRing(0.5, 0.5, rings[0]));
});

test("ringsFromWays returns several rings for disjoint loops", () => {
  const rings = ringsFromWays([SQUARE, FAR_SQUARE]);
  assert.equal(rings.length, 2);
});

test("ringsFromWays drops ways that never close", () => {
  const rings = ringsFromWays([[[0.0, 0.0], [0.0, 1.0]]]);
  assert.deepEqual(rings, []);
});

// --------------------------------------------------------------------------
// Holes and multipolygons
// --------------------------------------------------------------------------
test("a point inside a hole is outside the boundary", () => {
  assert.ok(pointInBoundary(0.2, 0.2, SQUARE_WITH_HOLE));   // in the ring
  assert.ok(!pointInBoundary(0.5, 0.5, SQUARE_WITH_HOLE));  // in the hole
  assert.ok(!pointInBoundary(2.0, 2.0, SQUARE_WITH_HOLE));  // outside entirely
});

test("a point in either polygon of a multipolygon is inside", () => {
  assert.ok(pointInBoundary(0.5, 0.5, TWO_SQUARES));
  assert.ok(pointInBoundary(10.5, 10.5, TWO_SQUARES));
  assert.ok(!pointInBoundary(5.0, 5.0, TWO_SQUARES));
});

test("clipping across a hole yields two pieces, not one", () => {
  // A line straight through the middle, crossing the hole.
  const line = [[0.5, 0.1], [0.5, 0.9]];
  const [pieces, miles] = clipPolylineLatlon(line, SQUARE_WITH_HOLE);
  assert.equal(pieces.length, 2);
  const [unholed] = clipPolylineLatlon(line, [[SQUARE]]);
  const holedMiles = miles;
  const [, wholeMiles] = clipPolylineLatlon(line, [[SQUARE]]);
  assert.ok(unholed.length === 1);
  assert.ok(holedMiles < wholeMiles);   // the hole really removed length
});

test("clipping spans both polygons of a multipolygon", () => {
  const line = [[0.5, 0.5], [10.5, 10.5]];
  const [pieces, miles] = clipPolylineLatlon(line, TWO_SQUARES);
  assert.equal(pieces.length, 2);
  assert.ok(miles > 0);
});

// --------------------------------------------------------------------------
// The bug fix: every in-boundary piece is kept, not just the longest
// --------------------------------------------------------------------------
test("clip keeps BOTH pieces when the line leaves and re-enters", () => {
  const line = [[0.5, -0.2], [0.5, 0.1],   // short inside piece (0 .. 0.1)
                [1.5, 0.1],                 // exits north
                [1.5, 0.9], [0.5, 0.9], [0.5, 0.3]]; // long inside piece
  const [pieces, miles] = clipPolylineLatlon(line, SQUARE);
  assert.equal(pieces.length, 2);
  assert.ok(miles > 0);
  // Both runs are represented: the short one near lon 0..0.1 and the long one.
  const maxLons = pieces.map((p) => Math.max(...p.map(([, lon]) => lon)));
  assert.ok(maxLons.some((v) => v < 0.2));
  assert.ok(maxLons.some((v) => v > 0.8));
});

test("the re-entry case totals MORE miles than the longest piece alone", () => {
  const line = [[0.5, -0.2], [0.5, 0.1],
                [1.5, 0.1],
                [1.5, 0.9], [0.5, 0.9], [0.5, 0.3]];
  const [pieces, miles] = clipPolylineLatlon(line, SQUARE);
  const longest = longestPiece(pieces);
  const [, longestOnly] = clipPolylineLatlon(longest, SQUARE);
  assert.ok(miles > longestOnly + 1e-9);
});

test("longestPiece picks the longest run and tolerates none", () => {
  assert.deepEqual(longestPiece([]), []);
  const a = [[0.5, 0.0], [0.5, 0.1]];
  const b = [[0.5, 0.0], [0.5, 0.5]];
  assert.deepEqual(longestPiece([a, b]), b);
});

// --------------------------------------------------------------------------
// Behaviour preserved from v1
// --------------------------------------------------------------------------
test("clip keeps inside portion", () => {
  const [pieces, miles] = clipPolylineLatlon([[0.5, -0.5], [0.5, 0.5]], SQUARE);
  assert.equal(pieces.length, 1);
  const lons = pieces[0].map(([, lon]) => lon);
  assert.ok(Math.min(...lons) >= -1e-9);
  assert.ok(Math.abs(Math.max(...lons) - 0.5) < 1e-9);
  assert.ok(miles > 0);
});

test("clip fully outside returns no pieces", () => {
  const [pieces, miles] = clipPolylineLatlon([[5.0, 5.0], [6.0, 6.0]], SQUARE);
  assert.deepEqual(pieces, []);
  assert.equal(miles, 0.0);
});

test("clip fully inside unchanged length", () => {
  const [pieces, miles] = clipPolylineLatlon([[0.5, 0.2], [0.5, 0.8]], SQUARE);
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].length >= 2);
  assert.ok(miles > 0);
});

test("clip segments drops fully-outside segments and totals miles", () => {
  const segments = [
    [[0.5, 0.2], [0.5, 0.8]],       // inside
    [[5.0, 5.0], [6.0, 6.0]],       // outside — dropped
  ];
  const [kept, total] = clipSegmentsLatlon(segments, SQUARE);
  assert.equal(kept.length, 1);
  assert.ok(total > 0);
});

test("clip segments splits one segment into several when a hole intervenes", () => {
  const [kept, total] = clipSegmentsLatlon([[[0.5, 0.1], [0.5, 0.9]]],
                                           SQUARE_WITH_HOLE);
  assert.equal(kept.length, 2);
  assert.ok(total > 0);
});

// --------------------------------------------------------------------------
// Real data: the shipped Malden boundary must assemble without shapely.
// This is the regression that matters — the raw file is 5 ways of wildly
// different lengths (26, 42, 2, 3, 4 points) that only form an area once
// chained.
// --------------------------------------------------------------------------
test("the shipped Malden boundary assembles into one closed polygon", async () => {
  const fs = await import("node:fs");
  const url = new URL("../data/malden_boundary.geojson", import.meta.url);
  const fc = JSON.parse(fs.readFileSync(url, "utf8"));
  const ways = fc.features.map(
    (f) => f.geometry.coordinates.map(([lon, lat]) => [lat, lon]));
  const boundary = boundaryFromWays(ways);

  assert.equal(boundary.length, 1);         // one polygon
  assert.equal(boundary[0].length, 1);      // no holes
  const ring = boundary[0][0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(pointInBoundary(42.4251, -71.0662, boundary));   // Malden City Hall
  assert.ok(!pointInBoundary(42.4584, -71.0662, boundary));  // Melrose
  assert.ok(!pointInBoundary(42.3601, -71.0589, boundary));  // Boston
});

test("the border BETWEEN two areas is not an outer edge", () => {
  // Two towns side by side are one map, not two. Drawing the line between
  // them with the same emphasis as the outside edge makes it look like two
  // maps pushed together.
  const A = [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]];
  const B = [[[[0, 1], [0, 2], [1, 2], [1, 1], [0, 1]]]];
  const { outer, shared } = splitBoundaryEdges([A, B]);
  assert.equal(shared.length, 2, "both areas see the join as shared");
  for (const run of shared) {
    for (const [, lon] of run) {
      assert.equal(lon, 1, "the shared run is exactly the x=1 join");
    }
  }
  // Nothing on the outside got demoted.
  const outerLons = outer.flat().map(([, lon]) => lon);
  assert.ok(outerLons.some((v) => v === 0), "the far edges stay outer");
  assert.ok(outerLons.some((v) => v === 2), "including the other town's");
});

test("one area on its own is all outer edge", () => {
  const A = [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]];
  const { outer, shared } = splitBoundaryEdges([A]);
  assert.equal(shared.length, 0);
  assert.equal(outer.length, 1, "an untouched ring is not chopped up");
  assert.equal(outer[0].length, 5);
});

test("a shared border is found even when the two are drawn differently", () => {
  // The real case: Malden's outline comes from OSM and Medford's from the
  // Census, so the same legal line is two different sets of points tens of
  // metres apart. Vertex matching would find nothing.
  const deg = 0.0004;                       // ~45 m at these latitudes
  const A = [[[[42.40, -71.10], [42.44, -71.10], [42.44, -71.06],
               [42.40, -71.06], [42.40, -71.10]]]];
  const B = [[[[42.40, -71.06 + deg], [42.44, -71.06 + deg],
               [42.44, -71.02], [42.40, -71.02], [42.40, -71.06 + deg]]]];
  const { shared } = splitBoundaryEdges([A, B], 0.05);
  assert.ok(shared.length >= 2,
            "the near-parallel border must be recognised as shared");
  for (const run of shared) {
    for (const [, lon] of run) {
      assert.ok(Math.abs(lon - -71.06) < 0.001,
                "only the touching side counts as shared");
    }
  }
});

test("areas that do not touch keep every edge", () => {
  const A = [[[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]];
  const far = [[[[0, 10], [0, 11], [1, 11], [1, 10], [0, 10]]]];
  const { shared } = splitBoundaryEdges([A, far]);
  assert.equal(shared.length, 0, "nothing is shared with a distant town");
});
