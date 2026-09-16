// Production server. Dev uses `react-router dev` instead (see package.json).
// The in-process cron starts from the app bundle (app/services/scheduler.server.ts,
// booted by entry.server), so this file is just the HTTP server.
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";

const port = Number(process.env.PORT ?? 3000);

const build = await import("./build/server/index.js");

const app = express();

// We normally sit behind a reverse proxy that handles https and then talks to
// us over plain http. Trust its headers, otherwise Express thinks the request
// came in over http while the browser's Origin header says https, and React
// Router rejects every form post as a cross-site attack.
app.set("trust proxy", true);

app.use(compression());
app.disable("x-powered-by");

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

// Terminal middleware (no path) avoids Express 5 wildcard path parsing.
app.use(createRequestHandler({ build, mode: "production" }));

app.listen(port, () => {
  console.log(`Bouquet listening on http://localhost:${port}`);
});
