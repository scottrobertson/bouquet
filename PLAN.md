# IPTV Manager — Plan and Status

## What this is

A self-hosted, open-source alternative to m3u4u. It takes one or more IPTV
sources, lets you merge their channels into curated playlists through a web UI,
and outputs a clean M3U file plus a matching XMLTV EPG to point your player at.

It is a playlist manager, not a proxy. It never touches the video streams. The
output M3U contains the provider's own direct stream URLs (for Xtream that is
the `http://server/live/user/pass/<stream_id>.ts` form). The app only ingests
metadata, lets you curate it, and generates the two output files.

## Decisions

- Docker-first, single container. Cloudflare stays possible but is not a constraint.
- Single user. Auth is deferred for now (no login). Output URLs are public and token-based so players can fetch them.
- Live channels only for v1. No VOD or series.
- Xtream Codes sources first. M3U source ingest comes later.
- Simple EPG matching: exact tvg-id match plus a manual per-channel override.
- Channels removed by the provider on resync are kept and flagged unavailable, not deleted.
- Drag and drop for building and ordering playlists.
- Integrated full-stack framework (React Router 7), not a SPA calling a separate JSON API.

## Tech stack

- React Router 7 (framework mode), SSR. Loaders load data, actions handle mutations. No hand-written JSON API.
- React 19, TypeScript, Tailwind v4, shadcn/ui (Radix primitives, pulled via the shadcn CLI).
- Drizzle ORM over SQLite (better-sqlite3, synchronous).
- dnd-kit for drag and drop.
- node-cron for the scheduled resync, started from a custom Express server.
- Self-hosted fonts (Inter, JetBrains Mono via fontsource). No CDNs.

Single project, not a monorepo. Server-only modules use the `.server.ts` suffix so
they never reach the client bundle.

## How it runs

- Dev: `npm run dev` (Vite dev server, HMR). No cron in dev; use the Sync now button.
- Prod: `npm run start` runs `server.js`, a custom Express server that mounts the
  React Router handler and starts node-cron. Cron hits the app's own
  `/internal/sync` endpoint (guarded by `SESSION_SECRET`) so all sync logic lives
  in one place.
- Migrations run automatically on first DB load (drizzle migrator, idempotent).
- Docker: multi-stage build, Debian-slim base so better-sqlite3 prebuilds work,
  SQLite on a mounted volume. `docker-compose.yml` ships with it.

Env: `APP_PASSWORD`, `SESSION_SECRET`, `DATABASE_PATH`, `SYNC_CRON`, `PORT`. In dev,
missing values fall back to insecure defaults; production refuses to start without them.

## Data model (app/db/schema.ts)

The stable key that makes resync-safe editing work is the Xtream `stream_id` per source.

- `sources` — a provider. name, type, serverUrl, username, password, syncStatus, lastSyncedAt, lastError, channelCount, createdAt.
- `source_channels` — raw catalog. (sourceId, streamId) unique. name, logo, epgChannelId, categoryName, tvArchive, available, lastSeenAt.
- `source_epg_channels` — EPG channels from the provider's xmltv.php, for the picker. (sourceId, channelId) unique.
- `playlists` — name, outputToken (unguessable slug for the public URLs), createdAt.
- `playlist_categories` — playlistId, name, position.
- `playlist_channels` — references sourceChannelId (stable across resync). customName, customLogo, position, enabled, epgSourceId, epgChannelId. Availability is read through the linked source channel.

User edits live on `playlist_channels` and reference `source_channel_id`, so a
resync that re-upserts `source_channels` by `stream_id` never disturbs them.

## Architecture

Routes (app/routes/):
- `_app.tsx` — sidebar layout wrapping the in-app screens.
- `sources._index`, `sources.new`, `sources.$id`, `sources.$id.edit` — source list, add/edit with test-connection, detail catalog.
- `playlists._index` — playlists table. `playlists.$id` — the editor. `playlists.$id.settings` — name, output URLs, delete. `playlists.$id.epg-channels` — lazy EPG list for the picker.
- `internal.sync` — POST endpoint the cron job calls.
- `output.m3u.$token`, `output.epg.$token` — public resource routes that return the files.

Server services (app/services/):
- `xtream/client.server.ts` — player_api calls (validate, categories, live streams), xmltv channel parsing, stream URL builder. Realistic user-agent, long timeout for the big EPG file.
- `sync/sync.server.ts` — `startSync` (background, non-blocking) and `runSync`. Channels commit first; EPG is best-effort so a slow or failing EPG never throws away a good catalog sync. `syncAllSources` for the cron.
- `playlist/queries.server.ts` and `mutations.server.ts` — all editor reads and writes, with playlist-ownership checks.
- `output/queries.server.ts`, `m3u.server.ts`, `xmltv.server.ts`, `cache.server.ts` — output generation with an in-memory cache and ETags.

## Features implemented

Sources
- Add and edit Xtream sources with a test-connection action.
- Background sync (returns immediately, the screen polls until done).
- Catalog screen with search, category filter, availability, capped to 500 rendered rows.
- Removed channels kept and flagged unavailable on resync.

Playlists
- List as a table (name, categories, channels, created, row actions), create/rename/delete.
- Editor with two panes under a single drag context:
  - Left "Source channels" browser: pick a source, multi-select category filter, search, grouped by category into collapsible sections. Channels already in the playlist are hidden. Rows are draggable.
  - Right playlist tree: categories (distinct sticky headers) with channels.
  - Drag a source channel (or a multi-select of them) into a category to add it. Reorder channels within and across categories. Reorder categories. All persisted, optimistic.
  - Per channel: inline rename, enable toggle, source/provider label, unavailable badge, remove, and an EPG picker.
  - EPG picker loads its (large) channel list lazily on open, so editing stays fast.
  - Save status indicator in the header (Saving / All changes saved).

EPG
- Each playlist channel points at an (epgSourceId, epgChannelId) pair, defaulting to its own source's EPG.

Output
- `/output/m3u/:token` returns a valid `m3u_plus` with the chosen tvg-id, logo, group-title, and the provider's direct stream URLs, plus a `url-tvg` header pointing at the EPG URL. Enabled and available channels only.
- `/output/epg/:token` returns a merged XMLTV built from the EPG sources actually used, filtered to the used channel ids.
- Both cached in memory with ETags and conditional GET.

## Dev notes and gotchas

- Vite pre-bundles dependencies. If a component imports a dep that was not
  pre-bundled, Vite re-optimizes mid-session, which 504s an open tab. The fix is
  `optimizeDeps.include` in `vite.config.ts` listing the heavy client deps
  (dnd-kit, radix-ui, cmdk, sonner, lucide, etc.) so they are all bundled at
  startup. This is the documented Vite mechanism, not a workaround.
- shadcn/ui is not a runtime library. The CLI copies component source into
  `app/components/ui/`. The unified `radix-ui` package powers them.
- Tool inputs suppress browser autofill and password-manager overlays by default
  (the shared `Input` sets `autocomplete="off"` and `data-1p-ignore` for non-password fields).

## Verification

- `docker compose up`, then add a real Xtream source and run a sync.
- Build a playlist: add a category, drag channels in, reorder, set a custom EPG.
- Open `/output/m3u/:token` and `/output/epg/:token`, confirm valid M3U and XMLTV, then load both in a real player (e.g. TiviMate).
- Headless checks (Playwright) cover the editor drag-to-create, the source select, the table, and the save status.

## Remaining work

- Auth (deferred): single password, cookie session, login route, loader guards. Output routes stay public.
- Real-provider verification of the EPG merge end to end (the XMLTV path fetches the provider's xmltv.php).
- Command palette (Cmd+K) and final polish.
- M3U source ingest (in addition to Xtream).
- VOD and series (later, larger data model).
