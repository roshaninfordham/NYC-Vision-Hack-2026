import test from "node:test";
import assert from "node:assert/strict";
import {
  denormalize,
  footprint,
  iou,
  pointInPolygon,
  toCorners,
  type Polygon,
} from "../src/core/geometry.js";

const square: Polygon = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

test("pointInPolygon: point inside", () => {
  assert.equal(pointInPolygon([5, 5], square), true);
});

test("pointInPolygon: point outside", () => {
  assert.equal(pointInPolygon([15, 5], square), false);
  assert.equal(pointInPolygon([-1, 5], square), false);
  assert.equal(pointInPolygon([5, 11], square), false);
});

test("pointInPolygon: point on edge counts as inside", () => {
  assert.equal(pointInPolygon([10, 5], square), true); // vertical edge
  assert.equal(pointInPolygon([5, 0], square), true); // horizontal edge
  assert.equal(pointInPolygon([0, 0], square), true); // vertex
});

test("pointInPolygon: non-convex polygon", () => {
  // L-shape: notch cut out of top-right
  const ell: Polygon = [
    [0, 0],
    [10, 0],
    [10, 5],
    [5, 5],
    [5, 10],
    [0, 10],
  ];
  assert.equal(pointInPolygon([2, 8], ell), true); // in the lower arm
  assert.equal(pointInPolygon([8, 8], ell), false); // in the notch
  assert.equal(pointInPolygon([8, 2], ell), true); // in the upper arm
});

test("pointInPolygon: degenerate polygon (<3 points) is never inside", () => {
  assert.equal(pointInPolygon([5, 5], [[0, 0], [10, 10]]), false);
});

test("footprint: bottom-center of a center-based box", () => {
  assert.deepEqual(footprint({ x: 50, y: 40, width: 20, height: 30 }), [50, 55]);
});

test("toCorners: converts center box to corners", () => {
  assert.deepEqual(toCorners({ x: 50, y: 40, width: 20, height: 30 }), {
    x1: 40,
    y1: 25,
    x2: 60,
    y2: 55,
  });
});

test("denormalize: scales 0-1 polygon to pixels", () => {
  const zone: Polygon = [
    [0, 0],
    [0.5, 0.25],
    [1, 1],
  ];
  assert.deepEqual(denormalize(zone, 640, 480), [
    [0, 0],
    [320, 120],
    [640, 480],
  ]);
});

test("iou: identical boxes = 1, disjoint boxes = 0", () => {
  const a = { x: 10, y: 10, width: 10, height: 10 };
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, { x: 100, y: 100, width: 10, height: 10 }), 0);
});

test("iou: partial overlap", () => {
  const a = { x: 5, y: 5, width: 10, height: 10 }; // 0..10 x 0..10
  const b = { x: 10, y: 5, width: 10, height: 10 }; // 5..15 x 0..10
  // intersection 5*10=50, union 100+100-50=150
  assert.ok(Math.abs(iou(a, b) - 50 / 150) < 1e-9);
});
