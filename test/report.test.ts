import test from "node:test";
import assert from "node:assert/strict";
import { buildReportPrompt, fallbackReport } from "../src/core/report.js";
import type { TimelineEvent } from "../src/core/tracker.js";

test("buildReportPrompt embeds camera name and timeline JSON", () => {
  const timeline: TimelineEvent[] = [
    { ts: 0, class: "truck", dwellFrames: 4, blocking: true },
  ];
  const prompt = buildReportPrompt(timeline, "Central Park West @ 86 St");
  assert.match(prompt, /Central Park West @ 86 St/);
  assert.match(prompt, /"class":"truck"/);
  assert.match(prompt, /clear \/ warning \/ blocked/);
});

test("fallbackReport: empty timeline is honest and clear", () => {
  const report = fallbackReport([], "Test Cam");
  assert.match(report, /No vehicles/i);
  assert.match(report, /clear/);
});

test("fallbackReport: in-zone but never blocking = warning", () => {
  const report = fallbackReport([
    { ts: 0, class: "car", dwellFrames: 1, blocking: false },
    { ts: 3000, class: "car", dwellFrames: 2, blocking: false },
  ]);
  assert.match(report, /warning/);
  assert.doesNotMatch(report, /Severity: blocked/);
});

test("fallbackReport: blocking event yields blocked verdict with duration", () => {
  const report = fallbackReport(
    [
      { ts: 0, class: "car", dwellFrames: 2, blocking: false },
      { ts: 3000, class: "truck", dwellFrames: 5, blocking: true },
    ],
    "Test Cam"
  );
  assert.match(report, /truck/);
  assert.match(report, /15 seconds/); // 5 frames * 3 s
  assert.match(report, /Severity: blocked/);
  assert.match(report, /311/);
});
