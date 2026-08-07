import test from "node:test";
import assert from "node:assert/strict";
import { searchCameras } from "../src/agent/search.js";

const cameras = [
  { id: "1", name: "Broadway @ 42 St", area: "Manhattan" },
  { id: "2", name: "7 Ave @ 42 St", area: "Manhattan" },
  { id: "3", name: "Canal St @ Broadway", area: "Manhattan" },
  { id: "4", name: "Broadway @ 14 St", area: "Manhattan" },
  { id: "5", name: "8 Ave @ 59 St", area: "Manhattan" },
  { id: "6", name: "Atlantic Ave @ Flatbush Ave", area: "Brooklyn" },
  { id: "7", name: "Queens Blvd @ 71 Ave", area: "Queens" },
];

test("multi-term query ranks by number of matching terms", () => {
  const r = searchCameras(cameras, "Broadway 42");
  // Both terms match camera 1; single-term matches follow.
  assert.equal(r.cameras[0].id, "1");
  const ids = r.cameras.map((c) => c.id);
  assert.ok(ids.includes("2")); // "42" matched
  assert.ok(ids.includes("3")); // "Broadway" matched
  assert.ok(ids.includes("4"));
  assert.ok(!ids.includes("6")); // no term matches Brooklyn camera
});

test("landmark cross-street query works where the literal landmark fails", () => {
  // 'Times Square' literally matches nothing...
  const literal = searchCameras(cameras, "Times Square");
  assert.equal(literal.totalMatches, 0);
  // ...but the cross-street translation ('7 Ave @ 42 St') hits.
  const translated = searchCameras(cameras, "7 Ave 42 St");
  assert.ok(translated.totalMatches > 0);
  assert.equal(translated.cameras[0].id, "2"); // all three terms match
});

test("street-name synonyms normalize on both sides", () => {
  // Spelled-out query vs abbreviated camera names.
  const r = searchCameras(cameras, "42nd Street Broadway");
  assert.equal(r.cameras[0].id, "1"); // 42 + st + broadway all match
  const ave = searchCameras(cameras, "Seventh Avenue");
  assert.equal(ave.cameras[0].id, "2"); // seventh->7, avenue->ave
});

test("numeric terms match exactly, not by prefix", () => {
  const r = searchCameras(cameras, "7");
  const names = r.cameras.map((c) => c.name);
  assert.ok(names.includes("7 Ave @ 42 St"));
  assert.ok(!names.includes("7 Ave @ 42 St".replace("7", "71"))); // sanity
  assert.ok(!r.cameras.some((c) => c.id === "7")); // "71 Ave" must not match "7"
});

test("borough filter combines with query and is case-insensitive", () => {
  const r = searchCameras(cameras, "Ave", "brooklyn");
  assert.equal(r.totalMatches, 1);
  assert.equal(r.cameras[0].id, "6");
});

test("empty query returns the pool up to the limit", () => {
  const r = searchCameras(cameras, undefined, undefined, 3);
  assert.equal(r.totalMatches, 7);
  assert.equal(r.cameras.length, 3);
});
