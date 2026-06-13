import { buildM3u } from "~/services/output/m3u.server";
import { getOrBuild } from "~/services/output/cache.server";
import { getPlaylistOutput } from "~/services/output/queries.server";
import type { Route } from "./+types/output.m3u.$token";

// Strip anything that would be unsafe in a Content-Disposition filename.
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "playlist";
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const output = await getPlaylistOutput(params.token);
  if (!output) return new Response("not found", { status: 404 });

  const origin = new URL(request.url).origin;
  const epgUrl = `${origin}/output/epg/${params.token}`;

  const { body, etag } = await getOrBuild(
    `m3u:${params.token}`,
    60_000,
    async () => buildM3u(output.channels, epgUrl),
  );
  const quotedEtag = `"${etag}"`;

  if (request.headers.get("If-None-Match") === quotedEtag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: quotedEtag, "Cache-Control": "public, max-age=60" },
    });
  }

  return new Response(body, {
    headers: {
      "Content-Type": "audio/x-mpegurl; charset=utf-8",
      ETag: quotedEtag,
      "Cache-Control": "public, max-age=60",
      "Content-Disposition": `inline; filename="${safeFilename(
        output.playlist.name,
      )}.m3u"`,
    },
  });
}
