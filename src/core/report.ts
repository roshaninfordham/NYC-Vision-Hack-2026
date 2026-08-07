/**
 * curbwatch-core report — builds the LLM prompt for the agent verdict and
 * a templated fallback used when no LLM is reachable.
 */

import type { TimelineEvent } from "./tracker.js";

/** Seconds between sampled frames (app polls 1 frame / ~3 s). */
export const SECONDS_PER_FRAME = 3;

/**
 * Prompt for Gemini: system-style instructions + the timeline JSON.
 * The model should answer with a short plain-English verdict.
 */
export function buildReportPrompt(
  timeline: TimelineEvent[],
  cameraName: string
): string {
  return [
    "You are CurbWatch, an agent that watches NYC DOT traffic cameras for vehicles blocking bike and bus lanes.",
    `Below is the detection timeline for the monitored lane zone at camera "${cameraName}".`,
    `Each event is one sampled frame (frames are ~${SECONDS_PER_FRAME} seconds apart) where a vehicle's footprint was inside the lane zone.`,
    '"dwellFrames" counts CONSECUTIVE frames the same vehicle stayed in the zone; "blocking" is true once it dwelled 3+ frames (roughly 9+ seconds, i.e. stopped, not passing through).',
    "",
    "Write a 2-4 sentence plain-English verdict of lane blockage at this camera, suitable for a 311 report:",
    "- what is blocking (vehicle class), and how long it has been there (convert frames to seconds, ~3 s per frame);",
    "- a severity rating: exactly one of clear / warning / blocked;",
    "- a suggested action (e.g. no action needed, keep monitoring, report to 311).",
    "Be honest: if nothing is blocking, say so plainly. Do not invent details not present in the timeline. Respond with prose only, no markdown.",
    "",
    "Timeline JSON:",
    JSON.stringify(timeline),
  ].join("\n");
}

/** Templated plain-English report used when no LLM is available. */
export function fallbackReport(
  timeline: TimelineEvent[],
  cameraName = "this camera"
): string {
  if (timeline.length === 0) {
    return (
      `No vehicles were observed in the monitored lane at ${cameraName} during this session. ` +
      "Severity: clear. No action needed."
    );
  }

  const blocking = timeline.filter((e) => e.blocking);
  if (blocking.length === 0) {
    const maxDwell = Math.max(...timeline.map((e) => e.dwellFrames), 1);
    return (
      `Vehicles briefly entered the monitored lane at ${cameraName}, ` +
      `with the longest presence around ${maxDwell * SECONDS_PER_FRAME} seconds — ` +
      "likely passing through rather than parked. " +
      "Severity: warning. Keep monitoring; no report needed yet."
    );
  }

  const worst = blocking.reduce((a, b) => (b.dwellFrames > a.dwellFrames ? b : a));
  const otherClasses = [...new Set(blocking.map((e) => e.class))].filter(
    (c) => c !== worst.class
  );
  const others =
    otherClasses.length > 0
      ? ` Other blocking vehicles seen: ${otherClasses.join(", ")}.`
      : "";
  return (
    `A ${worst.class} has been blocking the monitored lane at ${cameraName} ` +
    `for roughly ${worst.dwellFrames * SECONDS_PER_FRAME} seconds ` +
    `(${worst.dwellFrames} consecutive frames), which indicates a stopped vehicle rather than passing traffic.${others} ` +
    "Severity: blocked. Suggested action: report to 311 with a snapshot from this camera."
  );
}
