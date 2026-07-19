// Tests for geometry helpers — mirrors tests/test_geometry.py.
import test from "node:test";
import assert from "node:assert/strict";
import {
  haversineMiles, polylineMiles, bboxOf, shortestPath, lonlatToMercator,
} from "../js/geometry.js";

const approx = (got, want, abs = 1e-6) =>
  assert.ok(Math.abs(got - want) <= abs, `${got} !~ ${want} (±${abs})`);

test("mercator origin", () => {
  const [x, y] = lonlatToMercator(0.0, 0.0);
  approx(x, 0.0);
  approx(y, 0.0);
});

test("mercator equator x at 180", () => {
  const [x] = lonlatToMercator(0.0, 180.0);
  approx(x, 20037508.34, 20037508.34 * 1e-4);
});

test("mercator y increases north", () => {
  const [, yLo] = lonlatToMercator(42.42, -71.06);
  const [, yHi] = lonlatToMercator(42.45, -71.06);
  assert.ok(yHi > yLo);
});

test("haversine known distance", () => {
  approx(haversineMiles([42.0, -71.0], [43.0, -71.0]), 69.0, 0.5);
});

test("haversine zero", () => {
  approx(haversineMiles([42.42, -71.06], [42.42, -71.06]), 0.0);
});

test("polyline miles sums segments", () => {
  const pts = [[42.0, -71.0], [42.0, -71.0], [43.0, -71.0]];
  approx(polylineMiles(pts), 69.0, 0.5);
});

test("polyline miles single point is zero", () => {
  assert.equal(polylineMiles([[42.0, -71.0]]), 0.0);
});

test("bbox of with padding", () => {
  const [s, w, n, e] = bboxOf([[42.42, -71.07], [42.45, -71.04]], 0.01);
  approx(s, 42.41); approx(w, -71.08); approx(n, 42.46); approx(e, -71.03);
});

test("shortest path simple line", () => {
  const coord = new Map([[1, [42.00, -71.0]], [2, [42.01, -71.0]], [3, [42.02, -71.0]]]);
  const d = (a, b) => haversineMiles(coord.get(a), coord.get(b));
  const adj = new Map([
    [1, [[2, d(1, 2)]]],
    [2, [[1, d(2, 1)], [3, d(2, 3)]]],
    [3, [[2, d(3, 2)]]],
  ]);
  const [pts, miles] = shortestPath(adj, coord, 1, 3);
  assert.deepEqual(pts, [coord.get(1), coord.get(2), coord.get(3)]);
  approx(miles, haversineMiles(coord.get(1), coord.get(3)), 0.05);
});

test("shortest path unreachable returns null", () => {
  const coord = new Map([[1, [42.0, -71.0]], [9, [42.5, -71.0]]]);
  const adj = new Map([[1, []], [9, []]]);
  const [pts, miles] = shortestPath(adj, coord, 1, 9);
  assert.equal(pts, null);
  assert.equal(miles, null);
});
