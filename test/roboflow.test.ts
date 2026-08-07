import test from "node:test";
import assert from "node:assert/strict";
import { detect } from "../src/core/roboflow.js";

function mockFetch(captured: { url?: string }) {
  return (async (url: RequestInfo | URL) => {
    captured.url = String(url);
    return new Response(
      JSON.stringify({ time: 0.1, image: { width: 10, height: 10 }, predictions: [] }),
      { status: 200 }
    );
  }) as typeof fetch;
}

test("confidence defaults to 40", async () => {
  delete process.env.ROBOFLOW_CONFIDENCE;
  const captured: { url?: string } = {};
  await detect(Buffer.from("x"), { apiKey: "k", fetchImpl: mockFetch(captured) });
  assert.match(captured.url!, /confidence=40/);
});

test("env ROBOFLOW_CONFIDENCE overrides the default", async () => {
  process.env.ROBOFLOW_CONFIDENCE = "55";
  try {
    const captured: { url?: string } = {};
    await detect(Buffer.from("x"), { apiKey: "k", fetchImpl: mockFetch(captured) });
    assert.match(captured.url!, /confidence=55/);
  } finally {
    delete process.env.ROBOFLOW_CONFIDENCE;
  }
});

test("explicit opts.confidence wins over env and default", async () => {
  process.env.ROBOFLOW_CONFIDENCE = "55";
  try {
    const captured: { url?: string } = {};
    await detect(Buffer.from("x"), {
      apiKey: "k",
      confidence: 25,
      fetchImpl: mockFetch(captured),
    });
    assert.match(captured.url!, /confidence=25/);
  } finally {
    delete process.env.ROBOFLOW_CONFIDENCE;
  }
});
