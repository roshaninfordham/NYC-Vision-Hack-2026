import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTrace, trace } from "../src/trace.js";

// Redirect tracing away from the project's trace/ dir. The trace module
// resolves its path lazily per call, so setting env here is sufficient.
process.env.CURBWATCH_TRACE_DIR = mkdtempSync(join(tmpdir(), "curbwatch-trace-"));

test("trace/readTrace roundtrip preserves entries with ISO timestamps", async () => {
  await trace({ sessionId: "s1", type: "tool_call", tool: "search_cameras", args: { query: "Canal" } });
  await trace({ sessionId: "s2", type: "verdict", status: "clear", report: "all quiet" });
  await trace({ sessionId: "s1", type: "llm_call", model: "test-model", promptChars: 42 });

  const all = await readTrace();
  assert.equal(all.length, 3);
  for (const e of all) {
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal(all[0].type, "tool_call");
  assert.equal(all[0].tool, "search_cameras");
  assert.deepEqual(all[0].args, { query: "Canal" });
  assert.equal(all[2].promptChars, 42);
});

test("readTrace filters by sessionId", async () => {
  const s1 = await readTrace("s1");
  assert.equal(s1.length, 2);
  assert.ok(s1.every((e) => e.sessionId === "s1"));
  const s2 = await readTrace("s2");
  assert.equal(s2.length, 1);
  assert.equal(s2[0].status, "clear");
});

test("readTrace honors limit, returning the LAST N entries", async () => {
  for (let i = 0; i < 5; i++) {
    await trace({ sessionId: "s3", type: "tool_call", tool: `t${i}` });
  }
  const last2 = await readTrace("s3", 2);
  assert.equal(last2.length, 2);
  assert.deepEqual(
    last2.map((e) => e.tool),
    ["t3", "t4"]
  );
});

test("readTrace on a missing file returns [] and trace never throws", async () => {
  const prev = process.env.CURBWATCH_TRACE_DIR;
  process.env.CURBWATCH_TRACE_DIR = mkdtempSync(join(tmpdir(), "curbwatch-empty-"));
  try {
    assert.deepEqual(await readTrace(), []);
    // trace into an unwritable path must not throw
    process.env.CURBWATCH_TRACE_DIR = "/dev/null/not-a-dir";
    await assert.doesNotReject(trace({ sessionId: "x", type: "tool_call" }));
  } finally {
    process.env.CURBWATCH_TRACE_DIR = prev;
  }
});

test("human_action entries roundtrip with editedText", async () => {
  await trace({
    sessionId: "s4",
    type: "human_action",
    action: "edited",
    editedText: "A van blocked the bike lane for 2 minutes.",
  });
  const entries = await readTrace("s4");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "edited");
  assert.equal(entries[0].editedText, "A van blocked the bike lane for 2 minutes.");
});
