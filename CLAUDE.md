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

Before starting `npm run dev`, check whether port 5173 is already in use (`lsof -i :5173`). The dev server is often already running manually in another terminal tab. If it's up, use that one instead of starting a second.

Database (Drizzle + SQLite):
- `npm run db:generate` — generate a migration after editing `app/db/schema.ts`
- `npm run db:migrate` — apply migrations manually (the app also applies them automatically on startup)
- `npm run db:studio` — open Drizzle Studio

There is no separate lint step. CI runs typecheck + tests, then builds the Docker image (`.github/workflows/ci.yml`).

## Where things live

- `app/routes.ts` is the route map. Read it first to find the file behind any URL. Route files are thin; they parse the request and call into services.
- `app/services/<area>/` holds the real logic, one folder per area: `sync`, `probe`, `output`, `playlist`, `guide`, `upload`, `backup`, `sources`, `xtream`.
- `app/db/schema.ts` is the data model, heavily commented. When you're unsure how a feature hangs together, the schema comments are the best map.
- `app/components/<area>/` groups UI by screen: `playlist/` (the editor), `guide/`, `sources/`, `playlists/`. `app/components/ui/` is generated shadcn/ui, leave it alone unless adding a new shadcn component.
- `app/lib/` is small shared helpers (env, url building, quality labels, concurrency pool, dnd sensors, the live revalidate hook).
- `test/` is flat, one file per module, named after what it covers (`m3u.server.test.ts` tests `app/services/output/m3u.server.ts`).
- `data/` holds the runtime SQLite db and backups in dev/prod. Tests never touch it.
- The dev database in `data/` usually has real sources and playlists in it, so it's often quicker to look at real behaviour through the running app than to construct test data.

## Architecture

**React Router 7 in framework mode.** Routes are declared explicitly in `app/routes.ts` (not file-based convention), pointing at files in `app/routes/`. Loaders/actions run on the server, components render isomorphically. Route prop types come from generated `./+types/<route>` imports, so run typegen after route changes.

**Server-only code uses the `.server.ts` suffix.** Anything touching the DB, env, or provider APIs lives in `app/services/**/*.server.ts` or `app/lib/*.server.ts`. The bundler keeps these out of the client. Routes call into the services layer; keep business logic there, not in route files.

**Data model (`app/db/schema.ts`).** The core flow:
- `sources` are providers. `source_channels` / `source_epg_channels` / `source_categories` / `epg_programmes` are the raw catalog pulled from a source on sync. This is the source of truth and is keyed so resync never disturbs user edits.
- `playlists` → `playlist_categories` → `playlist_channels` are the curated output. A `playlist_channel` points at a `source_channel` and carries per-playlist overrides (custom name, logo, EPG, position, enabled). Edits reference the stable `source_channel_id` so they survive resync.
- **Alternates**: a `playlist_channel` with `primary_channel_id` set is a backup/duplicate grouped under another channel. They still emit as separate channels in the M3U; grouping is purely an editor/naming convenience. See the README's "Alternates" section and `app/services/playlist/alt-name.ts`.
- An "auto-sync group" is a `playlist_category` with `auto_source_id` set: it mirrors a source category live and has no `playlist_channels` rows.

**Sync (`app/services/sync/sync.server.ts`).** Pulls the catalog and per-channel EPG from the Xtream API (`app/services/xtream/client.server.ts`). EPG comes from `get_simple_data_table` per channel (includes aired programmes, unlike xmltv.php), fetched with a concurrency pool. Each source has its own `sync_interval_minutes`. Every sync also records a diff (channels added/removed/renamed, availability flips) via `app/services/sources/changes.server.ts`, shown on the source's Changes page.

**Output (`app/services/output/`).** `output/m3u/:token` and `output/epg/:token` are public, unauthenticated routes hit by IPTV players, keyed by a per-playlist `output_token`. Results are cached (`cache.server.ts`), invalidated on sync and edits. `queries.server.ts` resolves a playlist into its final channel list (overrides applied, alternates named, auto groups expanded); both the M3U and XMLTV builders and the guide feed off it, so output-shape changes usually go there.

**Uploads (`app/services/upload/`).** A playlist can have upload destinations (local path or S3) that get the freshly built M3U + EPG pushed to them after a sync, debounced so one cron tick uploads once. All storage-library specifics stay in `storage.server.ts` behind the small `UploadTarget` interface.

**Probing (`app/services/probe/`).** Runs ffprobe against streams to record quality (resolution, frame rate, codecs, bitrate) shown in the editor. Each probe opens a real connection to the provider, so the scheduled probe only covers channels actually in output (enabled, available, not in a disabled category). Manual probes (single channel, or "Probe enabled") use a wider net, but still only cover switched-on channels, so auto-disabled ones have their own action. Bitrate can't be read from a live stream, so measuring it reads the stream for the read time and weighs the data (off by default, it's slow). Probing can also flag all-black streams: it decodes a few seconds with ffmpeg's blackdetect and marks the channel failed if the picture is all black (on by default), catching dead channels that still look fine to ffprobe. Binaries come from `FFPROBE_PATH`/`FFMPEG_PATH`.

**Scheduling.** `app/services/scheduler.server.ts` boots `node-cron` in-process and calls the sync, probe, and backup service functions directly (the same functions the UI calls). It starts once when the server bundle loads, via an import in `app/entry.server.tsx`, and is guarded to production only. The cron ticks hourly and each job only acts on sources whose interval has elapsed; a tick is skipped if the previous run is still going. `server.js` is just the production HTTP server.

**Live updates (SSE).** Background sync/probe/upload runs tell open browser tabs about progress through an in-memory event bus (`app/services/events.server.ts`), streamed over the `/events` SSE route. On the client, `useLiveRevalidate` (`app/lib/use-live-revalidate.ts`) revalidates the current route's loaders while a job is running, so pages update without polling. Tabs never read the event payload, they just revalidate. This all relies on the app being a single Node process.

**Playlist editor.** The main screen of the app, at `playlists/:id`. `app/components/playlist/editor-board.tsx` is the whole editor: playlist pane on the left, source browser on the right. The playlist pane virtualises with `@tanstack/react-virtual`, so it renders a flat list of `BoardRow`s (`board-rows.ts`) rather than nested category/channel components; categories, primaries, alternates and auto-group channels are all row kinds in that one flat list. Drag-and-drop uses `@dnd-kit` and is disabled while the playlist filter is active. Mutations post to the route action and are handled in `app/services/playlist/mutations.server.ts`.

**Guide.** Each playlist has an in-app EPG grid at `playlists/:id/guide`. `app/services/guide/guide.server.ts` builds the channel/programme data (batched queries, catchup URL templates), `app/components/guide/` renders the grid.

**DB connection (`app/db/index.server.ts`).** Single `better-sqlite3` connection in WAL mode with foreign keys on, cached across HMR reloads. Migrations run once per process on first import. The raw `sqlite` handle is exported for backup/restore: a backup is a gzipped copy of the whole database file, and restore replaces everything then runs migrations, so an older backup is upgraded to the current schema (`app/services/backup/backup.server.ts`).

**Logo proxy (`/img`).** Channel logos are proxied through our origin because providers serve them over http (mixed content on an https page) or block hotlinking. Build logo URLs with `app/lib/logo.ts`, don't link provider image URLs directly.

**UI.** Tailwind v4 + shadcn/ui (new-york style) in `app/components/ui/`. Path alias `~` → `app/`. Icons from `lucide-react`.

## Adding a feature

The usual shape of a change, so nothing gets forgotten:

1. Schema change first if needed (`app/db/schema.ts`, then `npm run db:generate`). Add comments to new tables/columns like the existing ones.
2. Logic in a service under `app/services/`, route file stays thin.
3. New route? Declare it in `app/routes.ts`, then `npm run typecheck` to regenerate route types.
4. Tests in `test/`, named after the module. Prefer testing the service, not the route.
5. Add a `CHANGELOG.md` entry (see Notes).
6. If it changed the UI, load it in Safari via the Safari MCP and check it actually works.

## Notes

- **Auth is not wired up yet.** Despite the README mentioning an `APP_PASSWORD` login, `app/routes/_app.tsx` notes auth guards are still to come and every in-app screen is currently open. The only token check today is the internal cron endpoints. The output and `/img` routes are public by design.
- Tests run in a plain node environment (no React Router plugin, own `vitest.config.ts`). `test/setup-db.ts` points `CONFIG_PATH` at a fresh temp dir before any app module loads, so DB-backed tests never touch `./data/bouquet.db`.
- In dev, missing `APP_PASSWORD` / `SESSION_SECRET` fall back to insecure defaults; production refuses to start without them (`app/lib/env.server.ts`).
- Keep `CHANGELOG.md` updated with every feature/fix. Entries go under `## [Unreleased]` in Added/Changed/Fixed sections, written as short user-facing prose that explains what changed and why it matters, not commit-style one-liners. Match the tone of the existing entries. Always add new entries, never go back and edit existing ones unless explicitly fixing a mistake.
- Use the Safari MCP to load the app and check UI changes actually work, rather than assuming they do from the code alone.
- SQLite caps bound variables per statement, so anything querying or inserting by a big list of ids must chunk (see `ID_CHUNK`/`INSERT_CHUNK` in the guide and changes services for the pattern).
