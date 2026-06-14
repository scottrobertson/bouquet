// Production server. Dev uses `react-router dev` instead (see package.json).
// We run a custom Express server here so node-cron starts at boot, independent
// of any HTTP request. The cron job just calls the app's own internal sync
// endpoint, so all sync logic stays in one place (the same code the UI uses).
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express from "express";
import cron from "node-cron";

const port = Number(process.env.PORT ?? 3000);
const syncCron = process.env.SYNC_CRON ?? "0 4 * * *";
const backupCron = process.env.BACKUP_CRON ?? "0 3 * * *";
const internalToken = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";

// Fire an internal POST endpoint from a cron job, so all the logic stays in the
// app (the same code the UI uses).
function scheduleInternal(label, expression, path) {
  if (!cron.validate(expression)) {
    console.warn(`[cron] invalid ${label} cron "${expression}", disabled`);
    return;
  }
  cron.schedule(expression, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "x-internal-token": internalToken },
      });
      console.log(`[cron] ${label} triggered: ${res.status}`);
    } catch (err) {
      console.error(`[cron] ${label} failed`, err);
    }
  });
  console.log(`[cron] scheduled ${label}: ${expression}`);
}

const build = await import("./build/server/index.js");

const app = express();
// Skip compressing tiny responses. React Router streams SSR in small chunks,
// and running each through brotli piled up enough drain listeners to trip
// Node's leak warning. Assets (JS/CSS) are well over this and still get compressed.
app.use(compression({ threshold: "1kb" }));
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

scheduleInternal("sync", syncCron, "/internal/sync");
scheduleInternal("backup", backupCron, "/internal/backup");
