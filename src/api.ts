import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  LaneTracker,
  VEHICLE_CLASSES,
  type Polygon,
  type RoboflowResult,
  type UpdateResult,
  buildReportPrompt,
  defaultMinTrackConfidence,
  denormalize,
  detect,
  fallbackReport,
  footprint,
  pointInPolygon,
} from "./core/index.js";
import {
  type Part,
  generateContent,
  hasGeminiCredentials,
} from "./core/gemini.js";
import {
  type AgentTools,
  runAgentLoop,
} from "./agent/loop.js";
import { searchCameras } from "./agent/search.js";
import { readTrace, trace } from "./trace.js";

export const api = new Hono();

api.get("/status", (c) =>
  c.json({
    ok: true,
    version: "0.1.0",
    features: ["cameras", "analyze", "report", "agent", "trace"],
  })
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
  lastStatus: "clear" | "warning" | "blocked" | null;
  lastResult: UpdateResult | null;
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

  await trace({
    sessionId,
    type: "tool_call",
    tool: "analyze",
    args: { cameraId, replay: Boolean(replay), zonePoints: zone.length },
  });

  let session = sessions.get(sessionId);
  if (!session || session.cameraId !== cameraId) {
    session = {
      tracker: new LaneTracker(),
      lastFrame: null,
      cameraId,
      cameraName: replay ? cameraId : await cameraName(cameraId),
      frames: 0,
      lastStatus: null,
      lastResult: null,
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
  session.lastStatus = status;
  session.lastResult = result;

  await trace({
    sessionId,
    type: "tool_result",
    tool: "analyze",
    resultSummary: `status=${status} vehicles=${result.all.length} inZone=${result.inZone.length} blocking=${result.blocking.length} persons=${personCount} replay=${Boolean(replay)}`,
  });

  // Low-confidence vehicles are excluded from tracking/blocking decisions
  // but still shown to the user with their (visibly low) confidence.
  const minConf = defaultMinTrackConfidence();
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
      .filter((d) => VEHICLE_CLASSES.has(d.class) && d.confidence < minConf)
      .map((d) => ({
        class: d.class,
        confidence: d.confidence,
        box: d.box,
        inZone: pointInPolygon(footprint(d.box), zonePx),
        blocking: false,
        dwellFrames: 0,
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
// Reports — Gemini (key or Vertex identity) with templated fallback.
// ---------------------------------------------------------------------------

const REPORT_SYSTEM_INSTRUCTION =
  "You are CurbWatch, an NYC street-operations agent writing lane-blockage verdicts from DOT traffic cameras. " +
  "Always respond in the same language as the user's message. If the report requester's language is known from the session's chat history, write the report in that language with an English translation appended for 311 filing. Never append a translation when the report is already in English.";

async function sessionReport(
  session: Session,
  opts: { language?: string } = {}
): Promise<{
  report: string;
  source: "gemini" | "vertex" | "fallback";
  grounded: boolean;
}> {
  const timeline = session.tracker.timeline();
  const grounded = session.lastFrame !== null;
  const prompt = buildReportPrompt(timeline, session.cameraName, {
    grounded,
    language: opts.language,
  });
  try {
    if (hasGeminiCredentials()) {
      // Multimodal grounding: attach the session's last frame so the model
      // cross-checks the detector against what is actually visible.
      const parts: Part[] = [{ text: prompt }];
      if (session.lastFrame) {
        parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: session.lastFrame.toString("base64"),
          },
        });
      }
      const res = await generateContent([{ role: "user", parts }], {
        systemInstruction: REPORT_SYSTEM_INSTRUCTION,
      });
      if (res.text) return { report: res.text, source: res.source, grounded };
    }
  } catch {
    // fall through to templated report
  }
  return {
    report: fallbackReport(timeline, session.cameraName),
    source: "fallback",
    grounded: false,
  };
}

api.post("/report", async (c) => {
  let body: { sessionId?: string; language?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
  const session = sessions.get(body.sessionId);
  if (!session) return c.json({ error: "unknown session" }, 404);

  const { report, source, grounded } = await sessionReport(session, {
    language: typeof body.language === "string" ? body.language : undefined,
  });
  await trace({
    sessionId: body.sessionId,
    type: "verdict",
    status: session.lastStatus ?? "clear",
    report,
    source,
    grounded,
  });
  return c.json({
    report,
    source,
    grounded,
    generatedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /api/report/decision — human-in-the-loop record.
// ---------------------------------------------------------------------------

const DECISIONS = new Set(["approved", "edited", "discarded"]);

api.post("/report/decision", async (c) => {
  let body: { sessionId?: string; action?: string; editedText?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.sessionId) return c.json({ error: "sessionId is required" }, 400);
  if (!body.action || !DECISIONS.has(body.action)) {
    return c.json({ error: "action must be approved|edited|discarded" }, 400);
  }
  await trace({
    sessionId: body.sessionId,
    type: "human_action",
    action: body.action,
    ...(body.action === "edited" && typeof body.editedText === "string"
      ? { editedText: body.editedText }
      : {}),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/trace — session audit log.
// ---------------------------------------------------------------------------

api.get("/trace", async (c) => {
  const sessionId = c.req.query("sessionId") || undefined;
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
  return c.json({ entries: await readTrace(sessionId, limit) });
});

// ---------------------------------------------------------------------------
// POST /api/agent — intent-parsing agent over the CurbWatch tool belt.
// ---------------------------------------------------------------------------

interface AgentBody {
  sessionId?: string;
  message?: string;
  cameraId?: string;
  zone?: [number, number][];
}

function buildAgentTools(body: Required<Pick<AgentBody, "sessionId">> & AgentBody): AgentTools {
  return {
    search_cameras: async (args) => {
      const { cameras } = await getCameras();
      const result = searchCameras(
        cameras,
        typeof args.query === "string" ? args.query : undefined,
        typeof args.borough === "string" ? args.borough : undefined
      );
      return {
        totalMatches: result.totalMatches,
        cameras: result.cameras.map(({ id, name, area }) => ({ id, name, area })),
      };
    },

    analyze_camera: async (args) => {
      const cameraId =
        (typeof args.cameraId === "string" && args.cameraId) || body.cameraId;
      if (!cameraId) return { error: "cameraId is required" };
      if (inferenceCalls >= maxInferenceCalls()) {
        return { error: "inference budget exhausted", budget: budget() };
      }
      const frameRes = await fetch(`${NYCTMC}/${cameraId}/image`);
      if (!frameRes.ok) return { error: `camera frame fetch failed: ${frameRes.status}` };
      const bytes = Buffer.from(await frameRes.arrayBuffer());
      inferenceCalls++;
      const det = await detect(bytes);
      const counts: Record<string, number> = {};
      let confSum = 0;
      for (const p of det.predictions) {
        counts[p.class] = (counts[p.class] ?? 0) + 1;
        confSum += p.confidence;
      }
      return {
        cameraId,
        cameraName: await cameraName(cameraId),
        imageSize: det.image,
        totalDetections: det.predictions.length,
        countsByClass: counts,
        meanConfidence: det.predictions.length
          ? Number((confSum / det.predictions.length).toFixed(2))
          : null,
      };
    },

    lane_status: async () => {
      const session = sessions.get(body.sessionId);
      if (!session || session.frames === 0 || !session.lastResult) {
        return {
          watching: false,
          note: "The user is not currently monitoring a lane in this session.",
        };
      }
      return {
        watching: true,
        cameraName: session.cameraName,
        framesAnalyzed: session.frames,
        status: session.lastStatus,
        personCount: session.tracker.personCount,
        vehiclesInZone: session.lastResult.inZone.length,
        blocking: session.lastResult.blocking.map((t) => ({
          class: t.class,
          dwellFrames: t.dwellFrames,
          approxSeconds: t.dwellFrames * 3,
        })),
      };
    },

    generate_report: async () => {
      const session = sessions.get(body.sessionId);
      if (!session) return { error: "no monitoring session to report on" };
      const { report, source, grounded } = await sessionReport(session);
      await trace({
        sessionId: body.sessionId,
        type: "verdict",
        status: session.lastStatus ?? "clear",
        report,
        source,
        grounded,
      });
      return { report, source, grounded };
    },
  };
}

api.post("/agent", async (c) => {
  let body: AgentBody;
  try {
    body = await c.req.json<AgentBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const { sessionId, message } = body;
  if (!sessionId || !message) {
    return c.json({ error: "sessionId and message are required" }, 400);
  }
  if (!hasGeminiCredentials()) {
    return c.json({ error: "agent needs Gemini credentials" }, 503);
  }

  const ctx = {
    sessionId,
    cameraId: body.cameraId,
    zone: body.zone,
    cameraName: body.cameraId ? await cameraName(body.cameraId) : undefined,
  };
  try {
    const { reply, toolsUsed } = await runAgentLoop(
      message,
      ctx,
      buildAgentTools({ ...body, sessionId })
    );
    return c.json({ reply, toolsUsed, traceId: sessionId });
  } catch (err) {
    return c.json({ error: `agent failed: ${String(err)}` }, 502);
  }
});
