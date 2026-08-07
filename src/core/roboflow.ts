/**
 * curbwatch-core Roboflow client — hosted serverless inference, no SDK.
 *
 * Verified request shape:
 *   base64 -i frame.jpg | curl -s -d @- \
 *     -H "Content-Type: application/x-www-form-urlencoded" \
 *     "https://serverless.roboflow.com/coco/24?api_key=KEY&confidence=30"
 */

export interface RoboflowPrediction {
  /** Box CENTER x in pixels. */
  x: number;
  /** Box CENTER y in pixels. */
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
  class_id?: number;
}

export interface RoboflowResult {
  time: number;
  image: { width: number; height: number };
  predictions: RoboflowPrediction[];
}

/** Classes CurbWatch cares about; everything else is dropped. */
export const DETECT_CLASSES = new Set([
  "car",
  "truck",
  "bus",
  "motorcycle",
  "person",
]);

export interface DetectOptions {
  /** Roboflow model id, e.g. "coco/24". Default: env ROBOFLOW_MODEL or "coco/24". */
  model?: string;
  /** API key. Default: env ROBOFLOW_API_KEY. */
  apiKey?: string;
  /** Confidence threshold percent. Default 30. */
  confidence?: number;
  /** Base endpoint override (testing). */
  endpoint?: string;
  /** fetch override (testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Run object detection on raw image bytes.
 * Returns the Roboflow response with predictions filtered to DETECT_CLASSES.
 */
export async function detect(
  imageBytes: Buffer,
  opts: DetectOptions = {}
): Promise<RoboflowResult> {
  const model = opts.model ?? process.env.ROBOFLOW_MODEL ?? "coco/24";
  const apiKey = opts.apiKey ?? process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("ROBOFLOW_API_KEY is not set (env or opts.apiKey)");
  }
  const confidence = opts.confidence ?? 30;
  const endpoint = opts.endpoint ?? "https://serverless.roboflow.com";
  const doFetch = opts.fetchImpl ?? fetch;

  const url = `${endpoint}/${model}?api_key=${encodeURIComponent(apiKey)}&confidence=${confidence}`;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: imageBytes.toString("base64"),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Roboflow ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = (await res.json()) as RoboflowResult;
  return {
    time: raw.time,
    image: raw.image,
    predictions: (raw.predictions ?? []).filter((p) =>
      DETECT_CLASSES.has(p.class)
    ),
  };
}
