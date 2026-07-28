# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Bouquet is a self-hosted IPTV playlist manager. You add Xtream Codes providers (sources), merge their channels into curated playlists through a web UI, and it serves back an M3U playlist plus a matching XMLTV EPG. It is a playlist manager, not a proxy: output M3U files contain the provider's own direct stream URLs, the video never passes through Bouquet.

## Commands

- `npm run dev` — dev server (React Router + Vite, HMR)
- `npm run build` — production build
- `npm run start` — run the production server (`server.js`, used in Docker)
- `npm run typecheck` — `react-router typegen` then `tsc`. Run this after changing routes, since route types are generated.
- `npm test` — run all tests once (Vitest)
- `npm run test:watch` — Vitest in watch mode
- Run a single test file: `npx vitest run test/m3u.server.test.ts`
- Filter by name: `npx vitest run -t "alternate"`

Database (Drizzle + SQLite):
- `npm run db:generate` — generate a migration after editing `app/db/schema.ts`
- `npm run db:migrate` — apply migrations manually (the app also applies them automatically on startup)
- `npm run db:studio` — open Drizzle Studio

There is no separate lint step. CI runs typecheck + tests, then builds the Docker image (`.github/workflows/ci.yml`).

## Architecture

**React Router 7 in framework mode.** Routes are declared explicitly in `app/routes.ts` (not file-based convention), pointing at files in `app/routes/`. Loaders/actions run on the server, components render isomorphically. Route prop types come from generated `./+types/<route>` imports, so run typegen after route changes.

**Server-only code uses the `.server.ts` suffix.** Anything touching the DB, env, or provider APIs lives in `app/services/**/*.server.ts` or `app/lib/*.server.ts`. The bundler keeps these out of the client. Routes call into the services layer; keep business logic there, not in route files.

**Data model (`app/db/schema.ts`).** The schema file is heavily commented and is the best map of how the app works. The core flow:
- `sources` are providers. `source_channels` / `source_epg_channels` / `source_categories` / `epg_programmes` are the raw catalog pulled from a source on sync. This is the source of truth and is keyed so resync never disturbs user edits.
- `playlists` → `playlist_categories` → `playlist_channels` are the curated output. A `playlist_channel` points at a `source_channel` and carries per-playlist overrides (custom name, logo, EPG, position, enabled). Edits reference the stable `source_channel_id` so they survive resync.
- **Alternates**: a `playlist_channel` with `primary_channel_id` set is a backup/duplicate grouped under another channel. They still emit as separate channels in the M3U; grouping is purely an editor/naming convenience. See the README's "Alternates" section and `app/services/playlist/alt-name.ts`.
- An "auto-sync group" is a `playlist_category` with `auto_source_id` set: it mirrors a source category live and has no `playlist_channels` rows.

**Sync (`app/services/sync/sync.server.ts`).** Pulls the catalog and per-channel EPG from the Xtream API (`app/services/xtream/client.server.ts`). EPG comes from `get_simple_data_table` per channel (includes aired programmes, unlike xmltv.php), fetched with a concurrency pool. Each source has its own `sync_interval_minutes`.

**Output (`app/services/output/`).** `output/m3u/:token` and `output/epg/:token` are public, unauthenticated routes hit by IPTV players, keyed by a per-playlist `output_token`. Results are cached (`cache.server.ts`), invalidated on sync and edits.

**Probing (`app/services/probe/`).** Runs ffprobe against streams to record quality (resolution, frame rate, codecs, bitrate) shown in the editor. Each probe opens a real connection to the provider, so the scheduled probe only covers channels actually in output (enabled, available, not in a disabled category). Manual probes (single channel, or "Probe all") use a wider net. Bitrate can't be read from a live stream, so measuring it reads the stream for the read time and weighs the data (off by default, it's slow). Probing can also flag all-black streams: it decodes a few seconds with ffmpeg's blackdetect and marks the channel failed if the picture is all black (on by default), catching dead channels that still look fine to ffprobe. Binaries come from `FFPROBE_PATH`/`FFMPEG_PATH`.

**Scheduling.** `app/services/scheduler.server.ts` boots `node-cron` in-process and calls the sync, probe, and backup service functions directly (the same functions the UI calls). It starts once when the server bundle loads, via an import in `app/entry.server.tsx`, and is guarded to production only. The cron ticks hourly and each job only acts on sources whose interval has elapsed; a tick is skipped if the previous run is still going. `server.js` is just the production HTTP server now.

**DB connection (`app/db/index.server.ts`).** Single `better-sqlite3` connection in WAL mode with foreign keys on, cached across HMR reloads. Migrations run once per process on first import. The raw `sqlite` handle is exported for backup/restore: a backup is a gzipped copy of the whole database file, and restore replaces everything then runs migrations, so an older backup is upgraded to the current schema (`app/services/backup/backup.server.ts`).

**UI.** Tailwind v4 + shadcn/ui (new-york style) in `app/components/ui/`. Path alias `~` → `app/`. Icons from `lucide-react`. Drag-and-drop ordering uses `@dnd-kit`; long channel lists use `@tanstack/react-virtual`.

## Notes

- **Auth is not wired up yet.** Despite the README mentioning an `APP_PASSWORD` login, `app/routes/_app.tsx` notes auth guards are still to come and every in-app screen is currently open. The only token check today is the internal cron endpoints.
- Tests run in a plain node environment (no React Router plugin). `test/setup-db.ts` points `CONFIG_PATH` at a fresh temp dir before any app module loads, so DB-backed tests never touch `./data/bouquet.db`.
- In dev, missing `APP_PASSWORD` / `SESSION_SECRET` fall back to insecure defaults; production refuses to start without them (`app/lib/env.server.ts`).
- Keep `CHANGELOG.md` updated with every feature/fix. Always add new entries, never go back and edit existing ones unless explicitly fixing a mistake.
