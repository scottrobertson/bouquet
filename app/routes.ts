import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),

  layout("routes/_app.tsx", [
    route("sources", "routes/sources._index.tsx"),
    route("sources/new", "routes/sources.new.tsx"),
    route("sources/:id", "routes/sources.$id.tsx"),
    route("sources/:id/edit", "routes/sources.$id.edit.tsx"),
    route("sources/:id/changes", "routes/sources.$id.changes.tsx"),

    route("playlists", "routes/playlists._index.tsx"),
    route("playlists/:id", "routes/playlists.$id.tsx"),
    route("playlists/:id/epg-channels", "routes/playlists.$id.epg-channels.tsx"),
    route(
      "playlists/:id/source-channels",
      "routes/playlists.$id.source-channels.tsx",
    ),
    route("playlists/:id/settings", "routes/playlists.$id.settings.tsx"),

    route("settings", "routes/settings.tsx"),
    route("settings/backup/:file", "routes/settings.backup.$file.tsx"),
  ]),

  // Proxies remote channel logos through our origin (see routes/img.tsx).
  route("img", "routes/img.tsx"),

  // Public, no layout. Hit by IPTV players and the cron job.
  route("internal/sync", "routes/internal.sync.tsx"),
  route("internal/backup", "routes/internal.backup.tsx"),
  route("output/m3u/:token", "routes/output.m3u.$token.tsx"),
  route("output/epg/:token", "routes/output.epg.$token.tsx"),
] satisfies RouteConfig;
