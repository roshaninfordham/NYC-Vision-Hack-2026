import { Hono } from "hono";

export const api = new Hono();

api.get("/status", (c) =>
  c.json({ ok: true, version: "0.1.0", features: ["cameras", "analyze", "report"] })
);
