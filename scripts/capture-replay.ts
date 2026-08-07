/**
 * Capture replay data for demo fallback mode.
 *
 * Usage: npx tsx scripts/capture-replay.ts <cameraId> [frameCount] [intervalMs]
 *
 * Grabs frames from the NYC DOT camera at ~3 s intervals, runs Roboflow
 * detection on each (counts against Roboflow credits — run once!), and
 * writes a committable bundle:
 *   replay/frames/NN.jpg   — raw JPEG frames
 *   replay/detections.json — one RoboflowResult per frame
 *   replay/meta.json       — camera name/id, capture timestamp
 */
import "../src/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { detect, type RoboflowResult } from "../src/core/index.js";

const cameraId = process.argv[2];
if (!cameraId) {
  console.error("usage: tsx scripts/capture-replay.ts <cameraId> [frameCount] [intervalMs]");
  process.exit(1);
}
const frameCount = Number(process.argv[3] ?? 12);
const intervalMs = Number(process.argv[4] ?? 3000);

const NYCTMC = "https://webcams.nyctmc.org/api/cameras";
const outDir = resolve(process.cwd(), "replay");
const framesDir = resolve(outDir, "frames");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(framesDir, { recursive: true });

  let cameraName = cameraId;
  try {
    const res = await fetch(NYCTMC);
    if (res.ok) {
      const all = (await res.json()) as { id: string; name: string }[];
      cameraName = all.find((c) => c.id === cameraId)?.name ?? cameraId;
    }
  } catch {
    // name lookup is best-effort
  }
  console.log(`capturing ${frameCount} frames from "${cameraName}" (${cameraId})`);

  const detections: RoboflowResult[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frameRes = await fetch(`${NYCTMC}/${cameraId}/image`);
    if (!frameRes.ok) throw new Error(`frame fetch failed: ${frameRes.status}`);
    const bytes = Buffer.from(await frameRes.arrayBuffer());
    const det = await detect(bytes);
    detections.push(det);
    const name = `${String(i).padStart(2, "0")}.jpg`;
    await writeFile(resolve(framesDir, name), bytes);
    console.log(
      `  frame ${name}: ${bytes.length} bytes, ${det.predictions.length} detections ` +
        `(${det.predictions.map((p) => p.class).join(", ") || "none"})`
    );
    if (i < frameCount - 1) await sleep(intervalMs);
  }

  await writeFile(
    resolve(outDir, "detections.json"),
    JSON.stringify(detections, null, 2)
  );
  await writeFile(
    resolve(outDir, "meta.json"),
    JSON.stringify(
      {
        cameraId,
        cameraName,
        capturedAt: new Date().toISOString(),
        frameCount,
        intervalMs,
      },
      null,
      2
    )
  );
  console.log(`wrote ${frameCount} frames + detections.json + meta.json to replay/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
