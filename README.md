# Bouquet

Self-hosted, open-source playlist manager for IPTV. Add your providers, merge
their channels into curated playlists through a web UI, and get back a clean
M3U file plus a matching XMLTV EPG to point your player at.

It's a playlist manager, not a proxy. It never touches the video streams. The
output M3U contains your provider's own direct stream URLs.

Built with [Claude](https://claude.com/claude-code).

## Features

- Add Xtream Codes sources (M3U sources coming later)
- Merge channels from multiple sources into playlists
- Categories, per-playlist renaming, custom logos, drag-and-drop ordering
- Per-channel EPG selection, defaulting to the channel's own source
- Group a channel with backup sources as [alternates](#alternates-backup-channels)
- Channels stay in sync with the source; removed ones are kept and flagged
- Outputs a standard `m3u_plus` playlist and a merged XMLTV guide

## Alternates (backup channels)

The same channel often shows up more than once: backups from a second provider,
duplicates on the same provider, or different quality feeds (FHD, UHD, and so
on). You can group a primary channel with one or more alternates so you have a
fallback when one source dies.

Alternates still come out as their own separate channels in the M3U. Bouquet
does not merge them or proxy anything. Grouping is about keeping these tidy in
the editor and keeping their names and metadata in step with the primary.

How it works:

- Create a group from the action bar. Select channels already in the playlist
  and choose "Make alternate of…", or select channels in the Source Channels
  pane and choose "Add as alternate of…", then pick the channel they sit under.
  Picking one of the selected channels as the target starts a new group.
- Alternates nest under their primary in the editor. A group collapses by
  default; use the chevron to expand it.
- Alternates always take the primary's name, logo and EPG. They are named
  automatically from a per-playlist template (default `{name} (Alt {n})`,
  editable in playlist Settings). Rename the primary and every alternate follows.
- You cannot rename an alternate or give it its own logo or guide. Those
  controls are hidden for alternates, and only the primary is editable.
- Each alternate's menu reorders it, removes it from the group, or deletes it.
  The top alternate's "Move up" promotes it into the primary spot, and the old
  primary becomes an alternate.
- Promoting an alternate, or deleting a primary (which promotes the first
  alternate), reverts the new primary to its own name and re-derives the rest.

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
| `SYNC_CRON` | `0 4 * * *` | Schedule for provider resync |
| `BACKUP_CRON` | `0 3 * * *` | Schedule for backups |
| `BACKUP_KEEP` | `14` | Scheduled backups to keep |
| `PORT` | `3000` | Server port |

Migrations apply automatically on startup.
