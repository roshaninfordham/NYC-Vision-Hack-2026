# 🗽 CurbWatch

**An agentic vision system that watches NYC's 965 public traffic cameras and calls out
vehicles blocking bike and bus lanes — with a plain-English report you could hand to 311.**

Built in one evening at [AI Tinkerers NYC — Vision Hack v.2](https://nyc.aitinkerers.org/)
(Aug 7, 2026). Deployed on Google Cloud Run. Detection by Roboflow. Reasoning by Gemini.

> 🚧 Actively being built during the hackathon — README grows with the code.

## The problem

Double-parking in bike and bus lanes is a daily NYC failure: cyclists forced into traffic,
buses delayed, 311 complaints that arrive hours late with no evidence. The city already
points 965 public cameras at these exact lanes. CurbWatch turns any one of them into a
lane-blockage witness.

## Three features, nothing more

1. **Pick a camera** — search all online NYC DOT cameras, filter by borough.
2. **Watch a lane** — draw the lane zone once on the live frame; CurbWatch polls frames,
   runs object detection, and flags vehicles that sit in the zone across consecutive
   frames (stationary = blocked; passing through = ignored).
3. **Agent verdict** — Gemini turns the detection timeline into a human report: what's
   blocking, how long, severity, suggested action.

## Quick start

```bash
cp .env.example .env   # add your Roboflow key
npm install
npm run dev            # http://localhost:8080
```

## License

MIT
