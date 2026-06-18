# Changelog

All notable changes to this project are recorded here. Newest first.

## [Unreleased]

### Added

- "Play in VLC" and "Copy stream URL" in each channel's ⋯ menu, in both the playlist editor
  and the guide. Play in VLC opens the provider's direct stream via the `vlc://` handler;
  Copy stream URL puts the same URL on the clipboard for pasting into a player.
- "Play catchup in VLC" and "Copy catchup URL" on a past programme in the guide, when its
  channel offers catchup and the provider has it archived. Click the programme to open its
  details and the two actions appear, built from that programme's start time and length.
- Stream probing. Bouquet can now run ffprobe against each stream to record its
  resolution, frame rate, video/audio codec and bitrate, shown as a quality line under each
  channel in the playlist editor. Turn it on per source and set the concurrency (how many
  streams to probe at once), how often it runs, and how long ffprobe reads each stream. Only
  channels used in a playlist are probed, since each probe opens a real connection to the
  provider. Probe a source by hand with "Probe now", or let the hourly scheduler handle it
  per the source's frequency (`PROBE_CRON` sets how often the check runs). Progress shows
  live on the sources pages and the editor fills in as results land. The Docker image now
  includes ffmpeg; set `FFPROBE_PATH`/`FFMPEG_PATH` if the binaries live somewhere unusual.
  Probe a single channel from its ⋯ menu in the editor, or "Probe all" to probe every
  channel in a playlist at once. Both run even for channels whose source has probing turned
  off, or that are unavailable or in a disabled category, unlike the scheduled probe.
  Optionally measure real bitrate per source: it reads each stream for the read time and
  weighs the data, since ffprobe can't report a bitrate for live streams. Off by default
  because it makes probing much slower (it downloads several MB per channel).
- Account details on sources: expiry date and connection limit show on the sources list and
  the source page, read from the provider on each sync. The source page also shows the
  account status (desktop only). Expired dates are flagged in red. The account columns are
  hidden on the list on mobile. Before a source's first sync these read "Unknown".
- Sort tool in the playlist editor. Select channels, open Tools, and pick A→Z or Z→A to
  sort them by name within their category. They drop back into the slots they already
  occupied, so unselected channels don't move and selections spanning categories sort each
  category on its own. Numbers sort naturally (ESPN 2 before ESPN 10), and alternates stay
  grouped under their primary.
- Tidied the bulk-action bar: Move to… and Make alternate of… stay top-level, and the rest
  (enable, disable, sort, rename, EPG) live under Tools.
- Moved "Add category" from the bottom of the playlist into its header, as a row that
  mirrors the source browser's filter/search row. The channel list now runs the full height
  of the pane.
- Per-source refresh frequency on the source form: every hour, 6 hours, 12 hours, daily,
  or manual only. The scheduler now checks every hour and syncs only the sources whose
  interval has elapsed, so each provider refreshes on its own schedule. "Manual only"
  sources are never auto-synced; you sync them by hand (the sync buttons still work for
  any source). Existing and new sources default to daily, matching the old behaviour.
  `SYNC_CRON` still works but now sets how often the check runs (default hourly).
- TV guide per playlist. A "Guide" button on the playlist opens a TiViMate style grid:
  channels down the left, a scrollable timeline across the top, programmes laid out by
  time with the airing one highlighted and a "now" line. It loads instantly because
  programmes are read from the database, not fetched live. The guide and the EPG output
  now come from the same stored data, so they always match. Past programmes are dimmed,
  and ones the provider marks as available from the archive are flagged for catchup.
  Scroll horizontally for past and future, or jump by day. Programmes are fetched during
  sync from the provider's per-channel EPG endpoint (get_simple_data_table), the same one
  TiViMate uses, so recently-aired programmes show up too, not just what's upcoming. Only
  channels in enabled categories are fetched, to keep it quick. Change which categories are
  enabled and the source shows a reminder to sync, since the guide for the newly enabled
  channels won't be there until then.
- Alternates: group a channel with its backup feeds, whether from another provider, a
  duplicate on the same provider, or a different quality (FHD/UHD/etc). The backups
  still come out as separate channels in the M3U (no merging), but in the editor they nest
  under their primary and are named automatically from a per-playlist template (default
  `{name} (Alt {n})`, editable in Settings). Rename the primary and the alternates follow.
  Select playlist channels and use "Make alternate of…" in the action bar to fold them into
  a group under any channel (picking one of the selected channels starts a new group). The
  Source Channels pane has the same "Add as alternate of…" alongside "Add to category", so
  you can drop new backups straight into a group. Each alternate's menu reorders it within
  the group, ungroups it, removes it, or (for the top one) moves it up into the primary
  spot. A group drags as one unit when you reorder it. Alternates always take the primary's
  name, logo and EPG: they can't be renamed or given their own guide (their logo is hidden in
  the editor), and renaming or changing the primary updates them all. Promoting an alternate
  (or deleting the primary, which promotes the first alternate) reverts the new primary to
  its own name and re-derives the rest.
- Catchup/archive support in the output M3U. Channels whose provider keeps an archive now
  carry `catchup="default"`, `catchup-days` (the number of days the provider keeps), and a
  `catchup-source` timeshift URL, so players can play back past programmes. The archive
  duration is read from the provider on each sync. Existing channels show no archive until
  the next sync repopulates them.
- A "Sync all" button on the Sources page that kicks off a background sync for every
  source at once; the page polls until they finish.
- Output stream URLs now use the provider's real base address from the API's
  `server_info` (cached on each sync), instead of the source's configured Server URL.
  This means the Server URL can point at a proxy or VPN container (for when a provider
  blocks your server) while the M3U still hands players the real provider address. Falls
  back to the Server URL if a provider doesn't return a usable `server_info`.
- Per-source output format (TS / M3U8 HLS) on the source form. The chosen format is
  used when building that source's stream URLs in the output M3U.
- Per-source "Auto-import new groups" toggle. When on (default), categories found on a
  sync start enabled; when off, new categories arrive disabled and you turn them on
  from the source's Categories list.
- Output URLs (M3U + EPG) are now available straight from the playlist editor via an
  "Output URLs" button, instead of only in Settings.
- Browser tab titles on every page.
- Source change log. Each sync now records which channels and categories the provider
  added or removed (and channels that returned after being gone), on a "Changes" page
  per source. The page is a full-width table with a selectable list of syncs (newest
  first, with +/- counts), loading one sync at a time so it scales to a long history.
  Each change shows which playlists it touched (channels added directly or via an
  auto-sync category), snapshotted at sync time so the record stays accurate even if a
  playlist is later renamed or deleted. The first sync of a source is a baseline (no
  per-channel spam), syncs with no changes add nothing, and it's not in backups.
- Auto-sync categories. From the Source Channels pane, a provider category's header
  has an "Auto-sync" action: name a playlist group and it mirrors that provider
  category 1:1, staying current on its own as the provider adds and removes channels
  (built for things like Pay Per View). The group is read-only (no per-channel edits)
  but you can rename it, reorder its position, and delete it. Its channels are derived
  live from the source, so there's nothing to re-sync; a provider sync just updates
  them, and the published M3U/EPG reflect it on the next poll.
- Backup and restore, in Settings. Backups are JSON files in `<CONFIG_PATH>/backups`
  (the folder is the source of truth, so dropping a `.json` in shows it in the UI).
  Each backup is a curated snapshot: your sources, category enable/disable, playlists,
  and only the channel rows your playlists use, not the whole synced catalog (so files
  are tiny). Back up on a schedule (`BACKUP_CRON`, daily 3am, keeping `BACKUP_KEEP`=14)
  or manually. Restore replaces all current data in one transaction and takes a safety
  backup first; run a sync afterwards to refill the channel browser. Backups can be
  downloaded, and restore is blocked for files from a different schema version.
- GitHub Actions CI (`.github/workflows/ci.yml`): runs typecheck and tests on every
  push and PR, then builds the Docker image, and pushes it to GHCR
  (`ghcr.io/scottrobertson/bouquet`, tagged `latest` + git sha) only on main.
- Mobile layout. The desktop design is untouched; the same components just respond
  to screen size. The sidebar becomes a hamburger drawer with a top bar, page
  padding and headers tighten and stack, tables scroll sideways, and the playlist
  editor (which can't show both panes side by side on a phone) gets a Source
  channels / Playlist tab switcher. No separate mobile markup.
- A Tools menu in the Action Bar (the floating bulk-actions bar) for transforms on
  the selected channels: add prefix, add suffix, find and replace (leave the
  replace box empty to just remove the text), and reset EPG (moved here from its
  own button). The menu is a small registry, so new tools are easy to add.
- When a channel's EPG is pointed at something other than its source default, the
  EPG icon is now orange (gray = default, red = none), and the picker pins that
  selected channel to the top under a "Selected" heading.
- Unit tests (Vitest) for the most critical pure logic: the M3U output builder
  (`buildM3u`) and the Xtream client's URL building and EPG channel parsing. Run
  with `npm test` (or `npm run test:watch`).

- Drag a playlist channel out onto the Source Channels pane to remove it from the
  playlist (with a "drop here to remove" overlay). Removed channels reappear in
  the source list.

### Changed

- The guide is now one continuous timeline you scroll through, rather than a window stuck on
  one day. It loads several days at once (three back, one forward), so scrolling across
  midnight is smooth with no jump or refetch. The ◀ ▶ buttons scroll back and forward by
  about a screen, the date label tracks the day you're looking at, "Now" jumps to the current
  time, and scrolling off either end quietly loads more. Catchup history reaches back the full
  seven days the guide keeps. Before, it only showed a rolling two-day window and switching
  days threw you a day away from what you wanted.
- The "Add to" picker in the source browser no longer has a "+ New category" option.
  You add channels to an existing category here; create categories with the dedicated
  add-category flow instead.
- The sidebar can now collapse to an icon rail on desktop, not just slide away on mobile.
  A toggle button in the sidebar shrinks it to icons only (with tooltips for each link) and
  the choice is remembered between visits. The mobile drawer opens and closes faster, and the
  desktop collapse button has a larger hit area.
- Backups are now a gzipped snapshot of the whole database instead of a JSON dump of
  selected tables. Restoring replaces everything and runs the database's migrations, so an
  older backup is upgraded to the current schema as part of the restore. This means a backup
  keeps working after an app update, where before any schema change made older backups
  un-restorable. A safety snapshot is still taken before each restore. A backup from a newer
  version than the running app is refused (update first). Old JSON backups can't be restored
  by the new code; take a fresh backup after upgrading.
- Source channels are added to the playlist from the action bar at the bottom of the
  pane ("Add to category" and "Add as alternate of…"), not by dragging. Tapping
  anywhere on a channel row toggles its checkbox. Dragging source channels into the
  playlist is gone: it only worked outside alt groups, which felt inconsistent.
- Replaced the `DATABASE_PATH` env var with `CONFIG_PATH`, a directory (default
  `./data`, `/data` in Docker) that holds the SQLite database and, soon, backups.
  The database now lives at `<CONFIG_PATH>/bouquet.db`.

### Fixed

- Guide programmes no longer draw on top of each other when a channel's EPG data has
  overlapping or duplicate entries. Each channel's lane is now made non-overlapping
  before it's rendered: overlapping programmes are trimmed back to where the next one
  starts, and duplicates or ones nested inside a longer programme are dropped.
- Renaming a playlist channel no longer flickers back to the old name for a frame
  before settling on the new one. The editor was resyncing its optimistic copy in an
  effect, leaving one stale frame; it now resyncs during render.
- The playlist action bar now stays on one line and uses the full width available,
  instead of wrapping into a tall blob. Its centering was capping it at about half
  the pane width.
- A new deploy no longer needs a manual cache clear. The HTML document was being
  cached without revalidation, so after a deploy it pointed at old hashed asset files
  that no longer existed and the page broke. The document and its data requests now
  send `Cache-Control: no-cache`; hashed assets stay immutable.
- Output URLs (the M3U/EPG links, and the `url-tvg` baked into the M3U) now come out
  `https` when the app runs behind a reverse proxy that terminates SSL, by trusting
  `X-Forwarded-Proto` / `X-Forwarded-Host`.
- The "Unavailable" / "Category off" badges on playlist rows now sit vertically
  centered on the right with the row's controls, instead of pinned to the title line.
- The playlist editor header no longer crowds on mobile: the Output URLs and Settings
  buttons drop their labels to icons on small screens.
- Playlist channel rows are less cramped on mobile: the drag grip and logo are hidden
  (the whole row is still the drag handle), gaps tighten, and the secondary per-row
  controls (EPG picker, revert-to-source-name) move to desktop only, leaving just the
  enable toggle and remove inline. Desktop is unchanged.
- Shift+click in the source channels list now selects a range, the same as the
  playlist side. The range spans the rows you can see, so collapsed groups aren't
  included.
- The EPG picker now shows which channel you're editing in a header above the search
  box, so you keep that context while searching.
- Renamed playlist channels now show a small pencil icon next to the name instead of
  a separate "renamed from" line. The original name is in the icon's tooltip.
- Toasts now confirm the playlist editor's batch actions (add group / add all, the
  Tools transforms, bulk enable/disable/move/remove/reset-EPG, auto-sync group
  created) and renaming a playlist, which previously only showed via the save status.
- Channel logos now load reliably when the app is served over HTTPS. Many provider
  logos are `http://` (or behind referer-based hotlink blocking), which a browser
  blocks on an HTTPS page. Logos in the UI now go through a small same-origin proxy
  (`/img?u=`) that fetches them server-side and serves them back over HTTPS. The
  output M3U still uses the provider's direct logo URLs, since players don't care.
- Reduced the left indent on source browser category and channel rows (28px to
  16px) so there's less wasted space, especially on mobile.
- Bigger touch targets on mobile in the source browser: source headers, category
  rows, and channel rows are taller, and the per-group "Add all" button is always
  visible on touch (it was hover-only, so unreachable on a phone).
- The bulk-actions bar no longer pushes the channel list down when you select a
  row. It now floats as a centered pill near the bottom of the playlist pane.
- Dragging a playlist channel that's part of a multi-selection now moves the whole
  selection as a block (keeping their order), not just the grabbed row. The drag
  preview shows a "+N" badge for the rest.
- Reordering a channel downward now lands it where you drop it instead of snapping
  back above the target. The insert math ignored drag direction; it now uses
  arrayMove so dropping on a lower row puts the channel after it.
- The blue insertion line now only shows when dragging in from the source list.
  When reordering an existing channel, dnd-kit already shifts the rows to show the
  gap, so the extra line was redundant and appeared on the wrong side.
- Releasing a dragged source channel outside the playlist now cancels instead of
  dropping it into the nearest category.
- A revert icon on renamed playlist channels (left of the EPG icon) that clears
  the custom name back to the source default. Tooltips on the revert and EPG icons.

### Fixed

- The inline rename field no longer makes the row taller while editing (sits
  inline at the same height with a subtle background and focus ring).
- Editing a playlist channel no longer flickers the Source Channels list. The
  source-channels and EPG endpoints opt out of automatic revalidation, so a
  rename/toggle/reorder no longer re-fetches and rebuilds the whole browser.
- EPG picker popover now opens and closes reliably (was wrapped in a tooltip that
  fought the popover), and only renders a capped, filtered slice of channels
  instead of all of them, so it no longer stutters with large EPG lists.
- Renaming a channel and pressing Enter or Space no longer grabs the row into a
  drag. Removed dnd-kit's keyboard sensor since the editor drag is pointer-only.
- The "renamed from" pencil no longer shows when the custom name matches the
  source name. Renaming a channel back to its source name now clears the rename.

## [1.0.0] - 2026-06-13

### Added

- Project scaffold: React Router 7 (framework mode, SSR), TypeScript, Tailwind v4,
  shadcn/ui, Drizzle ORM over SQLite, self-hosted fonts (Inter, JetBrains Mono).
- Dark, dense design system from the design guide (Linear/Vercel feel).
- Custom Express production server (`server.js`) that mounts the React Router
  handler and runs node-cron; auto-applies DB migrations on startup.
- Dockerfile (multi-stage, Debian-slim) and `docker-compose.yml`.
- Data model: sources, source_channels, source_epg_channels, playlists,
  playlist_categories, playlist_channels. Edits key off the Xtream `stream_id`
  so resync never disturbs them.
- Sources: add/edit Xtream providers with a test-connection action; channel
  catalog screen with search, category filter, and availability.
- Background sync: kicks off without blocking the request and the screen polls
  until done. Channels commit first; EPG is best-effort. Removed channels are
  kept and flagged unavailable. node-cron runs a scheduled resync.
- Playlists: list (table), create/rename/delete.
- Playlist editor: two-pane drag-and-drop. Drag a source channel (or a
  multi-selection) into a category to add it. Reorder channels within and across
  categories, reorder categories. Inline rename, logo override, enable toggle,
  source/provider label, unavailable badge, per-channel EPG picker (lazy-loaded),
  and a save-status indicator.
- Output: public token URLs `/output/m3u/:token` and `/output/epg/:token`. M3U is
  a valid `m3u_plus` with the provider's direct stream URLs; XMLTV is merged from
  the EPG sources actually used. In-memory cache with ETags and conditional GET.
- Source browser: grouped by category into collapsible sections, multi-select
  category filter, virtualized so thousands of channels stay smooth, and channels
  already in the playlist are hidden. Loads from its own lazy endpoint so editing
  the playlist does not reload it.
- Collapsible playlist categories with collapse-all / expand-all.
- Bulk add: "Add all" on a source group adds the whole group as a category;
  "Add all matching" adds everything matching the current filter. Both select
  server-side, so they cover the full set, not just rendered rows.
- Bulk edit: multi-select playlist channels (with shift-click range) for bulk
  enable, disable, move to category, reset EPG, and remove.
- Source detail shows an on/off breakdown for both Channels and Categories
  (green on, amber off) and a Saving / Saved indicator for category toggles.
- Per-source category enable/disable: a Categories tab on the source detail with
  toggles, enable/disable all, counts, and search. Disabled categories are hidden
  from the playlist browser, dropped from output, and flagged in the editor on
  already-added channels. State persists across resync. Output cache is
  invalidated on toggle so changes show immediately.
- `PLAN.md` (project overview) and this changelog.

### Changed

- Playlist channel rows redesigned: name on top with status badges, and a
  consistent metadata line below showing source, source category, and the
  original name when the channel has been renamed. EPG is now a color-coded icon
  (gray = set, red = missing) that opens the picker, instead of the long id. The
  delete button is always visible.
- Source Channels pane now shows all sources at once, no source picker. Channels
  group two levels deep (Source -> Category -> channels), both collapsible; the
  source level is hidden when there's only one source. Search and the category
  filter span every source, and "add all matching" adds across sources.
- Source browser categories now start collapsed; added Collapse all / Expand all
  and category/channel counts to match the playlist pane on the right.
- Channels are draggable from anywhere on the row (not just the grip icon), with
  grab cursors; interactive controls (checkbox, switch, EPG, remove) and the
  rename input no longer start a drag. Expand/collapse controls show pointer cursors.
- Made the selection checkbox consistent across both panes (always visible, and
  positioned after the grip icon).
- Channels and categories now follow the provider's order, not alphabetical, on
  both the source detail Categories screen and the playlist editor's Source
  Channels. Channels store a `position` captured at sync; categories order by
  their first channel. Works on existing data immediately; a sync makes channel
  positions exact and handles future provider reordering.
- Source detail page now shows only the Categories view. The Channels catalog
  table was removed (channels are managed in the playlist editor, not here).
- Editor loader slimmed down: the source browser and EPG list load from their own
  endpoints, so a playlist edit revalidates a small payload and feels instant.

### Fixed

- Migrations now run reliably on first DB load (dedicated "migrated" flag instead
  of reusing the connection cache).
- "Test connection" no longer clears the source form (runs through a fetcher).
- Source dropdown reflects `?source=` on a hard reload.
- Select dropdowns open reliably (switched to popper positioning).
- Suppressed browser autofill and 1Password overlays on tool inputs (password
  fields keep them).

### Dev notes

- `optimizeDeps.include` in `vite.config.ts` lists the heavy client deps so Vite
  does not re-optimize mid-session (which used to 504 an open tab).
- Adding or changing a DB migration requires restarting the dev server to apply it.
