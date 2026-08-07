import "./env.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api.js";

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "curbwatch" }));
app.route("/api", api);
app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`curbwatch listening on :${info.port}`);
});
