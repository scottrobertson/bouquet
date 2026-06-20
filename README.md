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
- Picking a non-default EPG channel also takes its logo, so you can borrow a nicer logo from another provider
- Group a channel with backup feeds as [alternates](#alternates-backup-channels)
- Smart sort an alt group best-first from probe data, with a preview before it applies
- Auto-sync categories that mirror a provider category and stay current (e.g. Pay Per View)

**Guide and playback**

- TV guide per playlist that you can scroll back and forward through
- Catchup support so players can replay past programmes
- Play any channel or past programme straight in VLC, or copy its URL

**Probing**

- Probe streams for resolution, frame rate, codecs, and bitrate
- Scheduled per source, or probe on demand
- Probe a whole playlist, just the missing or failed ones, a category, or one group
- Optional bitrate measuring for a real figure (off by default, it's slower)
- Black-screen detection marks dead channels failed even when ffprobe sees a valid stream (on by default)

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
- "Smart sort" orders a group by stream quality and promotes the best one to primary.

### Smart sort

Once you've probed a group, "Smart sort" in the group menu ranks its streams
best-first and makes the best one the primary. It tries to be objective about
"better":

- Resolution first, then frame rate, then bitrate. Bitrate is normalised per
  codec, so a HEVC stream isn't punished for hitting the same quality with fewer
  bits. Tiny bitrate differences are treated as a tie.
- Audio breaks those ties (surround over stereo).
- Streams that don't work sink to the bottom, in the order unprobed, then failed,
  then unavailable.

Because it can change which stream is primary, it shows a preview first: the new
order, each stream's data, how far each moves, and the exact rules it used. The
channel's name and guide stay the same, only the running order changes. You can
rank by bitrate first instead, and toggle the audio and working-first rules, in
playlist Settings.

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
