# Changelog

All notable changes to this project are recorded here. Newest first.

## [Unreleased]

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
