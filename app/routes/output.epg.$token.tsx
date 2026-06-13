import { getOrBuild } from "~/services/output/cache.server";
import { getPlaylistOutput } from "~/services/output/queries.server";
import { buildXmltv } from "~/services/output/xmltv.server";
import type { Route } from "./+types/output.epg.$token";

// Strip anything that would be unsafe in a Content-Disposition filename.
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "playlist";
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const output = await getPlaylistOutput(params.token);
  if (!output) return new Response("not found", { status: 404 });

  const { body, etag } = await getOrBuild(
    `epg:${params.token}`,
    60 * 60_000,
    async () => buildXmltv(output.channels),
  );
  const quotedEtag = `"${etag}"`;

  if (request.headers.get("If-None-Match") === quotedEtag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: quotedEtag, "Cache-Control": "public, max-age=1800" },
    });
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      ETag: quotedEtag,
      "Cache-Control": "public, max-age=1800",
      "Content-Disposition": `inline; filename="${safeFilename(
        output.playlist.name,
      )}.xml"`,
    },
  });
}
