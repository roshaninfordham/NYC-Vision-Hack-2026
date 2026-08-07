/**
 * curbwatch-core Gemini client — one entry point for all LLM calls,
 * plain fetch, no SDK. Supports function calling.
 *
 * Auth order:
 *   1. env GEMINI_API_KEY            → generativelanguage.googleapis.com REST
 *   2. env GOOGLE_ACCESS_TOKEN (dev) or metadata-server token (Cloud Run)
 *      + env GOOGLE_CLOUD_PROJECT    → Vertex AI generateContent
 *      (location "global" first; falls back to us-central1 on 404)
 *   3. neither → throw, so callers can degrade to fallbackReport().
 */

export interface TextPart {
  text: string;
}
export interface FunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> };
}
export interface FunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}
/** Inline media (e.g. a camera frame) for multimodal grounding. */
export interface InlineDataPart {
  inlineData: { mimeType: string; data: string };
}
export type Part =
  | TextPart
  | FunctionCallPart
  | FunctionResponsePart
  | InlineDataPart;

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface GenerateOptions {
  tools?: FunctionDeclaration[];
  systemInstruction?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface GenerateResult {
  text: string | null;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  source: "gemini" | "vertex";
  /**
   * Raw candidate parts as returned by the API. When continuing a
   * conversation after function calls, echo THESE back as the model turn:
   * they carry required fields (e.g. thoughtSignature) beyond the parsed
   * text/functionCalls.
   */
  rawParts?: unknown[];
}

/**
 * Cheapest Gemini model by default. "gemini-flash-lite-latest" aliases the
 * newest flash-lite tier; pinned ids like "gemini-2.5-flash-lite" 404 for
 * fresh accounts on the generativelanguage API.
 */
export function geminiModel(): string {
  return process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
}

/** True when some credential path exists (key, dev token, or Cloud project identity). */
export function hasGeminiCredentials(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT);
}

interface RawResponse {
  candidates?: {
    content?: { parts?: (Partial<TextPart> & Partial<FunctionCallPart>)[] };
  }[];
}

function parseResponse(raw: RawResponse, source: "gemini" | "vertex"): GenerateResult {
  const parts = raw.candidates?.[0]?.content?.parts ?? [];
  const texts: string[] = [];
  const functionCalls: GenerateResult["functionCalls"] = [];
  for (const p of parts) {
    if (typeof p.text === "string") texts.push(p.text);
    if (p.functionCall?.name) {
      functionCalls.push({
        name: p.functionCall.name,
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  }
  const text = texts.join("").trim();
  return {
    text: text.length > 0 ? text : null,
    functionCalls,
    source,
    rawParts: parts,
  };
}

async function metadataToken(doFetch: typeof fetch): Promise<string> {
  const res = await doFetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3_000) }
  );
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

/**
 * One Gemini generateContent call. Returns parsed text and/or function
 * calls. Throws when no credentials are configured or the API errors.
 */
export async function generateContent(
  contents: Content[],
  opts: GenerateOptions = {}
): Promise<GenerateResult> {
  const model = opts.model ?? geminiModel();
  const doFetch = opts.fetchImpl ?? fetch;

  const body: Record<string, unknown> = { contents };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = [{ functionDeclarations: opts.tools }];
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const res = await doFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      init
    );
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return parseResponse((await res.json()) as RawResponse, "gemini");
  }

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (project) {
    const token = process.env.GOOGLE_ACCESS_TOKEN ?? (await metadataToken(doFetch));
    const authInit = {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    };
    const urlFor = (location: string) =>
      `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
    let res = await doFetch(urlFor("global"), authInit);
    if (res.status === 404) {
      // some projects/models are only served regionally
      res = await doFetch(urlFor("us-central1"), authInit);
    }
    if (!res.ok) {
      throw new Error(`Vertex ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
    return parseResponse((await res.json()) as RawResponse, "vertex");
  }

  throw new Error(
    "no Gemini credentials: set GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT (+ GOOGLE_ACCESS_TOKEN locally / metadata identity on Cloud Run)"
  );
}
