/**
 * curbwatch-core — pure, dependency-light lane-blockage detection logic.
 * Publishable later as the `curbwatch-core` npm package.
 */

export {
  type Point,
  type Polygon,
  type Box,
  type Corners,
  toCorners,
  footprint,
  denormalize,
  pointInPolygon,
  iou,
} from "./geometry.js";

export {
  VEHICLE_CLASSES,
  type Detection,
  type TrackedObject,
  type TimelineEvent,
  type UpdateResult,
  type LaneTrackerOptions,
  LaneTracker,
} from "./tracker.js";

export {
  DETECT_CLASSES,
  type RoboflowPrediction,
  type RoboflowResult,
  type DetectOptions,
  detect,
} from "./roboflow.js";

export {
  SECONDS_PER_FRAME,
  buildReportPrompt,
  fallbackReport,
} from "./report.js";
