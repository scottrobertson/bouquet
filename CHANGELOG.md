# Changelog

All notable changes to this project are recorded here. Newest first.

## [Unreleased]

### Added

- Hovering the "Probing 166…" button in the playlist header now lists the channels the probe is
  working through, the ones on a stream right now at the top and the rest waiting below. The count on
  its own told you a probe was running but not how far along it was or whether it was stuck on
  something, and you had to hunt through the playlist for the rows marked "Probing…" to find out.

- Adding a channel to a playlist now probes it straight away, as long as its source has probing
  turned on. Before this you added a stream and had nothing to judge it by until the next scheduled
  probe came round, which could be a day later. Only streams with no probe result yet are picked up,
  so adding one you've already probed elsewhere doesn't open another connection to the provider, and
  a burst of adds is collected into a single run rather than one per channel. This covers the source
  browser, adding a whole group, adding everything matching a search, and adding alternates.

- When there's exactly one group the channels you picked could belong to, the source pane offers it
  as a button, so grouping an alternate is one click with no popover to open. The button says which
  group and why it matched ("Same EPG id", "Same name"), and the picker sits next to it as "Pick
  another…" for when the guess is wrong.

- Both alternate pickers now suggest the group a channel belongs in, so you don't have to type the
  name out every time. Pick some channels, open "Add as alternate of…" or "Make alternate of…", and
  the likely groups sit at the top under "Suggested", with the best one already highlighted so Enter
  takes it. A suggestion comes from the provider's EPG id matching, or from the names matching once
  the noise is stripped off, so "UK: Sky Sports Main Event FHD2" finds "Sky Sports Main Event" and
  "UK: ITV1" finds "ITV 1". Channels that only look alike are kept apart: TNT Sports 1 is not TNT
  Sports 2, Sky Sports Cricket is not Sky Sports Golf, a "+1" is not its parent channel, and US: TNT
  is not BRA: TNT. When nothing fits, nothing is suggested and you get the plain list as before.

- The playlist editor has a filter box over the playlist itself. Until now the only way to find a
  channel you'd already added was to scroll, which on a big playlist means thousands of pixels. It
  matches on the channel's name, the name it had at the source, the provider and the source
  category, so "uhd/4k" or a provider name works as well as a channel name. A group whose alternate
  matched opens up so you can see the row you searched for. Dragging is off while the filter is on,
  since the rows in between are hidden and a drop would land somewhere you didn't point at.

- The source browser can now be driven from the keyboard. Press "/" anywhere to jump to the search
  box, arrow up and down to walk the results, and Enter to add the highlighted channel to the target
  category. Escape clears the box. So a channel can go from search to playlist without touching the
  mouse.

- Searching the source browser now says when the matches are already in your playlist. The browser
  hides channels the playlist already covers, so a search for one of them used to come back "no
  channels match", which reads as "this channel doesn't exist". It now says how many are already
  there and offers to search the playlist for them.

- The playlist editor now shows which alt groups smart sort would reorder, so you don't have to open
  the preview on each one to find out. A group that's out of order gets a sparkle next to its "N
  alts" badge; click it to go straight to the preview. The playlist header shows how many groups are
  affected, and clicking that count filters the list down to just those so you can work through them.
  As probes land and the picture changes, the count updates on its own.

- Sync now deletes channels the provider has removed, as long as no playlist uses them. Providers
  that "rename" channels actually delete and recreate them under new stream IDs, which left the old
  names sitting in the source browser as unavailable forever. Channels that are in a playlist are
  still kept and shown as unavailable, so your edits survive a provider hiccup and you can repoint
  them if the channel is gone for good.

- Sources can now be disabled without deleting them. A disabled source drops out of every playlist's
  output and the scheduler skips its sync and probe, but nothing is deleted, so enabling it again
  brings the channels back exactly as they were. Toggle it from the source's menu on the Sources
  list or the Disable button on the source page. Its channels still show in the playlist editor,
  marked "Source off", so they're never hidden from you or removed silently.
- Playlists can now upload their M3U and EPG to external storage, so a player can point at those
  files instead of at Bouquet directly. Add one or more destinations in playlist Settings: S3 (and
  S3-compatible stores like R2, MinIO, Backblaze B2, Spaces, Wasabi and Storj via a custom endpoint)
  or a local folder on the server. Set a destination's public URL base and the uploaded M3U's guide
  link points at the uploaded EPG, so the uploaded playlist is self-contained. Uploads run when you
  click Upload on a destination and automatically after a source syncs; a sync touching several
  sources at once still uploads once.
- Channels that keep failing their probe are now turned off automatically. Each playlist has an
  "Auto-disable failing channels" setting (default 3, 0 turns it off) that disables a channel once
  its stream fails that many probes in a row. A good probe resets the streak, and re-enabling a
  channel gives it a fresh start. If the failing channel is the primary of an alt group, a working
  alternate is promoted first so the group keeps playing. Auto-disabled channels show an
  "Auto-disabled" badge in the editor so you can tell them apart from ones you turned off yourself.
  Recovery is automatic: scheduled probes keep checking auto-disabled channels, and any probe that
  finds one working again turns it back on. The probe menu also has a "Probe auto-disabled" option
  to re-check them on demand.
- The playlist channel list now shows why a probe failed instead of just "Probe failed". The
  reason (e.g. "Black screen" or "No video stream found") shows on the channel's quality line,
  with the full message on hover.
- Probing can now catch black-screen channels. ffprobe only reads stream metadata, so a dead
  channel with a valid video track but a black picture used to probe fine. Probing now decodes a
  few seconds of each stream and marks it failed if the picture is all black. It's a toggle in the
  source's probe settings, on by default. Off if you'd rather skip the extra decode.
- A channel's logo now follows its EPG. When you pick an EPG channel other than the source
  default, the logo comes from that EPG channel, so picking a guide from a provider with a nicer
  logo gives you that logo too. Channels left on their source default keep the source's own logo,
  and a manually set logo still wins over both. The editor preview shows the same logo the
  playlist will emit, and the EPG picker shows each channel's logo next to it so you can see what
  you'll get before you pick.
- The EPG picker now lists the alt group's guides at the top under "Alternatives" when you're
  picking a guide for an alt group primary. Each alternate is the same channel from another
  provider, so its own source EPG is usually the guide you want, and now it's one click away
  instead of buried in the full list. The picker also opens as a centred dialog now rather than
  a cramped popover, and the rest of the channels are a single list with the source shown on
  each row instead of grouped under a source heading, so you don't lose track of the source
  once you scroll.
- Alt groups now have a "Smart sort" option in their ⋯ menu that reorders the group best-first from
  probe data and promotes the best stream to primary. It ranks by resolution then frame rate then
  bitrate, with bitrate compared per codec so HEVC isn't punished for needing fewer bits, audio
  codec breaking near-ties (surround over stereo), and streams sunk to the bottom in the order
  unprobed, then failed, then unavailable, then auto-disabled last.
  The group's name and guide stay put, so only the running order changes. Since it can change which
  stream is primary, it opens a preview first: the proposed order with each stream's data, how far
  each moves, a note when the primary changes, the old primary marked "Was primary" when it's
  demoted, and the rules used, with nothing applied until you confirm. Playlist settings has a "Smart sort" section to pick whether to rank by resolution or
  bitrate first and to toggle the audio and working-streams-first rules.
- The "Probe all" button now has a dropdown with "Probe missing" and "Probe failed", each showing
  a count, plus "Clear probes" to wipe all results for the playlist's channels. Missing probes
  channels never probed before, failed probes ones whose last probe errored or timed out. "Probe
  all" still works as a single click. While a probe is running the button shows how many channels
  are still being probed ("Probing 12…") and the dropdown is hidden.
- Categories now have a ⋯ menu in their header with a "Probe category" option that probes just
  that category's channels. Delete moved into the same menu. Auto categories only show delete,
  since they have no channels of their own to probe.

### Changed

- The editor's "Probe all" button is now "Probe enabled", because it never probed everything. It
  skips channels you've switched off and channels that were auto-disabled, which is why "Probe
  auto-disabled" sits under it as its own action. The tooltip says so now too.

- Searching the source browser now shows the channels it found instead of a list of closed groups.
  A search for "sky sports" used to come back as four collapsed category names and no channel, so
  every search needed an "Expand all" click before you could see anything. Groups still start closed
  when you're browsing with no search, where they keep a long list scannable.

- The playlist side of the editor now only renders the rows you can see, the way the source browser
  already did. On a 1,200 channel playlist it was building every row up front: 44,000 elements, and
  every click had to re-render all of them, so ticking a checkbox froze the page for about 300ms and
  selecting ten channels took three seconds. Now a click lands in under 10ms, the page loads in a
  fifth of the time, and it stays that way however big the playlist gets. Category headers still stick
  to the top as you scroll, and drag, multi-select and shift+click all work across the whole list, not
  just the part on screen.

- Disabled sources now sit at the bottom of the playlist editor's source browser and start
  collapsed, with a "Source off" badge on the group. Their channels are still there if you want
  them, they're just out of the way of the sources you're actually using. "Expand all" opens them
  along with everything else.
- Channels that can't reach output are now greyed out in the playlist editor, whatever the reason:
  source disabled, dropped by the provider, or in a disabled source category. Before only manually
  or auto-disabled channels dimmed, so a "Source off" row looked active when it wasn't.
- Smart sort now treats a channel from a disabled source like an unavailable one: it sinks below
  working, unprobed, failed and unavailable streams (staying above auto-disabled) and can't be
  picked as the group's primary. The preview shows a "Source off" badge on those streams.
- Scheduled sync, probe, and backup now run by calling the service functions directly in-process,
  instead of the cron job making an HTTP call to internal `/internal/*` routes. Those routes are
  removed. No config change: the same `SYNC_CRON`/`PROBE_CRON`/`BACKUP_CRON` env vars still control
  timing. A tick is now skipped if the previous run of that job is still going.
- The "Revert name" action moved off the channel row into the ⋯ menu, so it's no longer a separate
  icon button and now works on mobile too.
- Sync now logs more detail: how long the catalog fetch took with category and stream counts, how
  many channels were added or removed since the last sync, how many channels the EPG step is
  fetching, and how long EPG took (with a failure count when any fail).
- "Probe all" and "Probe group" now probe channels in the order they appear in the playlist
  instead of jumping around. Within each source the probe works down the list. Channels from
  different sources still run in parallel, so a multi-source playlist isn't strictly top to
  bottom, but each source follows the editor's order.
- On mobile the playlist header actions (Output URLs, Probe, Guide, Settings) were icon-only, so
  you couldn't tell what they did. They now collapse into a single ⋯ menu with labelled rows.
  Desktop still shows each as its own labelled button.


- Sync and probe progress now updates instantly instead of on a timer. The sources list, a
  source's page, and the playlist editor open a live connection while a sync or probe is running
  and refresh the moment something changes, so badges, counts and channel rows update as soon as
  the server has news rather than every 1.5 to 2.5 seconds. A slow refresh still runs as a
  backstop in case the live connection can't get through.

- Renaming channels on mobile no longer zooms the page. The app now disables pinch and
  double-tap zoom so it feels like a native app, and the rename field uses a bigger, easier to
  tap text box on phones. Desktop is unchanged.

- Making a different channel the primary of an alternate group now keeps the group's custom
  name. Before, promoting an alternate reset the name back to the channel's own. From the
  editor it's just picking a different primary, so the group's name and details stay put. The
  ⋯ menu also says "Make primary" instead of "Move up" when the alternate is next in line for
  the primary spot.
- Tidied the probe options in a channel's ⋯ menu: "Probe group" now sits above the single
  channel option, which is now just labelled "Probe".

- Probing now shows live in the playlist editor instead of going quiet until it finishes.
  Probe a single channel and its row shows a spinner straight away. Probe a group or the whole
  playlist and every channel flips to "Queued…" at once, then to "Probing…" as each stream is
  actually checked, then to its result. The header shows a running count of how many are left,
  and the editor polls a bit faster so results land sooner.

- Upgraded React Router from 7 to 8, plus the rest of the npm dependencies to their latest
  versions. The v8 future flags were already on, so this was mostly a version bump. The only
  code change was renaming the `meta` function's `data` argument to `loaderData`.
- Moved the per-channel enable/disable toggle off the row and into its ⋯ menu, to declutter
  the row. The bulk Enable/Disable in the Tools menu is unchanged.
- Disabled channels are now dimmed in the playlist editor. The logo and name fade out so you
  can scan the list and see what's off.
- Disabling the primary of an alternate group now takes the whole group out of output. An
  alternate borrows its name and guide from the primary, so emitting backups without their
  primary left orphaned channels. Each alternate keeps its own on/off state, so re-enabling
  the primary brings them back as they were. The group's alternates dim in the editor too.

### Fixed

- Pressing Enter in the source search box no longer adds every channel matching what you typed.
  Enter was meant to add the channel you'd walked to with the arrow keys, but with no arrow key
  cursor it fell through to the same thing as the "Add all" button, so finishing a search with Enter
  out of habit dumped hundreds of channels into your playlist. It now only adds the channel under
  the cursor, or the ones you've ticked. Adding everything matching a search still needs the button.

- The smart sort hint on a group no longer appears while any of the group's channels are queued or
  being probed. A channel waiting on a probe counts as never-probed for ranking, so during a probe
  run groups lit up saying they needed sorting, and once the results landed the suggestion went away
  again. It also fed the "needs sorting" count and filter in the toolbar. Groups stay quiet now until
  their probes finish.

- A channel that fails its probe no longer keeps the resolution, frame rate, codec and bitrate the
  probe read. Every failure used to clear them except a black screen, which ffprobe reads like any
  working stream, so a dead channel kept a full set of numbers. Smart sort then ranked it on them and
  offered a dead 4K stream as a group's new primary, while the preview said "No probe data" for the
  same stream. The numbers are cleared when a channel is next probed, so probe the affected channels
  again to clear the ones already stored. "Probe enabled" skips auto-disabled channels, so use
  "Probe auto-disabled" for those.

- Cancelling a drag in the playlist editor no longer leaves the "Drop here to remove" overlay
  covering the source browser until you drag something else.

- Searching the source browser no longer eats what you type. The box waits for a pause in typing
  before it searches, and when the results landed it put the older text back in the box, so typing
  slowly lost the last letters. It also reloaded the entire playlist from the server every time the
  search changed, which is what made the editor feel laggy. The browser's own results are the only
  thing that reloads now.

- Fixed the Docker image failing to build. The dependency update to better-sqlite3 v13 hit an
  upstream packaging bug (WiseLibs/better-sqlite3#1503) where installs always compile from source
  instead of using the bundled prebuilt binaries, and the slim image has no compiler or Python.
  Pinned back to v12, which uses its prebuilt binary, and told Dependabot to skip the v13 major
  until the bug is fixed.

- Catchup now works in TiviMate. The M3U used to hand players a catchup-source URL template,
  but TiviMate leaves some of its placeholders unfilled and fills times in UTC when panels
  expect their own timezone, so every catchup request 404'd. Channels with an archive now emit
  `catchup="xc"` instead, which tells the player to build the timeshift URL from the stream URL
  itself, and TiviMate builds exactly the URL the panel expects. The in-app guide still uses
  the template internally, with its duration token fixed to minutes (`{duration:60}`), which is
  what the timeshift endpoint reads.

- Measured bitrate is now more accurate. It used to divide the bytes read by the full read-time
  window even when the stream delivered less than that (slow, stalled, or killed early), which read
  low. It now divides by the duration ffmpeg actually muxed, so the number is right however long the
  read ran.

- The playlist editor's "Probing N…" button could get stuck showing a leftover count (often 1)
  until you hard refreshed. The live updates were switched off the moment the source finished, but
  that happens a beat before the last channel rows do, so the count could be left stale with nothing
  polling to clear it. It now keeps listening until the count itself reaches zero.

- The ⋯ menu on category headers and alt groups was hard to tap on mobile. The icon stays the
  same size but the tap target is now bigger so it's easy to hit.

- The playlist editor no longer logs a React hydration warning in the console. The drag-and-drop
  library generates accessibility ids off an internal counter that lands on different numbers on
  the server and the browser, so the markup didn't match on load. Giving the editor's drag context
  a fixed id makes it match.

- Sync errors now say what actually went wrong with the provider connection instead of just
  "fetch failed". A failed request now reports the real cause, like "Connection failed
  (ECONNRESET)" or "Request timed out after 30s", which makes provider problems much easier to
  diagnose from the logs and the source's error.

- A sync or probe that was running when the container restarted no longer leaves the source
  stuck "syncing"/"probing" forever. Those runs only live in memory, so on startup any source
  still marked in-progress is cleared to an error, which unsticks the UI and the "Probe all"
  button.

### Added

- A discreet GitHub link at the bottom of the sidebar, pointing at the project repo. It
  shows in both the desktop sidebar and the mobile drawer, and collapses to just the icon
  on the icon rail.
- Server logging for scheduled syncs. Each sync now logs when it starts, the channel count,
  the EPG result, and how long it took, plus a line at the top of each cron tick saying how
  many sources were due. Probe ticks log the due count too, matching the existing per-channel
  probe logs.
- "Play in VLC" and "Copy stream URL" in each channel's ⋯ menu, in both the playlist editor
  and the guide. Play in VLC opens the provider's direct stream via the `vlc://` handler;
  Copy stream URL puts the same URL on the clipboard for pasting into a player.
- "Play catchup in VLC" and "Copy catchup URL" on a past programme in the guide, when its
  channel keeps an archive and the programme aired within that window. Click the programme to
  open its details and the two actions appear, built from that programme's start time and length.
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

- The guide now decides catchup from each channel's own archive window rather than the
  provider's per-programme archive flag. A past programme shows the catchup icon and replay
  actions whenever the channel keeps an archive and the programme aired within that window.
  Before, the flag came from the shared EPG, so an alternate could show catchup on its
  channel but never on any programme (or, on the wrong feed, show it when its own stream had
  no archive). Now it matches each channel's real stream, including alternates.
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

- Catchup URLs from the guide had the wrong start time, off by your timezone's offset from
  UTC. The provider's timeshift endpoint wants the start as local wall-clock time, the same
  time the guide shows, so the URL now uses that instead of UTC.
- Alternate channels no longer show a catchup icon on their programmes when the alternate's
  own stream has no archive. The icon followed the shared EPG, but an alternate keeps its
  own catchup, so it now only shows when this channel can actually replay the programme.
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
