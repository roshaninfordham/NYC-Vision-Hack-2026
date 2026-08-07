import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content, GenerateOptions, GenerateResult } from "../src/core/gemini.js";
import {
  type AgentTools,
  buildAgentSystemPrompt,
  runAgentLoop,
} from "../src/agent/loop.js";

// Keep loop tracing out of the project's trace/ dir.
process.env.CURBWATCH_TRACE_DIR = mkdtempSync(join(tmpdir(), "curbwatch-agent-"));

interface RecordedCall {
  contents: Content[];
  opts: GenerateOptions | undefined;
}

function mockGenerate(script: GenerateResult[]) {
  const calls: RecordedCall[] = [];
  let i = 0;
  const generate = async (contents: Content[], opts?: GenerateOptions) => {
    calls.push({ contents: JSON.parse(JSON.stringify(contents)), opts });
    const res = script[Math.min(i, script.length - 1)];
    i++;
    return res;
  };
  return { generate, calls };
}

const text = (t: string): GenerateResult => ({ text: t, functionCalls: [], source: "gemini" });
const call = (name: string, args: Record<string, unknown> = {}): GenerateResult => ({
  text: null,
  functionCalls: [{ name, args }],
  source: "gemini",
});

test("dispatches a tool call, feeds the result back, returns the final text", async () => {
  const { generate, calls } = mockGenerate([
    call("search_cameras", { query: "Canal" }),
    text("Yes — there are cameras on Canal Street."),
  ]);
  const seenArgs: unknown[] = [];
  const tools: AgentTools = {
    search_cameras: async (args) => {
      seenArgs.push(args);
      return { totalMatches: 1, cameras: [{ id: "abc", name: "Canal St @ Broadway", area: "Manhattan" }] };
    },
  };

  const result = await runAgentLoop("is there a camera on Canal Street?", { sessionId: "t1" }, tools, { generate });

  assert.equal(result.reply, "Yes — there are cameras on Canal Street.");
  assert.deepEqual(result.toolsUsed, ["search_cameras"]);
  assert.deepEqual(seenArgs, [{ query: "Canal" }]);

  // Second LLM call must include the model's functionCall turn AND our functionResponse.
  assert.equal(calls.length, 2);
  const history = calls[1].contents;
  assert.equal(history.length, 3);
  assert.equal(history[1].role, "model");
  assert.deepEqual(history[1].parts[0], {
    functionCall: { name: "search_cameras", args: { query: "Canal" } },
  });
  const fr = history[2].parts[0] as { functionResponse: { name: string; response: Record<string, unknown> } };
  assert.equal(fr.functionResponse.name, "search_cameras");
  assert.equal(fr.functionResponse.response.totalMatches, 1);
});

test("plain text on the first round returns immediately with no tools used", async () => {
  const { generate, calls } = mockGenerate([text("I watch NYC DOT cameras for lane blockage.")]);
  const result = await runAgentLoop("what do you do?", { sessionId: "t2" }, {}, { generate });
  assert.equal(result.reply, "I watch NYC DOT cameras for lane blockage.");
  assert.deepEqual(result.toolsUsed, []);
  assert.equal(calls.length, 1);
  // Tools were offered on the intent-parsing round.
  assert.ok(calls[0].opts?.tools && calls[0].opts.tools.length === 4);
});

test("unknown tool name produces an error result and the loop continues", async () => {
  const { generate, calls } = mockGenerate([
    call("nonexistent_tool", { foo: 1 }),
    text("Sorry, I could not do that."),
  ]);
  const result = await runAgentLoop("do the thing", { sessionId: "t3" }, {}, { generate });
  assert.equal(result.reply, "Sorry, I could not do that.");
  assert.deepEqual(result.toolsUsed, ["nonexistent_tool"]);
  const fr = calls[1].contents[2].parts[0] as { functionResponse: { response: Record<string, unknown> } };
  assert.match(String(fr.functionResponse.response.error), /unknown tool/);
});

test("a throwing tool is captured as an error result, not a crash", async () => {
  const { generate, calls } = mockGenerate([
    call("analyze_camera", { cameraId: "x" }),
    text("The camera seems unavailable."),
  ]);
  const tools: AgentTools = {
    analyze_camera: async () => {
      throw new Error("boom");
    },
  };
  const result = await runAgentLoop("what's on camera x?", { sessionId: "t4" }, tools, { generate });
  assert.equal(result.reply, "The camera seems unavailable.");
  const fr = calls[1].contents[2].parts[0] as { functionResponse: { response: Record<string, unknown> } };
  assert.match(String(fr.functionResponse.response.error), /boom/);
});

test("maxRounds exhaustion forces a final tool-less text answer", async () => {
  const { generate, calls } = mockGenerate([
    call("lane_status"),
    call("lane_status"),
    text("Based on what I saw, the lane is clear."),
  ]);
  const tools: AgentTools = { lane_status: async () => ({ watching: false }) };
  const result = await runAgentLoop("keep checking", { sessionId: "t5" }, tools, {
    generate,
    maxRounds: 2,
  });
  assert.equal(result.reply, "Based on what I saw, the lane is clear.");
  assert.deepEqual(result.toolsUsed, ["lane_status", "lane_status"]);
  assert.equal(calls.length, 3);
  // Final forced call offers NO tools and appends the wrap-up instruction.
  assert.equal(calls[2].opts?.tools, undefined);
  const lastContent = calls[2].contents.at(-1)!;
  const lastText = (lastContent.parts[0] as { text: string }).text;
  assert.match(lastText, /Answer the user now/);
});

test("parallel function calls in one round are all dispatched in order", async () => {
  const { generate } = mockGenerate([
    {
      text: null,
      functionCalls: [
        { name: "search_cameras", args: { query: "Broadway" } },
        { name: "lane_status", args: {} },
      ],
      source: "gemini",
    },
    text("done"),
  ]);
  const order: string[] = [];
  const tools: AgentTools = {
    search_cameras: async () => {
      order.push("search_cameras");
      return { totalMatches: 0, cameras: [] };
    },
    lane_status: async () => {
      order.push("lane_status");
      return { watching: false };
    },
  };
  const result = await runAgentLoop("both please", { sessionId: "t6" }, tools, { generate });
  assert.deepEqual(order, ["search_cameras", "lane_status"]);
  assert.deepEqual(result.toolsUsed, ["search_cameras", "lane_status"]);
  assert.equal(result.reply, "done");
});

test("system prompt reflects watching context", () => {
  const idle = buildAgentSystemPrompt({ sessionId: "s" });
  assert.match(idle, /not currently watching/);
  const watching = buildAgentSystemPrompt({
    sessionId: "s",
    cameraId: "cam1",
    cameraName: "Canal St @ Broadway",
    zone: [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  });
  assert.match(watching, /Canal St @ Broadway/);
  assert.match(watching, /lane zone drawn/);
});
