/**
 * curbwatch-core tracker — matches detections across frames by IoU and
 * flags objects that dwell inside the lane zone.
 *
 * Frames arrive ~3s apart, so "stationary" ⇒ the same physical object
 * keeps overlapping its previous box (IoU > threshold). A vehicle whose
 * footprint stays inside the zone for >= `blockingFrames` CONSECUTIVE
 * frames is flagged as BLOCKING. Vehicles passing through never
 * accumulate enough consecutive in-zone frames.
 *
 * Only vehicle classes are tracked for blocking; person detections are
 * counted separately as context (never "blocking").
 */

import {
  type Box,
  type Polygon,
  footprint,
  iou,
  pointInPolygon,
} from "./geometry.js";

export const VEHICLE_CLASSES = new Set(["car", "truck", "bus", "motorcycle"]);

/** Blocking-decision confidence floor: env TRACK_MIN_CONFIDENCE or 0.45. */
export function defaultMinTrackConfidence(): number {
  const envMin = Number(process.env.TRACK_MIN_CONFIDENCE);
  return Number.isFinite(envMin) && envMin >= 0 && envMin <= 1 ? envMin : 0.45;
}

export interface Detection {
  class: string;
  confidence: number;
  /** Center-based pixel box. */
  box: Box;
}

export interface TrackedObject {
  /** Stable id for the physical object across frames. */
  id: number;
  class: string;
  confidence: number;
  box: Box;
  /** Consecutive frames the footprint has been inside the zone (0 = outside). */
  dwellFrames: number;
  /** Timestamp (ms) when this object was first seen. */
  firstSeen: number;
  inZone: boolean;
  blocking: boolean;
}

export interface TimelineEvent {
  ts: number;
  class: string;
  dwellFrames: number;
  blocking: boolean;
}

export interface UpdateResult {
  blocking: TrackedObject[];
  inZone: TrackedObject[];
  all: TrackedObject[];
}

export interface LaneTrackerOptions {
  /** Lane polygon in PIXEL coordinates (denormalize first). */
  zone?: Polygon;
  /** IoU above this ⇒ same object across frames. Default 0.3. */
  iouThreshold?: number;
  /** Consecutive in-zone frames needed to flag blocking. Default 3. */
  blockingFrames?: number;
  /** Max timeline events retained. Default 500. */
  maxEvents?: number;
  /**
   * Vehicles below this confidence are NOT tracked for blocking decisions
   * (callers may still display them). Default: env TRACK_MIN_CONFIDENCE
   * or 0.45.
   */
  minTrackConfidence?: number;
}

export class LaneTracker {
  private zone: Polygon;
  private readonly iouThreshold: number;
  private readonly blockingFrames: number;
  private readonly maxEvents: number;
  private readonly minTrackConfidence: number;

  private tracks: TrackedObject[] = [];
  private events: TimelineEvent[] = [];
  private nextId = 1;

  /** Person detections in the most recent frame (context, not tracked). */
  personCount = 0;
  /** Frames processed so far. */
  frameCount = 0;

  constructor(opts: LaneTrackerOptions = {}) {
    this.zone = opts.zone ?? [];
    this.iouThreshold = opts.iouThreshold ?? 0.3;
    this.blockingFrames = opts.blockingFrames ?? 3;
    this.maxEvents = opts.maxEvents ?? 500;
    this.minTrackConfidence = opts.minTrackConfidence ?? defaultMinTrackConfidence();
  }

  /** Replace the lane polygon (pixel coords). Safe to call every frame. */
  setZone(zone: Polygon): void {
    this.zone = zone;
  }

  private inZone(box: Box): boolean {
    return this.zone.length >= 3 && pointInPolygon(footprint(box), this.zone);
  }

  /**
   * Feed one frame of detections. Returns current tracked vehicles.
   * Tracks not matched this frame are dropped (dwell resets on loss).
   */
  update(detections: Detection[], ts: number): UpdateResult {
    this.frameCount++;
    this.personCount = detections.filter((d) => d.class === "person").length;
    // Low-confidence vehicles are noise for blocking decisions — skip them
    // here; callers can still display them straight from the detection list.
    const vehicles = detections.filter(
      (d) =>
        VEHICLE_CLASSES.has(d.class) && d.confidence >= this.minTrackConfidence
    );

    // All candidate (track, detection) pairs above the IoU threshold,
    // matched greedily best-first so each side is used at most once.
    const pairs: { track: TrackedObject; det: number; score: number }[] = [];
    for (const track of this.tracks) {
      for (let di = 0; di < vehicles.length; di++) {
        const score = iou(track.box, vehicles[di].box);
        if (score > this.iouThreshold) pairs.push({ track, det: di, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    const usedTracks = new Set<number>();
    const usedDets = new Set<number>();
    const next: TrackedObject[] = [];

    for (const { track, det, score: _ } of pairs) {
      if (usedTracks.has(track.id) || usedDets.has(det)) continue;
      usedTracks.add(track.id);
      usedDets.add(det);
      const d = vehicles[det];
      const nowInZone = this.inZone(d.box);
      // dwell counts CONSECUTIVE in-zone frames; leaving the zone resets it.
      const dwellFrames = nowInZone ? (track.inZone ? track.dwellFrames + 1 : 1) : 0;
      next.push({
        id: track.id,
        class: d.class,
        confidence: d.confidence,
        box: d.box,
        firstSeen: track.firstSeen,
        inZone: nowInZone,
        dwellFrames,
        blocking: dwellFrames >= this.blockingFrames,
      });
    }

    // Unmatched detections start new tracks (dwell restarts from scratch).
    for (let di = 0; di < vehicles.length; di++) {
      if (usedDets.has(di)) continue;
      const d = vehicles[di];
      const nowInZone = this.inZone(d.box);
      const dwellFrames = nowInZone ? 1 : 0;
      next.push({
        id: this.nextId++,
        class: d.class,
        confidence: d.confidence,
        box: d.box,
        firstSeen: ts,
        inZone: nowInZone,
        dwellFrames,
        blocking: dwellFrames >= this.blockingFrames,
      });
    }

    // Unmatched previous tracks are dropped — losing an object resets dwell.
    this.tracks = next;

    for (const t of next) {
      if (!t.inZone) continue;
      this.events.push({
        ts,
        class: t.class,
        dwellFrames: t.dwellFrames,
        blocking: t.blocking,
      });
    }
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    return {
      blocking: next.filter((t) => t.blocking),
      inZone: next.filter((t) => t.inZone),
      all: next,
    };
  }

  /** Compact in-zone event history for the report prompt. */
  timeline(): TimelineEvent[] {
    return [...this.events];
  }
}
