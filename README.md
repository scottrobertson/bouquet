# Bouquet

Self-hosted, open-source playlist manager for IPTV. Add your providers, merge
their channels into curated playlists through a web UI, and get back a clean
M3U file plus a matching XMLTV EPG to point your player at.

It's a playlist manager, not a proxy. It never touches the video streams. The
output M3U contains your provider's own direct stream URLs.

## Features

**Sources**

- Add Xtream Codes providers (M3U sources coming later)
- Set how often each source refreshes, or sync by hand
- Channels stay in sync with the provider; removed ones are kept and flagged
- See account expiry and connection limit per source
- Enable or disable categories, and auto-import new ones
- Change log of what each sync added or removed

**Playlists**

- Merge channels from multiple sources into curated playlists
- Two-pane editor with drag-and-drop ordering, categories, and renaming
- Bulk tools: move, enable/disable, sort, add prefix/suffix, find and replace, reset EPG
- Per-channel EPG, defaulting to the channel's own source
- Group a channel with backup feeds as [alternates](#alternates-backup-channels)
- Auto-sync categories that mirror a provider category and stay current (e.g. Pay Per View)

**Guide and playback**

- TV guide per playlist that you can scroll back and forward through
- Catchup support so players can replay past programmes
- Play any channel or past programme straight in VLC, or copy its URL
- Optional stream probing to show resolution, frame rate, codecs, and bitrate

**Output**

- A standard `m3u_plus` playlist and a matching XMLTV guide on public URLs
- Pick TS or M3U8 HLS output per source

**Operations**

- Backup and restore, on a schedule or by hand
- UI optimised for both desktop and mobile

## Alternates (backup channels)

The same channel often shows up more than once: backups from a second provider,
duplicates on the same provider, or different quality feeds (FHD, UHD, and so
on). You can group a primary channel with one or more alternates so you have a
fallback when one source dies.

Alternates still come out as their own separate channels in the M3U. Bouquet
does not merge them or proxy anything. Grouping just keeps them tidy in the
editor and keeps their names and metadata in step with the primary.

- Alternates nest under their primary in the editor and take its name, logo, and EPG.
  Rename the primary and every alternate follows, using a per-playlist template
  (default `{name} (Alt {n})`, editable in Settings).
- Group channels with "Make alternate of…" in the playlist, or "Add as alternate of…"
  when pulling them in from the Source Channels pane.
- Promote an alternate into the primary spot at any time, and it reverts to its own name.

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
the SQLite file is created at `./data/bouquet.db`.

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
| `CONFIG_PATH` | `./data` | Directory for the database and backups |
| `SYNC_CRON` | `0 * * * *` | How often the sync check runs (each source syncs on its own interval) |
| `PROBE_CRON` | `0 * * * *` | How often the stream-probe check runs |
| `BACKUP_CRON` | `0 3 * * *` | Schedule for backups |
| `BACKUP_KEEP` | `14` | Scheduled backups to keep |
| `FFPROBE_PATH` | `ffprobe` | Path to the ffprobe binary (for stream probing) |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary |
| `PORT` | `3000` | Server port |

Migrations apply automatically on startup.

## Built with Claude

Most of this was written with [Claude](https://claude.com/claude-code). Every
change is reviewed by a human before it lands, so nothing goes in unread. Treat
it like any other code: read it, test it, and open an issue if something looks
off.
