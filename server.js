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
const internalToken = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";

const build = await import("./build/server/index.js");

const app = express();
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
  console.log(`IPTV Manager listening on http://localhost:${port}`);
});

if (cron.validate(syncCron)) {
  cron.schedule(syncCron, async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/sync`, {
        method: "POST",
        headers: { "x-internal-token": internalToken },
      });
      console.log(`[cron] sync triggered: ${res.status}`);
    } catch (err) {
      console.error("[cron] sync failed", err);
    }
  });
  console.log(`[cron] scheduled sync: ${syncCron}`);
} else {
  console.warn(`[cron] invalid SYNC_CRON "${syncCron}", scheduled sync disabled`);
}
