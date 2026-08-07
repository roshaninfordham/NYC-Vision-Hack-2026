# CurbWatch — Hackathon Submission

**Live on Cloud Run:** https://curbwatch-631243785209.us-central1.run.app
**Repo:** https://github.com/roshaninfordham/NYC-Vision-Hack-2026
**Demo script:** [DEMO.md](DEMO.md) · **Full docs:** [README.md](README.md)

---

## Project Concept

New York City receives over a million illegal-parking complaints a year through 311 —
tens of thousands of them for blocked bike and bus lanes. Nearly all are closed with no
action, for one structural reason: by the time anyone can respond, the vehicle is gone
and no evidence survives. Meanwhile the city already operates **963 live public traffic
cameras**, many pointed directly at those same lanes, refreshing every few seconds. They
are used for looking, not for acting.

**CurbWatch closes that gap.** It turns any city camera into an enforcement-grade witness.
You pick a camera, trace the lane once with four clicks, and an agent watches it: object
detection finds vehicles, a tracker proves a vehicle *stayed* rather than passed through,
and Gemini — looking at the actual camera frame, not just the detector's output — writes
a 311-ready report in your language. A human approves it, and it exports as a timestamped
evidence bundle with a complete audit trail of everything the AI did.

**Our goal** is to make the evidence needed to clear a blocked lane cost **three cents and
ninety seconds** instead of a dispatched inspection — cheap enough that a city could sweep
every camera it owns for about $29 and finally know where the *chronic* blockages are,
rather than only where someone complained.

**How others can contribute:** the detection and tracking logic lives in `src/core/` with
zero framework dependencies and 48 unit tests, designed to be extracted as an npm package
(`curbwatch-core`). Open directions: better multi-object tracking for dense intersections,
bus-lane-specific zone presets, aggregating evidence bundles into a chronic-hotspot map,
and connecting the bundle output to a real 311 submission path.

---

## Project Description

CurbWatch is an agentic vision system that transforms NYC's public traffic-camera network
into an accountability tool for blocked bike and bus lanes — deployed as a single
container on **Google Cloud Run**.

**How the NYC data becomes an intelligent vision agent, in three steps:**

1. **Pick a camera.** All 963 online NYC DOT cameras render as points on a dark map,
   overlaid with **29,682 bike-lane segments from NYC Open Data**, so you can see which
   cameras actually watch a protected lane. Search by street, filter by borough, or just
   ask the agent in plain language.
2. **Trace the lane and watch.** Four clicks define the lane polygon. CurbWatch then polls
   a live frame every 3 seconds and runs detection through **Roboflow's hosted inference
   API**. A single detection is not evidence, so our tracker matches vehicles across frames
   by IoU: a vehicle passing through is ignored, while one whose footprint stays in the
   lane for ≥3 consecutive frames is flagged as **blocking**, with a live dwell clock.
   Click any vehicle to target-lock it and follow that specific object across frames.
3. **Get a grounded verdict.** The report call sends **the actual camera frame** to Gemini
   alongside the detection timeline. Gemini cross-checks the detector's labels against the
   image, corrects mislabels, and states honestly when the detector is wrong — then writes
   the verdict in the user's language. A human **approves, edits, or discards** it before
   anything is filed, and the approved result downloads as an evidence bundle.

**Working demo on real feeds:** every number and frame in the demo is live from
`webcams.nyctmc.org`. Verified in production at demo time: 963 cameras listed,
0.5–1.3 s per analyzed frame, 1.2 s per grounded report, agent replies correct in
English, Spanish, Hindi and Nepali. A zero-cost **replay mode** (12 committed frames with
cached detections) is built in as a fallback if a camera goes dark on stage.

**Usefulness in numbers:** ~90 seconds and **≈ $0.03** to verify one complaint with
evidence; **≈ $29** to sweep all 963 cameras once. The output artifact — camera
coordinates, keyframe, dwell timeline, human decision, and full JSONL agent trace in one
timestamped file — does not exist in the 311 process today.

**Technical execution:** Node 22 + TypeScript + Hono in one container; `src/core/` is
dependency-free and unit-tested (48 tests); vanilla JS frontend with no build step;
server-side credit guard caps inference spend and returns 429 gracefully; Gemini runs on
the cheapest Flash-Lite tier and is called once per *report*, not once per frame.

**Data craft and responsibility:** all sources are public and cited (NYC DOT camera API,
NYC Open Data bike routes). Detection runs on the **same bytes** shown to the user, so
overlays can never drift from the evidence. Every LLM call, tool call, verdict, and human
decision is appended to a **JSONL trace** that is viewable and downloadable in-app —
the agent is auditable, not trusted. And by design CurbWatch detects **vehicle classes
only — no license plates, no faces, no identity**: the enforcement question is "is the
lane blocked and for how long," which a class and a clock answer. Nothing persists beyond
an in-memory session.

---

## Products & Tools Used

**Google Cloud (eligibility gate + reasoning)**
- **Cloud Run** — the entire app is one scale-to-zero container deployed from source via
  `./deploy.sh` (the script also auto-grants the Cloud Build role fresh projects lack).
  Hosts the API, the static frontend, and the replay bundle.
- **Cloud Build + Artifact Registry** — source-to-container build pipeline.
- **Gemini (`gemini-flash-lite-latest`, cheapest tier)** — two distinct roles:
  (1) **multimodal grounding** — the camera keyframe is sent as `inlineData` so Gemini
  verifies the detector against the image; (2) **function calling** — the agent loop
  picks among four tools (`search_cameras`, `analyze_camera`, `lane_status`,
  `generate_report`), max 4 rounds. Reached via the Generative Language API, with a
  **Vertex AI** fallback using the Cloud Run service identity (no key in the container).
- **Google Cloud APIs / IAM / API Keys API** — service configuration and a
  Generative-Language-restricted key.

**Roboflow (vision)**
- **Hosted serverless inference API** (`serverless.roboflow.com`) with the public
  **`coco/24`** model, chosen by benchmarking candidates on a real 352×240 NYC traffic
  frame: it detected vehicles *and* people and scored 0.83–0.87 on small distant objects
  where alternatives dropped to 0.40 or misclassified. ~130 ms per frame.
- Roboflow's **computer-vision-skills** guidance informed the integration pattern:
  keep the container light and call hosted inference from Cloud Run rather than bundling
  weights. Confidence threshold is env-tunable (`ROBOFLOW_CONFIDENCE`, default 40).

**NYC public data**
- **NYC DOT traffic cameras** (`webcams.nyctmc.org/api/cameras`) — 963 live feeds.
- **NYC Open Data — Bicycle Routes** (`mzxg-pwib`) — 29,682 segments, simplified from
  20 MB to 1.35 MB for the map overlay.

**Open source / web platform**
- **Hono** (HTTP), **Node 22 + TypeScript**, **node:test** (48 unit tests).
- **Leaflet 1.9.4** (vendored, no CDN) + **OpenStreetMap** tiles, restyled dark.
- **Web Speech API** — press-to-talk voice input and spoken replies, for a city that
  speaks 800+ languages.
- **Canvas 2D** for zone tracing, detection overlays, and target-lock rendering.

**Team**
- **Roshan Sharma (Lead)** — solo build: product definition and NYC problem framing,
  system architecture, backend (core geometry/tracker, Roboflow and Gemini integration,
  agent loop, JSONL tracing, credit guard), frontend (map picker, zone tracing, watch
  view, agent chat, evidence bundle), Cloud Run deployment and IAM, testing, and docs.
