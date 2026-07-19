// Tests for snap-to-road routing — mirrors tests/test_routing.py.
import test from "node:test";
import assert from "node:assert/strict";
import { haversineMiles } from "../js/geometry.js";
import { nearestNode, snapRoute } from "../js/routing.js";

// A small graph: nodes 1-2-3 along an L shape; node 9 is isolated.
const COORD = new Map([
  [1, [42.400, -71.000]], [2, [42.400, -71.010]], [3, [42.410, -71.010]],
  [9, [42.500, -71.500]],
]);

function adj() {
  const m = new Map();
  for (const [a, b] of [[1, 2], [2, 3]]) {
    const d = haversineMiles(COORD.get(a), COORD.get(b));
    if (!m.has(a)) m.set(a, []);
    if (!m.has(b)) m.set(b, []);
    m.get(a).push([b, d]);
    m.get(b).push([a, d]);
  }
  return m;
}

const has = (route, pt) => route.some(([a, b]) => a === pt[0] && b === pt[1]);

test("nearest node picks closest", () => {
  assert.equal(nearestNode(COORD, 42.401, -71.0005), 1);
  assert.equal(nearestNode(COORD, 42.409, -71.0102), 3);
});

test("snap route follows edges", () => {
  const route = snapRoute([[42.4002, -71.000], [42.4098, -71.010]], adj(), COORD);
  assert.deepEqual(route[0], COORD.get(1));
  assert.deepEqual(route[route.length - 1], COORD.get(3));
  assert.ok(has(route, COORD.get(2)));
});

test("snap route mid-edge click still snaps", () => {
  const route = snapRoute([[42.4001, -71.005], [42.4098, -71.010]], adj(), COORD);
  assert.deepEqual(route[route.length - 1], COORD.get(3));
  assert.ok(has(route, COORD.get(2)));
});

test("snap route keeps far clicks off-street", () => {
  const route = snapRoute(
    [[42.4002, -71.000], [42.4098, -71.010], [42.405, -71.030]], adj(), COORD);
  assert.ok(has(route, COORD.get(2)));
  assert.deepEqual(route[route.length - 1], [42.405, -71.030]);
  assert.deepEqual(route[route.length - 2], [42.4098, -71.010]);
});

test("snap route backlot click stays free-drawn", () => {
  const backlot = [42.4007, -71.005];  // ~80 m off the street: beyond snap radius
  const route = snapRoute([[42.4002, -71.000], backlot], adj(), COORD);
  assert.deepEqual(route[route.length - 1], [42.4007, -71.005]);
});

test("snap route disconnected falls back to straight", () => {
  const route = snapRoute([[42.410, -71.010], [42.50, -71.50]], adj(), COORD);
  assert.deepEqual(route[0], [42.410, -71.010]);
  assert.deepEqual(route[route.length - 1], [42.50, -71.50]);
  assert.equal(route.length, 2);
});

test("snap route single point passthrough", () => {
  assert.deepEqual(snapRoute([[42.4, -71.0]], adj(), COORD), [[42.4, -71.0]]);
});
