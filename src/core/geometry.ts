/**
 * curbwatch-core geometry — pure functions, zero dependencies.
 *
 * Conventions:
 * - Points and polygon vertices are `[x, y]` tuples.
 * - Detection boxes are CENTER-based pixel rects: `{x, y, width, height}`
 *   where (x, y) is the box center (Roboflow convention).
 * - Zone polygons are stored NORMALIZED (0–1) so they are resolution
 *   independent; call `denormalize()` with the frame size before testing
 *   pixel-space points against them.
 */

export type Point = [number, number];
export type Polygon = Point[];

/** Center-based box (Roboflow prediction shape). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Corner-based box, used for IoU math. */
export interface Corners {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Convert a center-based box to corner coordinates. */
export function toCorners(box: Box): Corners {
  return {
    x1: box.x - box.width / 2,
    y1: box.y - box.height / 2,
    x2: box.x + box.width / 2,
    y2: box.y + box.height / 2,
  };
}

/**
 * Bottom-center "footprint" of a detection box — where the object touches
 * the ground, which is what we test against the lane zone.
 */
export function footprint(box: Box): Point {
  return [box.x, box.y + box.height / 2];
}

/** Scale a normalized (0–1) polygon to pixel coordinates. */
export function denormalize(polygon: Polygon, width: number, height: number): Polygon {
  return polygon.map(([x, y]) => [x * width, y * height]);
}

const EPS = 1e-9;

function onSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  if (Math.abs(cross) > EPS) return false;
  return (
    px >= Math.min(x1, x2) - EPS &&
    px <= Math.max(x1, x2) + EPS &&
    py >= Math.min(y1, y2) - EPS &&
    py <= Math.max(y1, y2) + EPS
  );
}

/**
 * Ray-casting point-in-polygon test.
 * Points exactly on a polygon edge count as INSIDE (deterministic edges).
 */
export function pointInPolygon(pt: Point, polygon: Polygon): boolean {
  if (polygon.length < 3) return false;
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (onSegment(px, py, xi, yi, xj, yj)) return true;
    const crosses =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Intersection-over-union of two center-based boxes. 0 when disjoint. */
export function iou(a: Box, b: Box): number {
  const ca = toCorners(a);
  const cb = toCorners(b);
  const ix = Math.min(ca.x2, cb.x2) - Math.max(ca.x1, cb.x1);
  const iy = Math.min(ca.y2, cb.y2) - Math.max(ca.y1, cb.y1);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
