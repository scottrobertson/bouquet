import type { ResolvedChannel } from "./queries.server";

// Strip double quotes so they can't break out of an EXTINF attribute.
function attr(value: string): string {
  return value.replace(/"/g, " ").trim();
}

export function buildM3u(rows: ResolvedChannel[], epgUrl: string): string {
  const lines: string[] = [`#EXTM3U url-tvg="${attr(epgUrl)}"`];

  for (const c of rows) {
    const name = attr(c.displayName);
    // xc tells the player to build the timeshift URL from the stream URL itself.
    // A catchup-source template can't work everywhere: TiviMate leaves some of
    // its placeholders unfilled and fills times in UTC when panels expect their
    // own timezone, so every request 404'd.
    const catchup =
      c.catchupDays > 0
        ? ` catchup="xc" catchup-days="${c.catchupDays}"`
        : "";
    lines.push(
      `#EXTINF:-1 tvg-id="${attr(c.tvgId)}" tvg-name="${name}" tvg-logo="${attr(
        c.logo,
      )}" group-title="${attr(c.groupTitle)}"${catchup},${name}`,
    );
    lines.push(c.streamUrl);
  }

  return lines.join("\n") + "\n";
}
