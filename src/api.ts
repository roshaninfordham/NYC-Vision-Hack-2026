import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LaneTracker,
  type Polygon,
  type RoboflowResult,
  buildReportPrompt,
  denormalize,
  detect,
  fallbackReport,
} from "./core/index.js";

export const api = new Hono();

api.get("/status", (c) =>
  c.json({ ok: true, version: "0.1.0", features: ["cameras", "analyze", "report"] })
);

// ---------------------------------------------------------------------------
// Credit guard — module-level counter of live Roboflow calls.
// ---------------------------------------------------------------------------

let inferenceCalls = 0;

function maxInferenceCalls(): number {
  const n = Number(process.env.MAX_INFERENCE_CALLS ?? 500);
  return Number.isFinite(n) && n >= 0 ? n : 500;
}

function budget() {
  const max = maxInferenceCalls();
  return { used: inferenceCalls, max, remaining: Math.max(0, max - inferenceCalls) };
}

api.get("/budget", (c) => c.json(budget()));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface Session {
  tracker: LaneTracker;
  lastFrame: Buffer | null;
  cameraId: string;
  cameraName: string;
  frames: number;
}

const sessions = new Map<string, Session>();

// ---------------------------------------------------------------------------
// GET /api/cameras — NYC DOT camera list, cached 5 minutes.
// ---------------------------------------------------------------------------

const NYCTMC = "https://webcams.nyctmc.org/api/cameras";
const CAMERA_CACHE_MS = 5 * 60_000;

interface Camera {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  area: string;
  isOnline: string;
  imageUrl: string;
}

let cameraCache: { cameras: Camera[]; cachedAt: string } | null = null;
let cameraCacheTime = 0;

async function getCameras(): Promise<{ cameras: Camera[]; cachedAt: string }> {
  if (cameraCache && Date.now() - cameraCacheTime < CAMERA_CACHE_MS) {
    return cameraCache;
  }
  const res = await fetch(NYCTMC);
  if (!res.ok) throw new Error(`camera list fetch failed: ${res.status}`);
  const all = (await res.json()) as Camera[];
  const online = all
    .filter((cam) => cam.isOnline === "true")
    .map(({ id, name, latitude, longitude, area, isOnline, imageUrl }) => ({
      id,
      name,
      latitude,
      longitude,
      area,
      isOnline,
      imageUrl,
    }));
  cameraCache = { cameras: online, cachedAt: new Date().toISOString() };
  cameraCacheTime = Date.now();
  return cameraCache;
}

api.get("/cameras", async (c) => {
  try {
    return c.json(await getCameras());
  } catch (err) {
    return c.json({ error: `upstream camera list unavailable: ${String(err)}` }, 502);
  }
});

async function cameraName(cameraId: string): Promise<string> {
  try {
    const { cameras } = await getCameras();
    return cameras.find((cam) => cam.id === cameraId)?.name ?? cameraId;
  } catch {
    return cameraId;
  }
}

// ---------------------------------------------------------------------------
// Replay bundle (committed demo data — zero Roboflow credits).
// ---------------------------------------------------------------------------

interface ReplayBundle {
  meta: { cameraId: string; cameraName: string; capturedAt: string; frameCount: number };
  detections: RoboflowResult[];
  frames: Buffer[];
}

let replayBundle: ReplayBundle | null = null;

async function loadReplay(): Promise<ReplayBundle> {
  if (replayBundle) return replayBundle;
  const dir = resolve(process.cwd(), "replay");
  const meta = JSON.parse(await readFile(resolve(dir, "meta.json"), "utf8"));
  const detections = JSON.parse(
    await readFile(resolve(dir, "detections.json"), "utf8")
  ) as RoboflowResult[];
  const frames = await Promise.all(
    detections.map((_, i) =>
      readFile(resolve(dir, "frames", `${String(i).padStart(2, "0")}.jpg`))
    )
  );
  replayBundle = { meta, detections, frames };
  return replayBundle;
}

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------

interface AnalyzeBody {
  sessionId?: string;
  cameraId?: string;
  zone?: [number, number][];
  replay?: boolean;
}

function validZone(zone: unknown): zone is [number, number][] {
  return (
    Array.isArray(zone) &&
    zone.length >= 3 &&
    zone.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        typeof p[0] === "number" &&
        typeof p[1] === "number"
    )
  );
}

api.post("/analyze", async (c) => {
  let body: AnalyzeBody;
  try {
    body = await c.req.json<AnalyzeBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const { sessionId, cameraId, zone, replay } = body;
  if (!sessionId || !cameraId) {
    return c.json({ error: "sessionId and cameraId are required" }, 400);
  }
  if (!validZone(zone)) {
    return c.json(
      { error: "zone must be an array of >= 3 normalized [x, y] pairs" },
      400
    );
  }

  let session = sessions.get(sessionId);
  if (!session || session.cameraId !== cameraId) {
    session = {
      tracker: new LaneTracker(),
      lastFrame: null,
      cameraId,
      cameraName: replay ? cameraId : await cameraName(cameraId),
      frames: 0,
    };
    sessions.set(sessionId, session);
  }

  let frameBytes: Buffer;
  let detection: RoboflowResult;

  if (replay) {
    // Replay mode: committed frames + cached detections. No Roboflow call,
    // does NOT count against the inference budget.
    let bundle: ReplayBundle;
    try {
      bundle = await loadReplay();
    } catch (err) {
      return c.json({ error: `replay data unavailable: ${String(err)}` }, 503);
    }
    const idx = session.frames % bundle.frames.length;
    frameBytes = bundle.frames[idx];
    detection = bundle.detections[idx];
    session.cameraName = bundle.meta.cameraName;
  } else {
    if (inferenceCalls >= maxInferenceCalls()) {
      return c.json({ error: "inference budget exhausted", budget: budget() }, 429);
    }
    let frameRes: Response;
    try {
      frameRes = await fetch(`${NYCTMC}/${cameraId}/image`);
    } catch (err) {
      return c.json({ error: `camera frame fetch failed: ${String(err)}` }, 502);
    }
    if (!frameRes.ok) {
      return c.json({ error: `camera frame fetch failed: ${frameRes.status}` }, 502);
    }
    frameBytes = Buffer.from(await frameRes.arrayBuffer());
    inferenceCalls++;
    try {
      // Detection runs on the SAME bytes returned to the client.
      detection = await detect(frameBytes);
    } catch (err) {
      return c.json({ error: `detection failed: ${String(err)}`, budget: budget() }, 502);
    }
  }

  const ts = Date.now();
  const zonePx = denormalize(
    zone as Polygon,
    detection.image.width,
    detection.image.height
  );
  session.tracker.setZone(zonePx);

  const detections = detection.predictions.map((p) => ({
    class: p.class,
    confidence: p.confidence,
    box: { x: p.x, y: p.y, width: p.width, height: p.height },
  }));
  const result = session.tracker.update(detections, ts);
  session.frames++;
  session.lastFrame = frameBytes;

  const personCount = session.tracker.personCount;
  const status =
    result.blocking.length > 0
      ? "blocked"
      : result.inZone.length > 0
        ? "warning"
        : "clear";

  const responseDetections = [
    ...result.all.map((t) => ({
      class: t.class,
      confidence: t.confidence,
      box: t.box,
      inZone: t.inZone,
      blocking: t.blocking,
      dwellFrames: t.dwellFrames,
    })),
    ...detections
      .filter((d) => d.class === "person")
      .map((d) => ({
        class: d.class,
        confidence: d.confidence,
        box: d.box,
        inZone: false,
        blocking: false,
        dwellFrames: 0,
      })),
  ];

  return c.json({
    frame: `data:image/jpeg;base64,${frameBytes.toString("base64")}`,
    ts,
    imageSize: detection.image,
    detections: responseDetections,
    status,
    personCount,
    budget: { used: budget().used, max: budget().max },
  });
});

// ---------------------------------------------------------------------------
// POST /api/report — agent verdict (Gemini → Vertex → templated fallback).
// ---------------------------------------------------------------------------

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

function extractGeminiText(json: GeminiResponse): string {
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("empty Gemini response");
  return text;
}

async function callGemini(prompt: string, key: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  return extractGeminiText((await res.json()) as GeminiResponse);
}

async function callVertex(prompt: string, project: string): Promise<string> {
  // ADC via the Cloud Run / GCE metadata server — no key in the container.
  const tokenRes = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3_000) }
  );
  if (!tokenRes.ok) throw new Error(`metadata token ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(
    `https://aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`Vertex ${res.status}`);
  return extractGeminiText((await res.json()) as GeminiResponse);
}

api.post("/report", async (c) => {
  let body: { sessionId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
  const session = sessions.get(body.sessionId);
  if (!session) return c.json({ error: "unknown session" }, 404);

  const timeline = session.tracker.timeline();
  const prompt = buildReportPrompt(timeline, session.cameraName);

  let report: string | null = null;
  let source: "gemini" | "vertex" | "fallback" = "fallback";
  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (geminiKey) {
      report = await callGemini(prompt, geminiKey);
      source = "gemini";
    } else if (project) {
      report = await callVertex(prompt, project);
      source = "vertex";
    }
  } catch {
    report = null;
    source = "fallback";
  }
  if (!report) report = fallbackReport(timeline, session.cameraName);

  return c.json({ report, source, generatedAt: new Date().toISOString() });
});
