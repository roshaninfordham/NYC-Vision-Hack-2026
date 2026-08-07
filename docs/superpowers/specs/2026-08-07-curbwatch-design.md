# CurbWatch — Design Spec

**Date:** 2026-08-07 · **Event:** NYC Vision Hack v.2 (AI Tinkerers NYC) · **Deadline:** 8:30 PM submission lock

## One-liner

An agent that watches any of NYC's 965 DOT traffic cameras and calls out vehicles blocking
bike/bus lanes, producing a plain-English report you could hand to 311.

## Why this problem

Double-parking in bike and bus lanes is a daily, visceral NYC failure: cyclists forced into
traffic, buses delayed, 311 complaints that arrive hours late with no evidence. The city
already owns 965 public cameras pointed at exactly these lanes. CurbWatch turns any one of
them into a lane-blockage witness.

## Features (exactly three)

1. **Pick a camera** — searchable, borough-filterable list of all online DOT cameras
   (from `https://webcams.nyctmc.org/api/cameras`), with live thumbnail preview.
2. **Watch a lane** — user draws the lane zone once as a polygon on the live frame.
   App polls 1 frame / 3 s, runs Roboflow object detection, overlays boxes, and flags any
   vehicle whose footprint (bottom-center of bbox) sits inside the zone for ≥ 3 consecutive
   frames — stationary ⇒ *blocked*, passing through ⇒ ignored.
3. **Agent verdict** — Gemini receives the detection timeline + a keyframe and writes the
   human report: what's blocking, for how long, severity, suggested action. Generated
   on-demand or every ~30 s — never per frame.

## Architecture

Single container on **Google Cloud Run** (eligibility gate).

- **Runtime:** Node.js 22 + TypeScript, Hono server. Serves static frontend + JSON API.
- **Core module (`src/core/`)** — dependency-light, exportable as npm package later:
  zone geometry (point-in-polygon), stationarity tracker (IoU across frames), Roboflow
  client, report prompter. No framework imports.
- **API routes:**
  - `GET /api/cameras` — DOT camera list, cached 5 min server-side.
  - `GET /api/frame/:id` — frame proxy (dodges CORS, enables caching/replay capture).
  - `POST /api/analyze` — `{cameraId, zone, frameSeq}` → Roboflow detection → zone/stationarity logic → structured verdict per frame.
  - `POST /api/report` — detection timeline → Gemini → plain-English report.
- **Detection:** Roboflow hosted serverless API, public Universe COCO-class model
  (vehicles + people). Model id chosen by live testing before wiring in.
- **Reasoning:** Gemini. On Cloud Run: Vertex AI via the service's built-in identity —
  no API key in the container. Local dev: AI Studio key in `.env` (never committed).
- **Credit guard:** server-side counter + per-session frame cap; **replay mode** serves
  pre-recorded frames + cached detections so the fallback demo costs zero Roboflow credits.
- **Frontend:** vanilla TS + canvas (zone drawing, box overlay). No framework.

## Data flow

```
DOT camera ──frame──▶ /api/frame ──▶ browser canvas
browser ──{zone, frame ref}──▶ /api/analyze ──▶ Roboflow serverless ──▶ detections
detections ──▶ core: in-zone? stationary? ──▶ per-frame verdict ──▶ UI overlay + timeline
timeline + keyframe ──▶ /api/report ──▶ Gemini ──▶ plain-English agent report
```

## Error handling

- Camera offline / stale frame → surface status chip, offer replay mode.
- Roboflow error or budget exceeded → degrade to frame-only view with notice.
- Gemini unavailable → show structured timeline verdict without prose report.

## Testing

Hackathon-scale: unit tests for core geometry/stationarity logic only (pure functions,
fast to test, highest bug risk). API + UI verified by hand against live feeds.

## Out of scope (YAGNI)

Multi-camera dashboards, user accounts, persistence beyond in-memory session, alerting,
plate/face recognition (privacy: frames are low-res; we detect classes, not identities).

## Open source

MIT. README tells the story: problem, mermaid architecture + sequence diagrams, honest
"what works / what's stubbed", credit-frugality notes, deploy instructions.
