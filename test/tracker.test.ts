import test from "node:test";
import assert from "node:assert/strict";
import { LaneTracker, type Detection } from "../src/core/tracker.js";
import type { Polygon } from "../src/core/geometry.js";

// Zone: pixel-space square covering x 0..100, y 0..100.
const zone: Polygon = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

function car(x: number, y: number, size = 40): Detection {
  return { class: "car", confidence: 0.9, box: { x, y, width: size, height: size } };
}

test("IoU matching: same object keeps its track id across frames", () => {
  const t = new LaneTracker({ zone });
  const r1 = t.update([car(50, 50)], 1000);
  const id1 = r1.all[0].id;
  // Slightly shifted box, IoU well over 0.3 => same track.
  const r2 = t.update([car(54, 51)], 4000);
  assert.equal(r2.all.length, 1);
  assert.equal(r2.all[0].id, id1);
  assert.equal(r2.all[0].firstSeen, 1000);
});

test("IoU matching: distant box becomes a new track", () => {
  const t = new LaneTracker({ zone });
  const r1 = t.update([car(50, 50)], 1000);
  const id1 = r1.all[0].id;
  const r2 = t.update([car(300, 300)], 4000);
  assert.equal(r2.all.length, 1);
  assert.notEqual(r2.all[0].id, id1);
  assert.equal(r2.all[0].dwellFrames, 0); // footprint (300, 320) outside zone
});

test("blocking flagged after 3 consecutive in-zone frames, not before", () => {
  const t = new LaneTracker({ zone });
  // footprint of car(50,50,40) = (50, 70) — inside zone.
  const r1 = t.update([car(50, 50)], 0);
  assert.equal(r1.inZone.length, 1);
  assert.equal(r1.inZone[0].dwellFrames, 1);
  assert.equal(r1.blocking.length, 0);

  const r2 = t.update([car(51, 50)], 3000);
  assert.equal(r2.inZone[0].dwellFrames, 2);
  assert.equal(r2.blocking.length, 0);

  const r3 = t.update([car(50, 51)], 6000);
  assert.equal(r3.inZone[0].dwellFrames, 3);
  assert.equal(r3.blocking.length, 1);
  assert.equal(r3.blocking[0].blocking, true);
});

test("leaving the zone resets dwell", () => {
  const t = new LaneTracker({ zone });
  t.update([car(50, 50)], 0);
  t.update([car(50, 50)], 3000); // dwell 2
  // Same object drifts so its footprint leaves the zone (y footprint 120 > 100)
  // while boxes still overlap enough to match (IoU > 0.3).
  const out = t.update([car(50, 78, 60)], 6000); // footprint (50, 108) outside
  assert.equal(out.inZone.length, 0);
  assert.equal(out.all[0].dwellFrames, 0);
  // Re-enters: dwell restarts at 1, no blocking.
  const back = t.update([car(50, 60, 60)], 9000); // footprint (50, 90) inside
  assert.equal(back.inZone[0].dwellFrames, 1);
  assert.equal(back.blocking.length, 0);
});

test("losing an object resets dwell (new track starts fresh)", () => {
  const t = new LaneTracker({ zone });
  const r1 = t.update([car(50, 50)], 0);
  const id1 = r1.all[0].id;
  t.update([car(50, 50)], 3000); // dwell 2
  // Object disappears for a frame (occluded / detector miss).
  const gone = t.update([], 6000);
  assert.equal(gone.all.length, 0);
  // Same position reappears — but the track was dropped, so dwell restarts.
  const r4 = t.update([car(50, 50)], 9000);
  assert.notEqual(r4.all[0].id, id1);
  assert.equal(r4.all[0].dwellFrames, 1);
  assert.equal(r4.blocking.length, 0);
});

test("persons are counted as context, never tracked or blocking", () => {
  const t = new LaneTracker({ zone });
  const person: Detection = {
    class: "person",
    confidence: 0.8,
    box: { x: 50, y: 50, width: 20, height: 40 },
  };
  for (const ts of [0, 3000, 6000, 9000]) {
    const r = t.update([person], ts);
    assert.equal(r.all.length, 0);
    assert.equal(r.blocking.length, 0);
  }
  assert.equal(t.personCount, 1);
});

test("non-vehicle, non-person classes are ignored", () => {
  const t = new LaneTracker({ zone });
  const r = t.update(
    [{ class: "traffic light", confidence: 0.9, box: { x: 50, y: 50, width: 10, height: 30 } }],
    0
  );
  assert.equal(r.all.length, 0);
  assert.equal(t.personCount, 0);
});

test("vehicles below min tracking confidence are ignored for blocking", () => {
  const t = new LaneTracker({ zone }); // default floor 0.45
  const lowConf: Detection = {
    class: "car",
    confidence: 0.39,
    box: { x: 50, y: 50, width: 40, height: 40 },
  };
  for (const ts of [0, 3000, 6000, 9000]) {
    const r = t.update([lowConf], ts);
    assert.equal(r.all.length, 0);
    assert.equal(r.blocking.length, 0);
  }
  // At/above the floor it is tracked normally.
  const ok = t.update([car(50, 50)], 12000);
  assert.equal(ok.all.length, 1);
});

test("minTrackConfidence option overrides the default floor", () => {
  const strict = new LaneTracker({ zone, minTrackConfidence: 0.95 });
  const r = strict.update([car(50, 50)], 0); // car() has confidence 0.9
  assert.equal(r.all.length, 0);
  const lax = new LaneTracker({ zone, minTrackConfidence: 0 });
  const r2 = lax.update(
    [{ class: "car", confidence: 0.1, box: { x: 50, y: 50, width: 40, height: 40 } }],
    0
  );
  assert.equal(r2.all.length, 1);
});

test("timeline records in-zone events with dwell and blocking", () => {
  const t = new LaneTracker({ zone });
  t.update([car(50, 50)], 0);
  t.update([car(50, 50)], 3000);
  t.update([car(50, 50)], 6000);
  const tl = t.timeline();
  assert.equal(tl.length, 3);
  assert.deepEqual(
    tl.map((e) => ({ dwellFrames: e.dwellFrames, blocking: e.blocking })),
    [
      { dwellFrames: 1, blocking: false },
      { dwellFrames: 2, blocking: false },
      { dwellFrames: 3, blocking: true },
    ]
  );
  assert.equal(tl[0].class, "car");
  assert.equal(tl[0].ts, 0);
});

test("two objects tracked independently", () => {
  const t = new LaneTracker({ zone });
  const r1 = t.update([car(30, 50), car(300, 300)], 0);
  assert.equal(r1.all.length, 2);
  const r2 = t.update([car(31, 50), car(302, 301)], 3000);
  assert.equal(r2.all.length, 2);
  const ids1 = r1.all.map((o) => o.id).sort();
  const ids2 = r2.all.map((o) => o.id).sort();
  assert.deepEqual(ids2, ids1);
  // Only the in-zone one accumulates dwell.
  assert.equal(r2.inZone.length, 1);
  assert.equal(r2.inZone[0].dwellFrames, 2);
});
