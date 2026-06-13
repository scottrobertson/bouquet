# IPTV Manager

Self-hosted, open-source playlist manager for IPTV. Add your providers, merge
their channels into curated playlists through a web UI, and get back a clean
M3U file plus a matching XMLTV EPG to point your player at.

It's a playlist manager, not a proxy. It never touches the video streams. The
output M3U contains your provider's own direct stream URLs.

## Features

- Add Xtream Codes sources (M3U sources coming later)
- Merge channels from multiple sources into playlists
- Categories, per-playlist renaming, custom logos, drag-and-drop ordering
- Per-channel EPG selection, defaulting to the channel's own source
- Channels stay in sync with the source; removed ones are kept and flagged
- Outputs a standard `m3u_plus` playlist and a merged XMLTV guide

## Tech

React Router 7 (framework mode), Tailwind + shadcn/ui, Drizzle + SQLite, run as
a single Node process. Built to run in one Docker container.

## Run with Docker

```sh
cp .env.example .env   # set APP_PASSWORD and SESSION_SECRET
docker compose up -d
```

Then open http://localhost:3000 and log in with `APP_PASSWORD`.

## Develop

```sh
npm install
npm run dev
```

In dev, missing env vars fall back to insecure defaults (password `admin`), and
the SQLite file is created at `./data/iptv.db`.

### Useful scripts

- `npm run build` — production build
- `npm run start` — run the production server (`server.js`)
- `npm run typecheck` — typegen + tsc
- `npm run db:generate` — generate a migration after changing the schema
- `npm run db:migrate` — apply migrations
- `npm run db:studio` — open Drizzle Studio

## Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `APP_PASSWORD` | `admin` (dev only) | Single login password |
| `SESSION_SECRET` | dev default | Signs the session cookie |
| `DATABASE_PATH` | `./data/iptv.db` | SQLite file location |
| `SYNC_CRON` | `0 4 * * *` | Schedule for provider resync |
| `PORT` | `3000` | Server port |

Migrations apply automatically on startup.
