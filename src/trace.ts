/**
 * JSONL traceability for the CurbWatch agent.
 *
 * Every agent-relevant event (LLM calls, tool calls, verdicts, human
 * decisions) is appended as one JSON line to trace/agent-trace.jsonl so a
 * session can be audited end-to-end. Tracing must never break the app:
 * all errors are swallowed.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TraceType =
  | "llm_call" // {model, promptChars}
  | "llm_response" // {textChars, toolCalls}
  | "tool_call" // {tool, args}
  | "tool_result" // {tool, resultSummary}
  | "verdict" // {status, report}
  | "human_action"; // {action: approved|edited|discarded, editedText?}

export interface TraceEntry {
  sessionId: string;
  type: TraceType | (string & {});
  [key: string]: unknown;
}

export interface StoredTraceEntry extends TraceEntry {
  ts: string;
}

/** Resolved lazily so tests can redirect via CURBWATCH_TRACE_DIR. */
function traceFile(): string {
  const dir = process.env.CURBWATCH_TRACE_DIR ?? resolve(process.cwd(), "trace");
  return resolve(dir, "agent-trace.jsonl");
}

/** Append one trace line. Never throws. */
export async function trace(entry: TraceEntry): Promise<void> {
  try {
    const file = traceFile();
    await mkdir(dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    await appendFile(file, line + "\n", "utf8");
  } catch {
    // tracing must never take the app down
  }
}

/**
 * Read the last `limit` trace entries, optionally filtered by sessionId.
 * Returns [] when there is no trace file yet. Never throws.
 */
export async function readTrace(
  sessionId?: string,
  limit = 100
): Promise<StoredTraceEntry[]> {
  try {
    const raw = await readFile(traceFile(), "utf8");
    const entries: StoredTraceEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as StoredTraceEntry);
      } catch {
        // skip corrupt lines
      }
    }
    const filtered = sessionId
      ? entries.filter((e) => e.sessionId === sessionId)
      : entries;
    return filtered.slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}
