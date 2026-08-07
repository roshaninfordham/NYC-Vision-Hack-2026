/**
 * CurbWatch agent loop — parses user intent with Gemini function calling
 * and reaches the goal via a small tool belt. Every step (LLM call, tool
 * call, result) is traced to trace/agent-trace.jsonl.
 *
 * The Gemini `generate` function and the tool implementations are
 * injectable so the loop is unit-testable with zero network.
 */
import {
  type Content,
  type FunctionDeclaration,
  type GenerateOptions,
  type GenerateResult,
  type Part,
  generateContent,
  geminiModel,
} from "../core/gemini.js";
import { trace } from "../trace.js";

export interface AgentContext {
  sessionId: string;
  /** Camera the user is currently watching in the UI, if any. */
  cameraId?: string;
  /** Whether a lane zone is currently drawn in the UI. */
  zone?: [number, number][];
  /** Human-readable name for the watched camera, if known. */
  cameraName?: string;
}

/** Tool implementation: receives the model's args, returns a JSON-able result. */
export type AgentToolImpl = (args: Record<string, unknown>) => Promise<unknown>;
export type AgentTools = Record<string, AgentToolImpl>;

export type GenerateFn = (
  contents: Content[],
  opts?: GenerateOptions
) => Promise<GenerateResult>;

export interface AgentResult {
  reply: string;
  toolsUsed: string[];
}

export const agentFunctionDeclarations: FunctionDeclaration[] = [
  {
    name: "search_cameras",
    description:
      "Search the NYC DOT traffic camera list by name and/or borough. The query is split into terms and cameras matching ANY term are returned, ranked by how many terms match (up to 10, with id, name and area). Use cross-street terms, e.g. 'Broadway 42 St'.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Space-separated cross-street terms matched against camera names, e.g. 'Canal St' or 'Broadway 42'.",
        },
        borough: {
          type: "string",
          description:
            "Optional borough filter: Manhattan, Brooklyn, Queens, Bronx, or Staten Island.",
        },
      },
    },
  },
  {
    name: "analyze_camera",
    description:
      "Run ONE live object detection on the camera's current frame (full frame, no lane zone). Returns vehicle/person counts by class with a confidence summary. Costs one inference credit — use only when the user wants to know what is on the street right now.",
    parameters: {
      type: "object",
      properties: {
        cameraId: {
          type: "string",
          description: "Camera id from search_cameras or the current UI context.",
        },
      },
      required: ["cameraId"],
    },
  },
  {
    name: "lane_status",
    description:
      "Current monitored-lane status for this session (only useful if the user is watching a lane): status clear/warning/blocked, blocking vehicles with dwell times, person count. Uses no new inference.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "generate_report",
    description:
      "Generate the plain-English lane-blockage report (311-style verdict) from this session's detection timeline.",
    parameters: { type: "object", properties: {} },
  },
];

export function buildAgentSystemPrompt(ctx: AgentContext): string {
  const watching = ctx.cameraId
    ? `The user is currently watching camera ${ctx.cameraName ?? ctx.cameraId} (id: ${ctx.cameraId})${
        ctx.zone && ctx.zone.length >= 3 ? " with a lane zone drawn" : ""
      }.`
    : "The user is not currently watching a specific camera.";
  return [
    "You are CurbWatch, an NYC street-operations agent with live access to 900+ DOT traffic cameras.",
    "You help people find cameras, see what is happening on a street right now, and assess whether vehicles are blocking bike or bus lanes.",
    "Parse the user's intent and reach their goal using the provided tools; prefer tool results over guessing.",
    "Live detections (analyze_camera) cost credits — only call it when the user actually wants current street activity.",
    "NYC DOT cameras are named by cross-streets (e.g. 'Broadway @ 42 St'), not landmarks. Translate landmarks into their cross-streets before searching (Times Square → Broadway @ 42 St / 7 Ave @ 42 St; Union Square → Broadway @ 14 St; Columbus Circle → 8 Ave @ 59 St; use your NYC knowledge for others), and try 2-3 alternative queries before concluding nothing exists.",
    "Always respond in the same language as the user's message. If the report requester's language is known from the session's chat history, write the report in that language with an English translation appended for 311 filing.",
    watching,
    "Answer concisely and factually in plain text. If you cannot help with the available tools, say so honestly.",
  ].join(" ");
}

/** Gemini functionResponse.response must be an object — wrap other shapes. */
function asResponseObject(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

function summarize(result: unknown, max = 300): string {
  try {
    return JSON.stringify(result)?.slice(0, max) ?? String(result);
  } catch {
    return String(result).slice(0, max);
  }
}

/**
 * Run the intent-parsing agent loop: up to `maxRounds` tool-call rounds,
 * then a forced plain-text answer.
 */
export async function runAgentLoop(
  message: string,
  ctx: AgentContext,
  tools: AgentTools,
  opts: { generate?: GenerateFn; maxRounds?: number } = {}
): Promise<AgentResult> {
  const generate = opts.generate ?? generateContent;
  const maxRounds = opts.maxRounds ?? 4;
  const model = geminiModel();
  const systemInstruction = buildAgentSystemPrompt(ctx);
  const { sessionId } = ctx;

  const contents: Content[] = [{ role: "user", parts: [{ text: message }] }];
  const toolsUsed: string[] = [];

  const callModel = async (withTools: boolean): Promise<GenerateResult> => {
    await trace({
      sessionId,
      type: "llm_call",
      model,
      promptChars: JSON.stringify(contents).length + systemInstruction.length,
    });
    const res = await generate(contents, {
      systemInstruction,
      ...(withTools ? { tools: agentFunctionDeclarations } : {}),
    });
    await trace({
      sessionId,
      type: "llm_response",
      textChars: res.text?.length ?? 0,
      toolCalls: res.functionCalls.map((f) => f.name),
    });
    return res;
  };

  for (let round = 0; round < maxRounds; round++) {
    const res = await callModel(true);
    if (res.functionCalls.length === 0) {
      return { reply: res.text ?? "", toolsUsed };
    }

    // Echo the model's turn into history. Prefer the RAW parts from the
    // API — they carry required fields like thoughtSignature that must be
    // returned with functionCall parts. Fall back to reconstruction (mocks).
    let modelParts: Part[];
    if (res.rawParts && res.rawParts.length > 0) {
      modelParts = res.rawParts as Part[];
    } else {
      modelParts = [];
      if (res.text) modelParts.push({ text: res.text });
      for (const fc of res.functionCalls) modelParts.push({ functionCall: fc });
    }
    contents.push({ role: "model", parts: modelParts });

    // Execute each requested tool; feed results back as functionResponse parts.
    const responseParts: Part[] = [];
    for (const fc of res.functionCalls) {
      toolsUsed.push(fc.name);
      await trace({ sessionId, type: "tool_call", tool: fc.name, args: fc.args });
      let result: unknown;
      try {
        const impl = tools[fc.name];
        result = impl ? await impl(fc.args) : { error: `unknown tool: ${fc.name}` };
      } catch (err) {
        result = { error: String(err) };
      }
      await trace({
        sessionId,
        type: "tool_result",
        tool: fc.name,
        resultSummary: summarize(result),
      });
      responseParts.push({
        functionResponse: { name: fc.name, response: asResponseObject(result) },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Tool budget exhausted — force a plain-text answer (no tools offered).
  contents.push({
    role: "user",
    parts: [
      {
        text: "Tool budget exhausted. Answer the user now in plain text using the information gathered so far.",
      },
    ],
  });
  const final = await callModel(false);
  return { reply: final.text ?? "", toolsUsed };
}
