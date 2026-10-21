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
    route("sources/:id/channels", "routes/sources.$id.channels.ts"),

    route("playlists", "routes/playlists._index.tsx"),
    route("playlists/:id", "routes/playlists.$id.tsx"),
    route("playlists/:id/guide", "routes/playlists.$id.guide.tsx"),
    route("playlists/:id/epg-channels", "routes/playlists.$id.epg-channels.tsx"),
    route(
      "playlists/:id/source-channels",
      "routes/playlists.$id.source-channels.tsx",
    ),
    route("playlists/:id/settings", "routes/playlists.$id.settings.tsx"),

    route("jobs", "routes/jobs.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
  // The Rust server answers everything that isn't a page: /api, the public
  // M3U and EPG output, the logo proxy, live updates and backup downloads.
] satisfies RouteConfig;
